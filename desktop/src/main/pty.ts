import { BrowserWindow, ipcMain } from "electron";
import { spawn as ptySpawn, type IPty } from "node-pty";
import {
  IPC,
  type PtyFgRequest,
  type PtyFgResult,
  type PtyKillRequest,
  type PtyResizeRequest,
  type PtySpawnRequest,
  type PtySpawnResult,
  type PtyWriteRequest,
} from "../shared/ipc";

type Entry = {
  pty: IPty;
  windowId: number;
};

const ptys = new Map<string, Entry>();

function resolveShell(requested?: string): string {
  if (requested) return requested;
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === "win32" ? "powershell.exe" : "/bin/zsh";
}

export function registerPtyHandlers(): void {
  ipcMain.handle(IPC.ptySpawn, async (ev, req: PtySpawnRequest): Promise<PtySpawnResult> => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (!win) return { ok: false, error: "no window" };

    // Kill any existing pane with the same id (replace-on-reuse semantics)
    killPty(req.paneId);

    try {
      const shell = resolveShell(req.shell);
      const env = {
        ...process.env,
        ...(req.env ?? {}),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      };
      const p = ptySpawn(shell, req.args ?? [], {
        name: "xterm-256color",
        cwd: req.cwd,
        env: env as Record<string, string>,
        cols: Math.max(1, req.cols | 0),
        rows: Math.max(1, req.rows | 0),
      });

      const paneId = req.paneId;
      const windowId = win.id;
      ptys.set(paneId, { pty: p, windowId });

      p.onData((data) => {
        const w = BrowserWindow.fromId(windowId);
        if (!w || w.isDestroyed()) return;
        w.webContents.send(IPC.ptyData, { paneId, data });
      });

      p.onExit(({ exitCode, signal }) => {
        const w = BrowserWindow.fromId(windowId);
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC.ptyExit, {
            paneId,
            exitCode: exitCode ?? null,
            signal: signal ?? null,
          });
        }
        ptys.delete(paneId);
      });

      return { ok: true, pid: p.pid };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.ptyWrite, (_ev, req: PtyWriteRequest) => {
    const entry = ptys.get(req.paneId);
    if (!entry) return { ok: false, error: "unknown paneId" };
    try {
      entry.pty.write(req.data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.ptyResize, (_ev, req: PtyResizeRequest) => {
    const entry = ptys.get(req.paneId);
    if (!entry) return { ok: false, error: "unknown paneId" };
    try {
      entry.pty.resize(Math.max(1, req.cols | 0), Math.max(1, req.rows | 0));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.ptyKill, (_ev, req: PtyKillRequest) => {
    return { ok: killPty(req.paneId) };
  });

  ipcMain.handle(IPC.ptyFg, (_ev, req: PtyFgRequest): PtyFgResult => {
    const entry = ptys.get(req.paneId);
    if (!entry) return { ok: false, error: "unknown paneId" };
    try {
      return { ok: true, name: entry.pty.process, pid: entry.pty.pid };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
}

export function killPty(paneId: string): boolean {
  const entry = ptys.get(paneId);
  if (!entry) return false;
  try {
    entry.pty.kill();
  } catch {
    /* already gone */
  }
  ptys.delete(paneId);
  return true;
}

export function killAllPtys(): void {
  for (const [id] of ptys) killPty(id);
}
