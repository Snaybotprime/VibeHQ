import type {
  ListAgentsRequest,
  ListAgentsResult,
  OpenProjectPayload,
  PickProjectDirResult,
  PtyDataEvent,
  PtyExitEvent,
  PtyFgRequest,
  PtyFgResult,
  PtyKillRequest,
  PtyResizeRequest,
  PtySpawnRequest,
  PtySpawnResult,
  PtyWriteRequest,
  WriteAgentRequest,
  WriteAgentResult,
} from "../../shared/ipc";

type Unsubscribe = () => void;

export type HelixAPI = {
  version: string;
  pty: {
    spawn: (req: PtySpawnRequest) => Promise<PtySpawnResult>;
    write: (req: PtyWriteRequest) => Promise<{ ok: boolean; error?: string }>;
    resize: (req: PtyResizeRequest) => Promise<{ ok: boolean; error?: string }>;
    kill: (req: PtyKillRequest) => Promise<{ ok: boolean }>;
    fg: (req: PtyFgRequest) => Promise<PtyFgResult>;
    onData: (cb: (event: PtyDataEvent) => void) => Unsubscribe;
    onExit: (cb: (event: PtyExitEvent) => void) => Unsubscribe;
  };
  app: {
    onOpenProject: (cb: (payload: OpenProjectPayload) => void) => Unsubscribe;
    diagLog: (...args: unknown[]) => void;
    platform: NodeJS.Platform;
    homedir: string;
  };
  actions: {
    writeAgent: (req: WriteAgentRequest) => Promise<WriteAgentResult>;
    listAgents: (req: ListAgentsRequest) => Promise<ListAgentsResult>;
    revealInFinder: (
      path: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    clipboardWrite: (text: string) => Promise<{ ok: boolean }>;
    clipboardRead: () => Promise<{ ok: boolean; text?: string }>;
    getPathForFile: (file: File) => string;
    pickProjectDir: () => Promise<PickProjectDirResult>;
  };
};

declare global {
  interface Window {
    helix: HelixAPI;
  }
}

export {};
