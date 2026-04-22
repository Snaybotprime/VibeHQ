export type PtySpawnRequest = {
  paneId: string;
  cwd: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
};

export type PtySpawnResult = {
  ok: boolean;
  pid?: number;
  error?: string;
};

export type PtyWriteRequest = {
  paneId: string;
  data: string;
};

export type PtyResizeRequest = {
  paneId: string;
  cols: number;
  rows: number;
};

export type PtyKillRequest = {
  paneId: string;
};

export type PtyDataEvent = {
  paneId: string;
  data: string;
};

export type PtyExitEvent = {
  paneId: string;
  exitCode: number | null;
  signal: number | null;
};

export type OpenProjectPayload = {
  dir: string;
  cmd?: string;
  name?: string;
};

export type PtyFgRequest = {
  paneId: string;
};

export type PtyFgResult = {
  ok: boolean;
  name?: string;
  pid?: number;
  error?: string;
};

export type AgentScope = "global" | "project";

export type WriteAgentRequest = {
  scope: AgentScope;
  projectDir?: string; // required when scope === "project"
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
};

export type WriteAgentResult = {
  ok: boolean;
  path?: string;
  error?: string;
};

export type PickProjectDirResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

export type AgentInfo = {
  name: string;
  description: string;
  scope: AgentScope;
  path: string;
};

export type ListAgentsRequest = {
  projectDir?: string;
};

export type ListAgentsResult =
  | { ok: true; agents: AgentInfo[] }
  | { ok: false; error: string };

export const IPC = {
  ptySpawn: "pty:spawn",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyKill: "pty:kill",
  ptyFg: "pty:fg",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  appOpenProject: "app:open-project",
  diagLog: "diag:log",
  writeAgent: "agent:write",
  listAgents: "agent:list",
  revealInFinder: "fs:reveal",
  clipboardWrite: "clipboard:write",
  clipboardRead: "clipboard:read",
  pickProjectDir: "dialog:pick-project",
} as const;
