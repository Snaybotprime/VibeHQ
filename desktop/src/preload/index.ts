import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";
import { electronAPI } from "@electron-toolkit/preload";
import {
  IPC,
  type ListAgentsRequest,
  type ListAgentsResult,
  type OpenProjectPayload,
  type PickProjectDirResult,
  type PtyDataEvent,
  type PtyExitEvent,
  type PtyFgRequest,
  type PtyFgResult,
  type PtyKillRequest,
  type PtyResizeRequest,
  type PtySpawnRequest,
  type PtySpawnResult,
  type PtyWriteRequest,
  type WriteAgentRequest,
  type WriteAgentResult,
} from "../shared/ipc";

type Unsubscribe = () => void;

const pty = {
  spawn: (req: PtySpawnRequest): Promise<PtySpawnResult> =>
    ipcRenderer.invoke(IPC.ptySpawn, req),
  write: (req: PtyWriteRequest): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ptyWrite, req),
  resize: (req: PtyResizeRequest): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ptyResize, req),
  kill: (req: PtyKillRequest): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ptyKill, req),
  fg: (req: PtyFgRequest): Promise<PtyFgResult> =>
    ipcRenderer.invoke(IPC.ptyFg, req),
  onData: (cb: (event: PtyDataEvent) => void): Unsubscribe => {
    const listener = (_e: IpcRendererEvent, payload: PtyDataEvent) => cb(payload);
    ipcRenderer.on(IPC.ptyData, listener);
    return () => ipcRenderer.off(IPC.ptyData, listener);
  },
  onExit: (cb: (event: PtyExitEvent) => void): Unsubscribe => {
    const listener = (_e: IpcRendererEvent, payload: PtyExitEvent) => cb(payload);
    ipcRenderer.on(IPC.ptyExit, listener);
    return () => ipcRenderer.off(IPC.ptyExit, listener);
  },
};

const appApi = {
  onOpenProject: (cb: (payload: OpenProjectPayload) => void): Unsubscribe => {
    const listener = (_e: IpcRendererEvent, payload: OpenProjectPayload) =>
      cb(payload);
    ipcRenderer.on(IPC.appOpenProject, listener);
    return () => ipcRenderer.off(IPC.appOpenProject, listener);
  },
  diagLog: (...args: unknown[]) => ipcRenderer.send(IPC.diagLog, ...args),
  platform: process.platform,
  homedir: process.env.HOME ?? "/",
};

const actions = {
  writeAgent: (req: WriteAgentRequest): Promise<WriteAgentResult> =>
    ipcRenderer.invoke(IPC.writeAgent, req),
  listAgents: (req: ListAgentsRequest): Promise<ListAgentsResult> =>
    ipcRenderer.invoke(IPC.listAgents, req),
  revealInFinder: (targetPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.revealInFinder, targetPath),
  clipboardWrite: (text: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.clipboardWrite, text),
  clipboardRead: (): Promise<{ ok: boolean; text?: string }> =>
    ipcRenderer.invoke(IPC.clipboardRead),
  // Resolve a DOM File dropped onto the renderer to its absolute filesystem
  // path. webUtils lives in preload (Electron 32+); exposing the full module
  // would be a leaky abstraction, so we only expose this one function.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  pickProjectDir: (): Promise<PickProjectDirResult> =>
    ipcRenderer.invoke(IPC.pickProjectDir),
};

const hq = {
  version: "0.1.0",
  pty,
  app: appApi,
  actions,
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("hq", hq);
  } catch (error) {
    console.error(error);
  }
}

export type HqAPI = typeof hq;
