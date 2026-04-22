import http from "node:http";
import { URL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { IPC, type OpenProjectPayload } from "../shared/ipc";
import { getOrCreateMainWindow } from "./window";

const PORT = Number(process.env.HQ_OPEN_PORT ?? 4322);
const ALLOWED_ORIGINS = new Set([
  "http://localhost:4321",
  "http://127.0.0.1:4321",
  "http://localhost:4322",
  "http://localhost:5173",
]);

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "http://localhost:4321";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

function resolveAndGuardDir(raw: string): string | null {
  const home = process.env.HOME ?? "/";
  const expanded = raw.startsWith("~")
    ? path.join(home, raw.slice(1))
    : raw;
  const resolved = path.resolve(expanded);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) return null;
  try {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

async function sendOpenProject(payload: OpenProjectPayload): Promise<boolean> {
  try {
    const win = await getOrCreateMainWindow();
    if (win.isMinimized()) win.restore();
    // Steal OS-level focus from the browser (macOS is restrictive here; app.focus
    // with steal:true is the only reliable path). Without this, the window comes
    // forward but keyboard focus stays with whatever the user was on.
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    }
    win.show();
    win.focus();
    win.moveTop();
    if (!win.webContents.getURL()) {
      await new Promise<void>((resolve) => {
        win.webContents.once("did-finish-load", () => resolve());
      });
    }
    // Extra tick so the renderer's effect subscription catches the event.
    await new Promise((r) => setTimeout(r, 50));
    win.webContents.send(IPC.appOpenProject, payload);
    return true;
  } catch (e) {
    console.error("[openServer] sendOpenProject failed", e);
    return false;
  }
}

export function startOpenServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin as string | undefined;
    const headers = corsHeaders(origin);

    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "hq" }));
      return;
    }

    if (url.pathname === "/open") {
      const rawDir = url.searchParams.get("dir");
      const cmd = url.searchParams.get("cmd") ?? undefined;
      const name = url.searchParams.get("name") ?? undefined;

      if (!rawDir) {
        res.writeHead(400, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "dir required" }));
        return;
      }

      const dir = resolveAndGuardDir(rawDir);
      if (!dir) {
        res.writeHead(400, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "dir must be an existing directory inside $HOME" }));
        return;
      }

      const delivered = await sendOpenProject({ dir, cmd, name });
      res.writeHead(delivered ? 200 : 503, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: delivered, dir, cmd, name }));
      return;
    }

    res.writeHead(404, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  server.on("error", (err) => {
    console.error("[openServer]", err);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[openServer] listening on http://127.0.0.1:${PORT}`);
  });

  return server;
}
