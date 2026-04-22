import { ipcMain, shell, clipboard, dialog, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import {
  IPC,
  type AgentInfo,
  type ListAgentsRequest,
  type ListAgentsResult,
  type PickProjectDirResult,
  type WriteAgentRequest,
  type WriteAgentResult,
} from "../shared/ipc";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/;

function yamlEscape(value: string): string {
  // If it contains anything meaningful, use a double-quoted scalar and escape.
  if (/[:#\n'"&*!|>%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function agentFileBody(req: WriteAgentRequest): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${yamlEscape(req.name)}`);
  lines.push(`description: ${yamlEscape(req.description)}`);
  if (req.tools && req.tools.length > 0) {
    lines.push(`tools: [${req.tools.map(yamlEscape).join(", ")}]`);
  }
  lines.push("---");
  lines.push("");
  lines.push(req.systemPrompt.trimEnd());
  lines.push("");
  return lines.join("\n");
}

async function resolveAgentPath(
  req: WriteAgentRequest,
): Promise<string | { error: string }> {
  if (!NAME_RE.test(req.name)) {
    return { error: "Name must be [a-z0-9_-], 1–49 chars" };
  }

  const home = process.env.HOME;
  if (!home) return { error: "HOME not set" };

  let baseDir: string;
  if (req.scope === "global") {
    baseDir = path.join(home, ".claude", "agents");
  } else {
    if (!req.projectDir) return { error: "projectDir required for project scope" };
    const resolved = path.resolve(req.projectDir);
    if (resolved !== home && !resolved.startsWith(home + path.sep)) {
      return { error: "projectDir must be inside $HOME" };
    }
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) return { error: "projectDir is not a directory" };
    } catch {
      return { error: "projectDir does not exist" };
    }
    baseDir = path.join(resolved, ".claude", "agents");
  }
  return path.join(baseDir, `${req.name}.md`);
}

function parseYamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

async function readAgentsFromDir(
  dir: string,
  scope: "global" | "project",
): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: AgentInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const full = path.join(dir, entry);
    let body: string;
    try {
      body = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const fallbackName = entry.replace(/\.md$/, "");
    let name = fallbackName;
    let description = "";
    if (body.startsWith("---\n") || body.startsWith("---\r\n")) {
      const end = body.indexOf("\n---", 4);
      if (end !== -1) {
        const header = body.slice(4, end);
        for (const line of header.split(/\r?\n/)) {
          const m = /^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/.exec(line);
          if (!m) continue;
          const key = m[1].toLowerCase();
          if (key === "name") name = parseYamlScalar(m[2]) || fallbackName;
          else if (key === "description") description = parseYamlScalar(m[2]);
        }
      }
    }
    out.push({ name, description, scope, path: full });
  }
  return out;
}

export function registerActionHandlers(): void {
  ipcMain.handle(
    IPC.writeAgent,
    async (_e, req: WriteAgentRequest): Promise<WriteAgentResult> => {
      try {
        if (
          !req ||
          typeof req.name !== "string" ||
          typeof req.description !== "string" ||
          typeof req.systemPrompt !== "string"
        ) {
          return { ok: false, error: "Missing required fields" };
        }
        const pathOrErr = await resolveAgentPath(req);
        if (typeof pathOrErr !== "string") return { ok: false, ...pathOrErr };

        await fs.mkdir(path.dirname(pathOrErr), { recursive: true });
        await fs.writeFile(pathOrErr, agentFileBody(req), {
          encoding: "utf8",
          flag: "wx", // fail if exists
        });
        return { ok: true, path: pathOrErr };
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EEXIST") {
          return { ok: false, error: "An agent with that name already exists" };
        }
        return { ok: false, error: err.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.listAgents,
    async (_e, req: ListAgentsRequest): Promise<ListAgentsResult> => {
      try {
        const home = process.env.HOME;
        if (!home) return { ok: false, error: "HOME not set" };

        const agents: AgentInfo[] = [];
        agents.push(
          ...(await readAgentsFromDir(
            path.join(home, ".claude", "agents"),
            "global",
          )),
        );

        if (req?.projectDir) {
          const resolved = path.resolve(req.projectDir);
          if (resolved === home || resolved.startsWith(home + path.sep)) {
            agents.push(
              ...(await readAgentsFromDir(
                path.join(resolved, ".claude", "agents"),
                "project",
              )),
            );
          }
        }

        agents.sort((a, b) => {
          if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return { ok: true, agents };
      } catch (e) {
        return { ok: false, error: (e as Error).message ?? String(e) };
      }
    },
  );

  ipcMain.handle(IPC.revealInFinder, async (_e, target: unknown) => {
    if (typeof target !== "string") return { ok: false, error: "path required" };
    const home = process.env.HOME ?? "/";
    const resolved = path.resolve(target);
    if (resolved !== home && !resolved.startsWith(home + path.sep)) {
      return { ok: false, error: "path must be inside $HOME" };
    }
    try {
      shell.showItemInFolder(resolved);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.clipboardWrite, (_e, text: unknown) => {
    if (typeof text !== "string") return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle(IPC.clipboardRead, () => {
    return { ok: true, text: clipboard.readText() };
  });

  ipcMain.handle(IPC.pickProjectDir, async (e): Promise<PickProjectDirResult> => {
    try {
      const home = process.env.HOME;
      if (!home) return { ok: false, error: "HOME not set" };
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: "Add project folder",
            defaultPath: home,
            properties: ["openDirectory", "createDirectory"],
          })
        : await dialog.showOpenDialog({
            title: "Add project folder",
            defaultPath: home,
            properties: ["openDirectory", "createDirectory"],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, cancelled: true };
      }
      const resolved = path.resolve(result.filePaths[0]);
      if (resolved !== home && !resolved.startsWith(home + path.sep)) {
        return { ok: false, error: "folder must be inside $HOME" };
      }
      const st = await fs.stat(resolved).catch(() => null);
      if (!st || !st.isDirectory()) {
        return { ok: false, error: "not a directory" };
      }
      return { ok: true, path: resolved };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
  });
}
