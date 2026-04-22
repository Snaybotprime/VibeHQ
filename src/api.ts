export const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/i;

// Access-gate passwords -----------------------------------------------------

export type AccessPassword = {
  password: string;
  label?: string | null;
  note?: string | null;
  updatedAt?: string;
};

export type AccessPasswordMap = Record<string, AccessPassword>;

export async function fetchAccessPasswords(): Promise<AccessPasswordMap> {
  const res = await fetch("/api/access-passwords");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function saveAccessPassword(
  projectId: string,
  password: string,
  label?: string | null,
  note?: string | null,
): Promise<void> {
  const res = await fetch("/api/access-password", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, password, label, note }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

// Scan & terminal -----------------------------------------------------------

export type ScannedProject = {
  id: string;
  name: string;
  dir: string;
  stack: string;
  description: string;
  devCommand: string;
  localPort: number | null;
  gitRemote: string | null;
  status: "active";
  tags: string[];
  processCheck?:
    | { kind: "launchd"; pattern: string; label?: string }
    | { kind: "pgrep"; pattern: string; label?: string }
    | null;
  bots?: ScannedBot[];
  scanned: true;
};

export type ScannedBot = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
};

export type BotStatus = { running: boolean; pid?: number };

export type BotStatusResponse = {
  results: Record<string, BotStatus>;
  checkedAt: string;
};

export async function fetchBotStatus(
  ids: string[],
): Promise<BotStatusResponse> {
  if (ids.length === 0) {
    return { results: {}, checkedAt: new Date().toISOString() };
  }
  const res = await fetch("/api/bot-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function startBot(botPath: string): Promise<BotStatus & { id: string }> {
  const res = await fetch("/api/bot/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: botPath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function stopBot(botPath: string): Promise<BotStatus & { id: string }> {
  const res = await fetch("/api/bot/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: botPath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export type ProcessStatusCheck = {
  id: string;
  kind: "launchd" | "pgrep";
  pattern: string;
};

export type ProcessStatusResult = {
  running: boolean;
  pid?: string;
  count?: number;
  error?: string;
};

export type ProcessStatusResponse = {
  results: Record<string, ProcessStatusResult>;
  checkedAt: string;
};

export type ProjectMtimeEntry = {
  mtime: string;
  source: "git" | "fs";
};

export type ProjectMtimesResponse = {
  mtimes: Record<string, ProjectMtimeEntry>;
  checkedAt: string;
};

export async function fetchProjectMtimes(
  projects: { id: string; dir: string }[],
): Promise<ProjectMtimesResponse> {
  if (projects.length === 0) {
    return { mtimes: {}, checkedAt: new Date().toISOString() };
  }
  const res = await fetch("/api/project-mtimes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export type PortStatusEntry = { port: number; open: boolean };
export type PortStatusResponse = {
  results: Record<string, PortStatusEntry>;
  checkedAt: string;
};

export async function fetchPortStatus(
  projects: { id: string; port: number }[],
): Promise<PortStatusResponse> {
  if (projects.length === 0) {
    return { results: {}, checkedAt: new Date().toISOString() };
  }
  const res = await fetch("/api/port-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export type GitStatusEntry = {
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  tracked: boolean;
};
export type GitStatusResponse = {
  results: Record<string, GitStatusEntry>;
  checkedAt: string;
};

export async function fetchGitStatus(
  projects: { id: string; dir: string }[],
): Promise<GitStatusResponse> {
  if (projects.length === 0) {
    return { results: {}, checkedAt: new Date().toISOString() };
  }
  const res = await fetch("/api/git-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchProcessStatus(
  checks: ProcessStatusCheck[],
): Promise<ProcessStatusResponse> {
  if (checks.length === 0) {
    return { results: {}, checkedAt: new Date().toISOString() };
  }
  const res = await fetch("/api/process-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checks }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function scanProjects(): Promise<{
  projects: ScannedProject[];
  scannedAt: string;
}> {
  const res = await fetch("/api/scan-projects");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function openInTerminal(
  dir: string,
  command: "claude" | "shell" | "dev" | "start" = "claude",
): Promise<void> {
  const res = await fetch("/api/open-terminal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, command }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

export async function deleteAccessPassword(projectId: string): Promise<void> {
  const res = await fetch("/api/access-password", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

export type ClaudeUsageBucket = {
  used: number;
  budget: number;
  usedPct: number;
  elapsedPct: number;
  pacePct: number;
};

export type ClaudeUsageResponse = {
  daily: ClaudeUsageBucket;
  weekly: ClaudeUsageBucket;
  monthly: ClaudeUsageBucket;
  updatedAt: string;
};

export async function fetchClaudeUsage(): Promise<ClaudeUsageResponse> {
  const res = await fetch("/api/claude-usage");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ClaudeUsageResponse;
}
