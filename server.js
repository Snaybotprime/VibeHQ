// Project Dashboard server — serves built dist/ and exposes JSON APIs
// for project scan, git/port/process/bot status, and Claude usage.
// Binds to 127.0.0.1 only.
import express from "express";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;
const DIST_DIR = path.join(__dirname, "dist");
const PORT = Number(process.env.PORT ?? 4321);
const SECRETS_FILE = path.join(__dirname, ".access-passwords.json");

// Claude Code usage tracking — reads ~/.claude/projects/*/*.jsonl
// Budgets are tunable via env (token counts).
const CLAUDE_PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const CLAUDE_DAILY_BUDGET = Number(process.env.CLAUDE_DAILY_BUDGET ?? 100_000_000);
const CLAUDE_WEEKLY_BUDGET = Number(process.env.CLAUDE_WEEKLY_BUDGET ?? 500_000_000);
const CLAUDE_MONTHLY_BUDGET = Number(process.env.CLAUDE_MONTHLY_BUDGET ?? 2_000_000_000);

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/i;

const app = express();
app.use(express.json({ limit: "64kb" }));

// CORS — allow the desktop app's renderer (dev :5173, built :* via file://)
// and other local tools to read projects. Keep it to local origins only.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = new Set([
    "http://localhost:4321",
    "http://127.0.0.1:4321",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4322",
    "http://127.0.0.1:4322",
  ]);
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ---------------------------------------------------------------
// Claude Code usage — aggregates tokens from ~/.claude/projects/
// ---------------------------------------------------------------
async function aggregateClaudeUsage(dayStart, weekStart, monthStart, dayEnd, weekEnd, monthEnd) {
  let today = 0, week = 0, month = 0;
  let dirs;
  try {
    dirs = await fs.readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { today, week, month };
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(CLAUDE_PROJECTS_DIR, d.name);
    let files;
    try {
      files = await fs.readdir(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      let content;
      try {
        content = await fs.readFile(path.join(projDir, f), "utf8");
      } catch {
        continue;
      }
      let start = 0;
      while (start < content.length) {
        const nl = content.indexOf("\n", start);
        const line = nl === -1 ? content.slice(start) : content.slice(start, nl);
        start = nl === -1 ? content.length : nl + 1;
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const u =
          entry.message && typeof entry.message === "object"
            ? entry.message.usage
            : null;
        if (!u) continue;
        const tokens =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        if (!tokens) continue;
        const t = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(t)) continue;
        if (t >= dayStart && t < dayEnd) today += tokens;
        if (t >= weekStart && t < weekEnd) week += tokens;
        if (t >= monthStart && t < monthEnd) month += tokens;
      }
    }
  }
  return { today, week, month };
}

app.get("/api/claude-usage", async (_req, res) => {
  try {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayEnd = dayStart + 24 * 3600 * 1000;
    // Week starts Monday 00:00 local (ISO week convention).
    const mondayOffsetDays = (now.getDay() + 6) % 7;
    const weekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - mondayOffsetDays,
    ).getTime();
    const weekEnd = weekStart + 7 * 24 * 3600 * 1000;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();

    const { today, week, month } = await aggregateClaudeUsage(
      dayStart, weekStart, monthStart, dayEnd, weekEnd, monthEnd,
    );

    const nowMs = now.getTime();
    const bucket = (used, budget, start, end) => {
      const total = end - start;
      const elapsed = Math.max(0, Math.min(total, nowMs - start));
      const elapsedPct = total > 0 ? (elapsed / total) * 100 : 0;
      const usedPct = budget > 0 ? (used / budget) * 100 : 0;
      return { used, budget, usedPct, elapsedPct, pacePct: usedPct - elapsedPct };
    };

    res.json({
      daily: bucket(today, CLAUDE_DAILY_BUDGET, dayStart, dayEnd),
      weekly: bucket(week, CLAUDE_WEEKLY_BUDGET, weekStart, weekEnd),
      monthly: bucket(month, CLAUDE_MONTHLY_BUDGET, monthStart, monthEnd),
      updatedAt: now.toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// -----------------------------------------------------------------
// Access-gate passwords (shared secrets for Cloudflare Access etc.)
// Stored in a local chmod-600 JSON file. Never bundled into dist.
// -----------------------------------------------------------------

const SLUG_ID_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/i;

async function readSecrets() {
  try {
    const raw = await fs.readFile(SECRETS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSecrets(data) {
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(SECRETS_FILE, json, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(SECRETS_FILE, 0o600);
  } catch {
    /* best-effort */
  }
}

app.get("/api/access-passwords", async (_req, res) => {
  try {
    const data = await readSecrets();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

app.put("/api/access-password", async (req, res) => {
  try {
    const { projectId, password, label, note } = req.body ?? {};
    if (typeof projectId !== "string" || !SLUG_ID_RE.test(projectId)) {
      return res.status(400).json({ error: "Valid projectId required" });
    }
    if (typeof password !== "string") {
      return res.status(400).json({ error: "password must be a string" });
    }
    const data = await readSecrets();
    if (password === "") {
      delete data[projectId];
    } else {
      data[projectId] = {
        password,
        label: typeof label === "string" ? label.slice(0, 80) : null,
        note: typeof note === "string" ? note.slice(0, 240) : null,
        updatedAt: new Date().toISOString(),
      };
    }
    await writeSecrets(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// -----------------------------------------------------------------
// Project scanner — walks $HOME for project folders
// -----------------------------------------------------------------

const SKIP_TOP = new Set([
  "Applications",
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "gsf_data",
  "scraper-env",
  // Grouping dirs — their children are scanned separately below.
  "projects",
  "code",
  "src",
]);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPkg(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readGitRemote(dir) {
  try {
    const cfg = await fs.readFile(path.join(dir, ".git", "config"), "utf8");
    const m = cfg.match(/url\s*=\s*(\S+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------
// Python bot discovery — walk a project tree for bot-shaped .py files
// -----------------------------------------------------------------

const BOT_SCAN_MAX_DEPTH = 3;
const BOT_SCAN_SKIP_DIRS = new Set([
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
  "node_modules",
  ".git",
  "build",
  "dist",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "migrations",
]);
const BOT_SKIP_NAMES = new Set([
  "__init__.py",
  "__main__.py",
  "setup.py",
  "conftest.py",
]);

function isBotCandidate(name) {
  if (!name.endsWith(".py")) return false;
  if (BOT_SKIP_NAMES.has(name)) return false;
  if (name.startsWith("test_") || name.endsWith("_test.py")) return false;
  return true;
}

async function scanPythonBots(rootDir) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > BOT_SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (BOT_SCAN_SKIP_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && isBotCandidate(e.name)) {
        found.push({
          id: botId(full),
          name: e.name.replace(/\.py$/, ""),
          path: full,
          relativePath: path.relative(rootDir, full),
        });
      }
    }
  }
  await walk(rootDir, 0);
  found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return found;
}

function botId(absPath) {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 16);
}

async function detectProject(dir, id) {
  const pkg = await readPkg(dir);
  const hasPy = await exists(path.join(dir, "pyproject.toml"));
  const hasGo = await exists(path.join(dir, "go.mod"));
  const hasCargo = await exists(path.join(dir, "Cargo.toml"));
  const hasHtml = await exists(path.join(dir, "index.html"));
  const hasReqs = await exists(path.join(dir, "requirements.txt"));
  const hasVenv =
    (await exists(path.join(dir, "venv"))) ||
    (await exists(path.join(dir, ".venv")));

  const hasAnyMarker =
    pkg || hasPy || hasGo || hasCargo || hasHtml || hasReqs || hasVenv;

  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };

  let stack = "Unknown";
  let devCommand = "—";
  let localPort = null;

  if (deps.next) {
    stack = "Next.js";
    devCommand = pkg?.scripts?.dev ?? "npm run dev";
    localPort = 3000;
  } else if (deps.vite) {
    stack = "Vite · React";
    devCommand = pkg?.scripts?.dev ?? "npm run dev";
    localPort = 5173;
  } else if (deps["react-scripts"]) {
    stack = "Create React App";
    devCommand = pkg?.scripts?.start ?? "npm start";
    localPort = 3000;
  } else if (deps.express || deps.fastify || deps.koa) {
    stack = "Node · Server";
    devCommand = pkg?.scripts?.dev ?? pkg?.scripts?.start ?? "node index.js";
  } else if (pkg) {
    stack = "Node.js";
    devCommand = pkg?.scripts?.dev ?? pkg?.scripts?.start ?? "npm start";
  } else if (hasPy || hasReqs || hasVenv) {
    stack = "Python";
    devCommand = "python main.py";
  } else if (hasGo) {
    stack = "Go";
    devCommand = "go run .";
  } else if (hasCargo) {
    stack = "Rust";
    devCommand = "cargo run";
  } else if (hasHtml) {
    stack = "Static HTML";
    devCommand = "npx serve .";
    localPort = 3000;
  }

  const gitRemote = await readGitRemote(dir);

  const tags = [];
  let processCheck = null;
  if (hasPy || hasReqs || hasVenv) {
    tags.push("python");
    processCheck = {
      kind: "pgrep",
      pattern: path.basename(dir),
      label: `pgrep ${path.basename(dir)}`,
    };
  }

  const bots = await scanPythonBots(dir);

  return {
    id,
    name: pkg?.name ?? path.basename(dir),
    dir,
    stack,
    description: pkg?.description ?? "",
    devCommand,
    localPort,
    gitRemote,
    status: "active",
    tags,
    processCheck,
    bots,
    scanned: true,
  };
}

app.get("/api/scan-projects", async (_req, res) => {
  try {
    const projects = [];
    const seen = new Set();

    const entries = await fs.readdir(HOME, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (SKIP_TOP.has(e.name)) continue;
      const dir = path.join(HOME, e.name);
      const project = await detectProject(dir, e.name);
      if (project) {
        projects.push(project);
        seen.add(dir);
      }
    }

    // one level deeper for common grouping dirs
    for (const group of ["projects", "code", "src"]) {
      const groupDir = path.join(HOME, group);
      try {
        const subs = await fs.readdir(groupDir, { withFileTypes: true });
        for (const s of subs) {
          if (!s.isDirectory() || s.name.startsWith(".")) continue;
          const dir = path.join(groupDir, s.name);
          if (seen.has(dir)) continue;
          const project = await detectProject(dir, `${group}/${s.name}`);
          if (project) {
            projects.push(project);
            seen.add(dir);
          }
        }
      } catch {
        /* group dir missing */
      }
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ projects, scannedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// -----------------------------------------------------------------
// Python bot control — start/stop/status
// -----------------------------------------------------------------

const BOT_STATE_DIR = "/tmp/projectdashboard-bots";
try { fsSync.mkdirSync(BOT_STATE_DIR, { recursive: true }); } catch {}

function botPidFile(id) { return path.join(BOT_STATE_DIR, `${id}.pid`); }
function botLogFile(id) { return path.join(BOT_STATE_DIR, `${id}.log`); }

function assertUnderHome(resolved) {
  return resolved === HOME || resolved.startsWith(HOME + path.sep);
}

async function resolveBotScript(botPath) {
  if (typeof botPath !== "string" || !botPath) {
    throw new Error("path required");
  }
  const resolved = path.resolve(botPath);
  if (!assertUnderHome(resolved)) throw new Error("path must be inside $HOME");
  if (!resolved.endsWith(".py")) throw new Error("path must end in .py");
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error("not a file");
  return resolved;
}

async function pickPython(scriptPath) {
  let dir = path.dirname(scriptPath);
  while (dir.startsWith(HOME) && dir.length >= HOME.length) {
    for (const candidate of ["venv/bin/python", ".venv/bin/python"]) {
      const p = path.join(dir, candidate);
      if (await exists(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "python3";
}

async function readPid(id) {
  try {
    const raw = await fs.readFile(botPidFile(id), "utf8");
    const pid = Number(raw.trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function botStatus(id) {
  const pid = await readPid(id);
  if (pid == null) return { running: false };
  if (isAlive(pid)) return { running: true, pid };
  // stale pidfile
  await fs.unlink(botPidFile(id)).catch(() => {});
  return { running: false };
}

app.post("/api/bot-status", async (req, res) => {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: "ids[] required" });
    const results = {};
    for (const id of ids) {
      if (typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id)) continue;
      results[id] = await botStatus(id);
    }
    res.json({ results, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

app.post("/api/bot/start", async (req, res) => {
  try {
    const { path: botPath } = req.body ?? {};
    const resolved = await resolveBotScript(botPath);
    const id = botId(resolved);
    const existing = await botStatus(id);
    if (existing.running) {
      return res.json({ ok: true, id, running: true, pid: existing.pid, alreadyRunning: true });
    }
    const python = await pickPython(resolved);
    const cwd = path.dirname(resolved);
    const logFd = fsSync.openSync(botLogFile(id), "a");
    fsSync.writeSync(logFd, `\n--- ${new Date().toISOString()} starting ${resolved} with ${python} ---\n`);
    const child = spawn(python, ["-u", resolved], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    child.on("error", (err) => console.error("bot spawn error", err));
    child.unref();
    fsSync.closeSync(logFd);
    await fs.writeFile(botPidFile(id), String(child.pid));
    res.json({ ok: true, id, running: true, pid: child.pid });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

app.post("/api/bot/stop", async (req, res) => {
  try {
    const { path: botPath } = req.body ?? {};
    const resolved = await resolveBotScript(botPath);
    const id = botId(resolved);
    const pid = await readPid(id);
    if (pid == null || !isAlive(pid)) {
      await fs.unlink(botPidFile(id)).catch(() => {});
      return res.json({ ok: true, id, running: false });
    }
    try { process.kill(pid, "SIGTERM"); } catch {}
    // give it a moment, then SIGKILL if still alive
    setTimeout(() => {
      if (isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      fs.unlink(botPidFile(id)).catch(() => {});
    }, 2000);
    res.json({ ok: true, id, running: false, signaled: pid });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

// -----------------------------------------------------------------
// Open a project in Terminal.app with `claude` (or another allow-listed cmd)
// -----------------------------------------------------------------

const ALLOWED_COMMANDS = new Map([
  ["claude", "claude"],
  ["shell", "exec $SHELL -l"],
  ["dev", "npm run dev"],
  ["start", "npm start"],
]);

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

app.post("/api/open-terminal", async (req, res) => {
  try {
    const { dir, command = "claude" } = req.body ?? {};
    if (typeof dir !== "string" || !dir) {
      return res.status(400).json({ error: "dir required" });
    }
    const resolved = path.resolve(dir);
    if (resolved !== HOME && !resolved.startsWith(HOME + path.sep)) {
      return res.status(400).json({ error: "dir must be inside $HOME" });
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return res.status(404).json({ error: "not a directory" });
    }
    if (!ALLOWED_COMMANDS.has(command)) {
      return res.status(400).json({ error: "command not allowed" });
    }
    const shellCmd = `cd ${sq(resolved)} && clear && ${ALLOWED_COMMANDS.get(command)}`;

    const osa = spawn(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to activate`,
        "-e",
        `tell application "Terminal" to do script "${shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
      ],
      { stdio: "ignore" },
    );
    osa.on("error", (err) => console.error("osascript error", err));

    res.json({ ok: true, dir: resolved, command });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

app.delete("/api/access-password", async (req, res) => {
  try {
    const { projectId } = req.body ?? {};
    if (typeof projectId !== "string" || !SLUG_ID_RE.test(projectId)) {
      return res.status(400).json({ error: "Valid projectId required" });
    }
    const data = await readSecrets();
    delete data[projectId];
    await writeSecrets(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// -----------------------------------------------------------------
// Process status — reports running/stopped for launchd labels and pgrep patterns
// -----------------------------------------------------------------

const PATTERN_RE = /^[a-zA-Z0-9._\-\/ ]{1,120}$/;

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", () => resolve({ code: -1, stdout: "", stderr: "" }));
  });
}

let launchdCache = { text: "", expires: 0 };
async function getLaunchdList() {
  const now = Date.now();
  if (now < launchdCache.expires) return launchdCache.text;
  const { stdout } = await runCmd("launchctl", ["list"]);
  launchdCache = { text: stdout, expires: now + 4000 };
  return stdout;
}

function launchdMatch(listing, pattern) {
  const lines = listing.split("\n");
  for (const line of lines) {
    if (!line.toLowerCase().includes(pattern.toLowerCase())) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const [pid] = cols;
    return { running: pid !== "-" && pid !== "PID" && /^\d+$/.test(pid), pid };
  }
  return { running: false };
}

app.post("/api/process-status", async (req, res) => {
  try {
    const checks = Array.isArray(req.body?.checks) ? req.body.checks : [];
    const results = {};
    let launchdList = null;

    for (const c of checks) {
      if (!c || typeof c.id !== "string" || !SLUG_ID_RE.test(c.id)) continue;
      if (typeof c.pattern !== "string" || !PATTERN_RE.test(c.pattern)) {
        results[c.id] = { running: false, error: "invalid pattern" };
        continue;
      }
      if (c.kind === "launchd") {
        if (launchdList === null) launchdList = await getLaunchdList();
        const m = launchdMatch(launchdList, c.pattern);
        results[c.id] = m;
      } else if (c.kind === "pgrep") {
        const r = await runCmd("pgrep", ["-f", c.pattern]);
        const own = String(process.pid);
        const pids = r.stdout
          .split("\n")
          .map((p) => p.trim())
          .filter((p) => /^\d+$/.test(p) && p !== own);
        results[c.id] = {
          running: r.code === 0 && pids.length > 0,
          pid: pids[0],
          count: pids.length,
        };
      } else {
        results[c.id] = { running: false, error: "unknown kind" };
      }
    }

    res.json({ results, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// -----------------------------------------------------------------
// Project mtimes — last change per project via git log or fs stat
// -----------------------------------------------------------------

const MTIME_SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "out",
]);

async function projectMtime(dir) {
  const git = await runCmd("git", [
    "-C",
    dir,
    "log",
    "-1",
    "--format=%ct",
  ]);
  if (git.code === 0) {
    const secs = Number(git.stdout.trim());
    if (Number.isFinite(secs) && secs > 0) {
      return { mtime: new Date(secs * 1000).toISOString(), source: "git" };
    }
  }
  try {
    const stat = await fs.stat(dir);
    let maxMs = stat.mtimeMs;
    const sub = await fs.readdir(dir, { withFileTypes: true });
    for (const s of sub) {
      if (s.name.startsWith(".")) continue;
      if (MTIME_SKIP.has(s.name)) continue;
      try {
        const st = await fs.stat(path.join(dir, s.name));
        if (st.mtimeMs > maxMs) maxMs = st.mtimeMs;
      } catch {
        /* ignore */
      }
    }
    return { mtime: new Date(maxMs).toISOString(), source: "fs" };
  } catch {
    return null;
  }
}

app.post("/api/project-mtimes", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.projects) ? req.body.projects : [];
    const mtimes = {};
    await Promise.all(
      entries.map(async (e) => {
        if (!e || typeof e.id !== "string" || !SLUG_ID_RE.test(e.id)) return;
        if (typeof e.dir !== "string") return;
        const resolved = path.resolve(e.dir);
        if (resolved !== HOME && !resolved.startsWith(HOME + path.sep)) return;
        try {
          const st = await fs.stat(resolved);
          if (!st.isDirectory()) return;
        } catch {
          return;
        }
        const m = await projectMtime(resolved);
        if (m) mtimes[e.id] = m;
      }),
    );
    res.json({ mtimes, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// -----------------------------------------------------------------
// Port status — probe a set of TCP ports on 127.0.0.1 with a timeout
// -----------------------------------------------------------------

function probePort(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

app.post("/api/port-status", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.projects) ? req.body.projects : [];
    const results = {};
    await Promise.all(
      entries.map(async (e) => {
        if (!e || typeof e.id !== "string" || !SLUG_RE.test(e.id)) return;
        const port = Number(e.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;
        const open = await probePort(port);
        results[e.id] = { port, open };
      }),
    );
    res.json({ results, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// -----------------------------------------------------------------
// Git status — branch, dirty-count, ahead/behind for a set of dirs
// -----------------------------------------------------------------

async function gitStatus(dir) {
  const branchRes = await runCmd("git", [
    "-C",
    dir,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (branchRes.code !== 0) return null;
  const branch = branchRes.stdout.trim() || null;

  const porcelain = await runCmd("git", [
    "-C",
    dir,
    "status",
    "--porcelain",
  ]);
  const dirty =
    porcelain.code === 0
      ? porcelain.stdout.split("\n").filter((l) => l.trim().length > 0).length
      : 0;

  let ahead = 0;
  let behind = 0;
  const upstream = await runCmd("git", [
    "-C",
    dir,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (upstream.code === 0 && upstream.stdout.trim()) {
    const counts = await runCmd("git", [
      "-C",
      dir,
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    ]);
    if (counts.code === 0) {
      const [a, b] = counts.stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(a)) ahead = a;
      if (Number.isFinite(b)) behind = b;
    }
  }

  return { branch, dirty, ahead, behind, tracked: upstream.code === 0 };
}

app.post("/api/git-status", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.projects) ? req.body.projects : [];
    const results = {};
    await Promise.all(
      entries.map(async (e) => {
        if (!e || typeof e.id !== "string" || !SLUG_RE.test(e.id)) return;
        if (typeof e.dir !== "string") return;
        const resolved = path.resolve(e.dir);
        if (resolved !== HOME && !resolved.startsWith(HOME + path.sep)) return;
        try {
          const st = await fs.stat(resolved);
          if (!st.isDirectory()) return;
        } catch {
          return;
        }
        const g = await gitStatus(resolved);
        if (g) results[e.id] = g;
      }),
    );
    res.json({ results, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message ?? e) });
  }
});

// Static dist + SPA fallback
app.use(express.static(DIST_DIR, { index: "index.html" }));
app.get("*", (_req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`> Project Dashboard listening on http://localhost:${PORT}`);
});
