import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  projects as baseProjects,
  type Project,
  type Connection,
  type ProcessCheck,
  type SubRoute,
} from "./projects";
import {
  countOverrides,
  useOverrides,
  usePinned,
  type ProjectOverride,
} from "./overrides";
import { ProjectMap } from "./ProjectMap";
import { CommandPalette } from "./CommandPalette";
import {
  deleteAccessPassword,
  fetchAccessPasswords,
  fetchBotStatus,
  fetchClaudeUsage,
  fetchGitStatus,
  fetchPortStatus,
  fetchProcessStatus,
  fetchProjectMtimes,
  openInTerminal,
  SAFE_SLUG_RE,
  saveAccessPassword,
  scanProjects,
  startBot,
  stopBot,
  type AccessPassword,
  type AccessPasswordMap,
  type BotStatus,
  type ClaudeUsageBucket,
  type ClaudeUsageResponse,
  type GitStatusEntry,
  type PortStatusEntry,
  type ProcessStatusResult,
  type ProjectMtimeEntry,
  type ScannedProject,
} from "./api";

type Filter = "all" | "active" | "backup" | "stub";
const FILTERS: Filter[] = ["all", "active", "backup", "stub"];

type SortMode = "default" | "recent" | "name" | "status" | "category";
const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "category", label: "Category" },
];

const STATUS_RANK: Record<string, number> = { active: 0, backup: 1, stub: 2 };

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function UsageBar({
  label,
  data,
}: {
  label: string;
  data: ClaudeUsageBucket;
}) {
  const fillPct = Math.min(100, Math.max(0, data.usedPct));
  const paceAbs = Math.round(Math.abs(data.pacePct));
  const paceLabel =
    paceAbs < 1
      ? "on pace"
      : data.pacePct > 0
        ? `${paceAbs}% over pace`
        : `${paceAbs}% under pace`;
  const paceClass =
    paceAbs < 1 ? "on" : data.pacePct > 0 ? "over" : "under";
  return (
    <div className="usage-bar">
      <div className="usage-bar-head">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">{Math.round(data.usedPct)}%</span>
      </div>
      <div className="usage-bar-track" title={`Elapsed: ${Math.round(data.elapsedPct)}%`}>
        <div className="usage-bar-fill" style={{ width: `${fillPct}%` }} />
        <div
          className="usage-bar-pace-marker"
          style={{ left: `${Math.min(100, Math.max(0, data.elapsedPct))}%` }}
          aria-label={`pace marker at ${Math.round(data.elapsedPct)}%`}
        />
      </div>
      <div className="usage-bar-meta">
        <span>
          {formatTokens(data.used)} / {formatTokens(data.budget)}
        </span>
        <span className={`usage-bar-pace ${paceClass}`}>{paceLabel}</span>
      </div>
    </div>
  );
}

function ClaudeUsageBanner() {
  const [usage, setUsage] = useState<ClaudeUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetchClaudeUsage();
        if (!cancelled) {
          setUsage(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (error && !usage) {
    return (
      <div className="usage-bars usage-bars-error">
        Claude usage unavailable · {error}
      </div>
    );
  }
  if (!usage) {
    return <div className="usage-bars usage-bars-loading">Loading Claude usage…</div>;
  }
  return (
    <div className="usage-bars">
      <UsageBar label="Today" data={usage.daily} />
      <UsageBar label="This week" data={usage.weekly} />
      <UsageBar label="This month" data={usage.monthly} />
    </div>
  );
}

function formatAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving"; label: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

type ResolvedConnection = Connection & {
  originalUrl: string;
  edited: boolean;
  index: number;
};

type ResolvedSubRoute = SubRoute & {
  originalPath: string;
  originalName: string;
  edited: boolean;
  index: number;
};

type ResolvedProject = Omit<Project, "connections" | "subRoutes"> & {
  connections: ResolvedConnection[];
  subRoutes?: ResolvedSubRoute[];
  hasOverrides: boolean;
  customTags: string[];
};

function applyOverride(
  project: Project,
  override: ProjectOverride | undefined,
): ResolvedProject {
  const connections: ResolvedConnection[] = project.connections.map(
    (c, index) => {
      const overrideUrl = override?.connections?.[index];
      return {
        ...c,
        url: overrideUrl ?? c.url,
        originalUrl: c.url,
        edited: Boolean(overrideUrl && overrideUrl !== c.url),
        index,
      };
    },
  );

  const subRoutes: ResolvedSubRoute[] | undefined = project.subRoutes?.map(
    (s, index) => {
      const patch = override?.subRoutes?.[index];
      const path = patch?.path ?? s.path;
      const name = patch?.name ?? s.name;
      return {
        ...s,
        path,
        name,
        originalPath: s.path,
        originalName: s.name,
        edited:
          (patch?.path !== undefined && patch.path !== s.path) ||
          (patch?.name !== undefined && patch.name !== s.name),
        index,
      };
    },
  );

  const customTags = (override?.tags ?? []).filter(
    (t) => !project.tags.includes(t),
  );
  const mergedTags = [...project.tags, ...customTags];

  const hasOverrides =
    connections.some((c) => c.edited) ||
    !!subRoutes?.some((s) => s.edited) ||
    customTags.length > 0;

  return {
    ...project,
    connections,
    subRoutes,
    hasOverrides,
    tags: mergedTags,
    customTags,
  };
}

export default function App() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [passwords, setPasswords] = useState<AccessPasswordMap>({});
  const [passwordsLoaded, setPasswordsLoaded] = useState(false);
  const [scannedExtras, setScannedExtras] = useState<ScannedProject[]>([]);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [processStatus, setProcessStatus] = useState<
    Record<string, ProcessStatusResult>
  >({});
  const [botStatus, setBotStatus] = useState<Record<string, BotStatus>>({});
  const [mtimes, setMtimes] = useState<Record<string, ProjectMtimeEntry>>({});
  const [portStatus, setPortStatus] = useState<Record<string, PortStatusEntry>>({});
  const [gitStatus, setGitStatus] = useState<Record<string, GitStatusEntry>>({});
  const [clusterFilter, setClusterFilter] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const overridesApi = useOverrides();
  const pinnedApi = usePinned();

  useEffect(() => {
    fetchAccessPasswords()
      .then((m) => {
        setPasswords(m);
        setPasswordsLoaded(true);
      })
      .catch(() => setPasswordsLoaded(true));
  }, []);

  const mergedProjects: Project[] = useMemo(() => {
    const scannedByDir = new Map(scannedExtras.map((s) => [s.dir, s]));
    const baselineDirs = new Set(baseProjects.map((p) => p.dir));
    const enrichedBase: Project[] = baseProjects.map((p) => {
      const s = scannedByDir.get(p.dir);
      if (!s) return p;
      return { ...p, bots: s.bots ?? p.bots };
    });
    const extras: Project[] = scannedExtras
      .filter((s) => !baselineDirs.has(s.dir))
      .map((s) => ({
        id: s.id,
        name: s.name,
        dir: s.dir,
        stack: s.stack,
        description: s.description,
        devCommand: s.devCommand,
        localPort: s.localPort,
        connections: s.localPort
          ? [
              {
                label: "Local",
                url: `http://localhost:${s.localPort}`,
                kind: "local",
              },
            ]
          : [],
        gitRemote: s.gitRemote ?? undefined,
        status: s.status,
        tags: [...s.tags, "scanned"],
        processCheck: s.processCheck ?? undefined,
        bots: s.bots,
      }));
    return [...enrichedBase, ...extras];
  }, [scannedExtras]);

  const resolved = useMemo<ResolvedProject[]>(
    () =>
      mergedProjects.map((p) =>
        applyOverride(p, overridesApi.overrides[p.id]),
      ),
    [overridesApi.overrides, mergedProjects],
  );

  const processChecks = useMemo(() => {
    return mergedProjects
      .filter((p): p is Project & { processCheck: ProcessCheck } =>
        Boolean(p.processCheck),
      )
      .map((p) => ({
        id: p.id,
        kind: p.processCheck.kind,
        pattern: p.processCheck.pattern,
      }));
  }, [mergedProjects]);

  useEffect(() => {
    if (processChecks.length === 0) {
      setProcessStatus({});
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetchProcessStatus(processChecks);
        if (!cancelled) setProcessStatus(r.results);
      } catch {
        /* keep last-known */
      }
    };
    run();
    const id = window.setInterval(run, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [processChecks]);

  const botIds = useMemo(() => {
    const out: string[] = [];
    for (const p of mergedProjects) {
      for (const b of p.bots ?? []) out.push(b.id);
    }
    return out;
  }, [mergedProjects]);

  useEffect(() => {
    if (botIds.length === 0) {
      setBotStatus({});
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetchBotStatus(botIds);
        if (!cancelled) setBotStatus(r.results);
      } catch {
        /* keep last-known */
      }
    };
    run();
    const id = window.setInterval(run, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [botIds.join(",")]);

  const handleBotToggle = useCallback(
    async (bot: { id: string; path: string; name: string }, turnOn: boolean) => {
      setBotStatus((prev) => ({
        ...prev,
        [bot.id]: { running: turnOn, pid: prev[bot.id]?.pid },
      }));
      try {
        const r = turnOn ? await startBot(bot.path) : await stopBot(bot.path);
        setBotStatus((prev) => ({
          ...prev,
          [bot.id]: { running: r.running, pid: r.pid },
        }));
        setToast({
          kind: "ok",
          text: `${bot.name} ${turnOn ? "started" : "stopped"}`,
        });
      } catch (e) {
        setBotStatus((prev) => ({
          ...prev,
          [bot.id]: { running: !turnOn, pid: prev[bot.id]?.pid },
        }));
        setToast({ kind: "error", text: String((e as Error).message ?? e) });
      }
    },
    [],
  );

  const mtimeTargets = useMemo(
    () => mergedProjects.map((p) => ({ id: p.id, dir: p.dir })),
    [mergedProjects],
  );

  useEffect(() => {
    if (mtimeTargets.length === 0) return;
    let cancelled = false;
    fetchProjectMtimes(mtimeTargets)
      .then((r) => {
        if (!cancelled) setMtimes(r.mtimes);
      })
      .catch(() => {
        /* keep last-known */
      });
    return () => {
      cancelled = true;
    };
  }, [mtimeTargets]);

  const portTargets = useMemo(
    () =>
      mergedProjects
        .filter((p): p is typeof p & { localPort: number } =>
          typeof p.localPort === "number" && p.localPort > 0,
        )
        .map((p) => ({ id: p.id, port: p.localPort })),
    [mergedProjects],
  );

  useEffect(() => {
    if (portTargets.length === 0) {
      setPortStatus({});
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetchPortStatus(portTargets);
        if (!cancelled) setPortStatus(r.results);
      } catch {
        /* keep last-known */
      }
    };
    run();
    const id = window.setInterval(run, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [portTargets]);

  const gitTargets = useMemo(
    () => mergedProjects.map((p) => ({ id: p.id, dir: p.dir })),
    [mergedProjects],
  );

  useEffect(() => {
    if (gitTargets.length === 0) return;
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetchGitStatus(gitTargets);
        if (!cancelled) setGitStatus(r.results);
      } catch {
        /* keep last-known */
      }
    };
    run();
    const id = window.setInterval(run, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [gitTargets]);


  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of resolved) {
      for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t);
  }, [resolved]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Group projects into coarse "clusters" by tag — customise this to
    // match whatever tag taxonomy you use in src/projects.ts.
    const clusterOf = (p: ResolvedProject): string => {
      if (p.tags.includes("work")) return "work";
      if (p.tags.includes("oss")) return "oss";
      return "personal";
    };
    const list = resolved.filter((p) => {
      if (filter !== "all" && p.status !== filter) return false;
      if (tagFilter && !p.tags.includes(tagFilter)) return false;
      if (clusterFilter && clusterOf(p) !== clusterFilter) return false;
      if (!q) return true;
      const hay = [
        p.name,
        p.description,
        p.stack,
        p.dir,
        ...p.tags,
        ...p.connections.map((c) => c.url),
        ...(p.subRoutes ?? []).map((s) => `${s.path} ${s.name}`),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

    const sorted = [...list];
    if (sortMode === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "status") {
      sorted.sort(
        (a, b) =>
          (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99) ||
          a.name.localeCompare(b.name),
      );
    } else if (sortMode === "category") {
      const primary = (p: ResolvedProject) => p.tags[0] ?? "~";
      sorted.sort(
        (a, b) =>
          primary(a).localeCompare(primary(b)) ||
          a.name.localeCompare(b.name),
      );
    } else if (sortMode === "recent") {
      const ts = (p: ResolvedProject) => {
        const iso = mtimes[p.id]?.mtime;
        return iso ? new Date(iso).getTime() : 0;
      };
      sorted.sort((a, b) => ts(b) - ts(a) || a.name.localeCompare(b.name));
    }

    const pinnedSet = new Set(pinnedApi.pinned);
    if (pinnedSet.size > 0) {
      sorted.sort((a, b) => {
        const ap = pinnedSet.has(a.id) ? 0 : 1;
        const bp = pinnedSet.has(b.id) ? 0 : 1;
        return ap - bp;
      });
    }
    return sorted;
  }, [
    query,
    filter,
    tagFilter,
    clusterFilter,
    sortMode,
    resolved,
    mtimes,
    pinnedApi.pinned,
  ]);

  const totals = useMemo(() => {
    const subs = resolved.reduce((n, p) => n + (p.subRoutes?.length ?? 0), 0);
    const deployed = resolved.reduce(
      (n, p) => n + p.connections.filter((c) => c.kind === "deployed").length,
      0,
    );
    const local = resolved.reduce(
      (n, p) => n + p.connections.filter((c) => c.kind === "local").length,
      0,
    );
    return { total: resolved.length, subs, deployed, local };
  }, [resolved]);

  const totalOverrides = countOverrides(overridesApi.overrides);

  const showToast = useCallback(
    (kind: "ok" | "error", text: string, ms = 5000) => {
      setToast({ kind, text });
      window.setTimeout(() => setToast(null), ms);
    },
    [],
  );

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const result = await scanProjects();
      const baselineDirs = new Set(baseProjects.map((p) => p.dir));
      const existingExtraDirs = new Set(scannedExtras.map((e) => e.dir));
      const newlyFound = result.projects.filter(
        (p) => !baselineDirs.has(p.dir) && !existingExtraDirs.has(p.dir),
      );
      setScannedExtras(result.projects);
      setLastScan(result.scannedAt);
      if (newlyFound.length === 0) {
        showToast(
          "ok",
          `Scanned ${result.projects.length} folders. No new projects.`,
        );
      } else {
        showToast(
          "ok",
          `Found ${newlyFound.length} new project${
            newlyFound.length === 1 ? "" : "s"
          }: ${newlyFound.map((p) => p.name).join(", ")}`,
          6000,
        );
      }
    } catch (e) {
      showToast("error", `Scan failed: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  }, [scanning, scannedExtras, showToast]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await scanProjects();
        if (cancelled) return;
        setScannedExtras(result.projects);
        setLastScan(result.scannedAt);
      } catch {
        /* keep last-known */
      }
    };
    tick();
    const id = window.setInterval(tick, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isK = e.key === "k" || e.key === "K";
      if (isK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openInClaude = useCallback(
    async (dir: string) => {
      try {
        await openInTerminal(dir, "claude");
        showToast("ok", `Opened Terminal in ${dir.replace(/^\/(Users|home)\/[^/]+\//, "~/")} · claude launching`);
      } catch (e) {
        showToast("error", `Open failed: ${(e as Error).message}`);
      }
    },
    [showToast],
  );

  const openInDesktop = useCallback(
    async (dir: string, name: string) => {
      const url =
        `http://127.0.0.1:4322/open?dir=${encodeURIComponent(dir)}` +
        `&cmd=${encodeURIComponent("claude")}&name=${encodeURIComponent(name)}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        showToast(
          "ok",
          `Opened in ProjectDashboard · claude in ${dir.replace(/^\/(Users|home)\/[^/]+\//, "~/")}`,
        );
      } catch (e) {
        showToast(
          "error",
          `ProjectDashboard app not reachable on :4322 · ${(e as Error).message}`,
          7000,
        );
      }
    },
    [showToast],
  );

  const onSavePassword = useCallback(
    async (projectId: string, password: string, label: string | null) => {
      await saveAccessPassword(projectId, password, label);
      setPasswords((prev) => {
        if (password === "") {
          const { [projectId]: _, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [projectId]: {
            password,
            label,
            updatedAt: new Date().toISOString(),
          },
        };
      });
    },
    [],
  );

  const onDeletePassword = useCallback(async (projectId: string) => {
    await deleteAccessPassword(projectId);
    setPasswords((prev) => {
      const { [projectId]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  return (
    <>
      <div className="bg-layer">
        <div className="blob blob-1" />
        <div className="blob blob-2" />
        <div className="blob blob-3" />
      </div>
      <div className="bg-layer bg-grid" />
      <div className="bg-layer bg-noise" />

      <div className="shell">
        <nav className="topbar">
          <div className="brand">
            <span className="brand-logo" />
            <span className="brand-name">Project Dashboard</span>
          </div>
          <div className="topbar-end">
            <button
              className={`ghost-btn ${scanning ? "scanning" : ""}`}
              onClick={runScan}
              disabled={scanning}
              title={
                lastScan
                  ? `Last scan: ${new Date(lastScan).toLocaleTimeString()}`
                  : "Scan $HOME for new project folders"
              }
            >
              <span className={`refresh-icon ${scanning ? "spin" : ""}`}>
                ↻
              </span>
              {scanning ? "Scanning…" : "Rescan"}
            </button>
            <button
              className="ghost-btn palette-trigger"
              onClick={() => setPaletteOpen(true)}
              title="Command palette (⌘K)"
            >
              <span className="palette-glyph" aria-hidden>
                ⌘
              </span>
              <span>Palette</span>
              <kbd className="palette-trigger-kbd">K</kbd>
            </button>
            <span className="chip-status">
              <span className="dot-live" />
              <span>Local · :4321</span>
            </span>
          </div>
        </nav>

        <section className="hero">
          <p className="hero-tag">Workspace overview</p>
          <h1 className="hero-title">
            <span className="line">Every site,</span>
            <span className="accent">every connection.</span>
          </h1>
          <p className="hero-sub">
            One surface for projects under <code>$HOME</code>. Edit routes
            inline and keep shared access passwords within reach.
          </p>

          <ClaudeUsageBanner />

          <div className="stats">
            <div className="stat">
              <span className="stat-value">{totals.total}</span>
              <span className="stat-label">Projects</span>
            </div>
            <div className="stat">
              <span className="stat-value">{totals.deployed}</span>
              <span className="stat-label">Deployed</span>
            </div>
            <div className="stat">
              <span className="stat-value">{totals.local}</span>
              <span className="stat-label">Local</span>
            </div>
            <div className="stat">
              <span className="stat-value">{totals.subs}</span>
              <span className="stat-label">Sub-routes</span>
            </div>
          </div>
        </section>

        <div className="toolbar">
          <label className="search-wrap">
            <span className="search-icon">⌕</span>
            <input
              className="search"
              placeholder="Search projects, URLs, tags…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </label>
          <div className="filter-group">
            {FILTERS.map((f) => (
              <button
                key={f}
                className={`chip ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <label className="sort-wrap" title="Sort projects">
            <span className="sort-label">Sort</span>
            <select
              className="sort-select"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              {SORT_MODES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {clusterFilter && (
            <button
              className="chip chip-tag active"
              onClick={() => setClusterFilter(null)}
              title="Clear cluster filter"
            >
              cluster · {clusterFilter}
              <span className="chip-x" aria-hidden>
                ×
              </span>
            </button>
          )}
          {tagFilter && (
            <button
              className="chip chip-tag active"
              onClick={() => setTagFilter(null)}
              title="Clear tag filter"
            >
              #{tagFilter}
              <span className="chip-x" aria-hidden>
                ×
              </span>
            </button>
          )}
          {totalOverrides > 0 && (
            <button
              className="chip chip-warn"
              onClick={() => {
                if (
                  confirm(
                    `Reset all ${totalOverrides} local label edit(s)? (This won't un-rename anything on disk.)`,
                  )
                ) {
                  overridesApi.resetAll();
                }
              }}
              title="Discard local URL labels"
            >
              Reset {totalOverrides} edit{totalOverrides === 1 ? "" : "s"}
            </button>
          )}
        </div>

        {allTags.length > 0 && (
          <div className="tag-bar" role="group" aria-label="Filter by tag">
            {allTags.slice(0, 18).map((t) => (
              <button
                key={t}
                className={`tag-chip ${tagFilter === t ? "active" : ""}`}
                onClick={() => setTagFilter(tagFilter === t ? null : t)}
              >
                #{t}
              </button>
            ))}
          </div>
        )}

        <div className="grid">
          {filtered.length === 0 ? (
            <div className="empty">No matches. Check your signal.</div>
          ) : (
            filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                featured={pinnedApi.isPinned(p.id)}
                pinned={pinnedApi.isPinned(p.id)}
                onTogglePin={() => pinnedApi.toggle(p.id)}
                open={!!expanded[p.id]}
                onToggle={() =>
                  setExpanded((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                }
                overridesApi={overridesApi}
                password={passwords[p.id]}
                passwordsLoaded={passwordsLoaded}
                onSavePassword={onSavePassword}
                onDeletePassword={onDeletePassword}
                onOpenInClaude={() => openInClaude(p.dir)}
                onOpenInDesktop={() => openInDesktop(p.dir, p.name)}
                onToast={showToast}
                activeTag={tagFilter}
                onTagClick={(t) => setTagFilter(tagFilter === t ? null : t)}
                processStatus={
                  p.processCheck ? processStatus[p.id] : undefined
                }
                mtime={mtimes[p.id]}
                portStatus={portStatus[p.id]}
                gitStatus={gitStatus[p.id]}
                botStatus={botStatus}
                onBotToggle={handleBotToggle}
              />
            ))
          )}
        </div>

        <ProjectMap
          projects={resolved}
          clusterFilter={clusterFilter}
          onClusterClick={(c) =>
            setClusterFilter(clusterFilter === c ? null : c)
          }
        />
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        projects={resolved}
        passwords={passwords}
        onOpenInClaude={openInClaude}
        onOpenInDesktop={openInDesktop}
        onRescan={runScan}
        onToast={showToast}
        onTogglePin={pinnedApi.toggle}
        isPinned={pinnedApi.isPinned}
      />

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span className="toast-ico">{toast.kind === "ok" ? "✓" : "!"}</span>
          <span className="toast-text">{toast.text}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </>
  );
}

type HealthLevel = "good" | "warn" | "idle" | "stale" | "stub";

type HealthResult = {
  level: HealthLevel;
  score: number;
  signals: string[];
  tooltip: string;
};

function computeHealth(
  p: ResolvedProject,
  signals: {
    processStatus?: ProcessStatusResult;
    mtime?: ProjectMtimeEntry;
    portStatus?: PortStatusEntry;
    gitStatus?: GitStatusEntry;
  },
): HealthResult {
  if (p.status === "stub") {
    return {
      level: "stub",
      score: 0,
      signals: ["stub"],
      tooltip: "Stub · not initialized",
    };
  }

  const lines: string[] = [];
  const pluses: string[] = [];
  let score = 50;

  if (p.processCheck && signals.processStatus) {
    if (signals.processStatus.running) {
      score += 20;
      pluses.push("launchd up");
    } else {
      score -= 10;
      lines.push("launchd down");
    }
  }

  if (p.localPort && signals.portStatus) {
    if (signals.portStatus.open) {
      score += 20;
      pluses.push(`:${p.localPort} open`);
    } else {
      score -= 5;
      lines.push(`:${p.localPort} closed`);
    }
  }

  if (signals.gitStatus) {
    const g = signals.gitStatus;
    if (g.dirty > 0) {
      score -= Math.min(15, g.dirty * 2);
      lines.push(`${g.dirty} dirty`);
    } else {
      pluses.push("git clean");
    }
    if (g.ahead > 0) {
      score -= Math.min(10, g.ahead * 2);
      lines.push(`${g.ahead} unpushed`);
    }
    if (g.behind > 0) {
      lines.push(`${g.behind} behind`);
    }
  }

  if (signals.mtime) {
    const ageDays =
      (Date.now() - new Date(signals.mtime.mtime).getTime()) /
      (24 * 60 * 60 * 1000);
    if (ageDays > 30) {
      score -= 15;
      lines.push(`stale ${Math.floor(ageDays)}d`);
    } else if (ageDays < 2) {
      score += 5;
    }
  }

  score = Math.max(0, Math.min(100, score));

  let level: HealthLevel = "idle";
  if (lines.some((l) => l.includes("stale"))) {
    level = "stale";
  } else if (score >= 70) {
    level = "good";
  } else if (score >= 45) {
    level = "idle";
  } else {
    level = "warn";
  }

  const tooltip =
    [...pluses.map((s) => `+ ${s}`), ...lines.map((s) => `– ${s}`)].join("  ") ||
    "No signals yet";
  const merged = [...pluses, ...lines];
  return { level, score, signals: merged, tooltip };
}

function ProjectCard({
  project: p,
  featured,
  pinned,
  onTogglePin,
  open,
  onToggle,
  overridesApi,
  password,
  passwordsLoaded,
  onSavePassword,
  onDeletePassword,
  onOpenInClaude,
  onOpenInDesktop,
  onToast,
  activeTag,
  onTagClick,
  processStatus,
  mtime,
  portStatus,
  gitStatus,
  botStatus,
  onBotToggle,
}: {
  project: ResolvedProject;
  featured: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  open: boolean;
  onToggle: () => void;
  overridesApi: ReturnType<typeof useOverrides>;
  password?: AccessPassword;
  passwordsLoaded: boolean;
  onSavePassword: (
    projectId: string,
    password: string,
    label: string | null,
  ) => Promise<void>;
  onDeletePassword: (projectId: string) => Promise<void>;
  onOpenInClaude: () => void;
  onOpenInDesktop: () => void;
  onToast: (kind: "ok" | "error", text: string, ms?: number) => void;
  activeTag: string | null;
  onTagClick: (tag: string) => void;
  processStatus?: ProcessStatusResult;
  mtime?: ProjectMtimeEntry;
  portStatus?: PortStatusEntry;
  gitStatus?: GitStatusEntry;
  botStatus: Record<string, BotStatus>;
  onBotToggle: (
    bot: { id: string; path: string; name: string },
    turnOn: boolean,
  ) => void;
}) {
  const hasSubs = (p.subRoutes?.length ?? 0) > 0;
  const [copied, setCopied] = useState<string | null>(null);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const cardRef = useRef<HTMLElement>(null);

  const health = computeHealth(p, { processStatus, mtime, portStatus, gitStatus });

  const submitTag = () => {
    const clean = tagDraft.trim();
    if (clean) overridesApi.addTag(p.id, clean);
    setTagDraft("");
    setAddingTag(false);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  const localCount = p.connections.filter((c) => c.kind === "local").length;
  const deployedCount = p.connections.filter(
    (c) => c.kind === "deployed",
  ).length;
  const connSummary = [
    localCount > 0 && `${localCount} local`,
    deployedCount > 0 && `${deployedCount} deployed`,
  ]
    .filter(Boolean)
    .join(" · ");

  const deployedBase = p.connections.find((c) => c.kind === "deployed")?.url;
  const localBase = p.connections.find((c) => c.kind === "local")?.url;
  const subBase = deployedBase ?? localBase;

  return (
    <article
      ref={cardRef}
      onMouseMove={handleMouseMove}
      className={`card ${p.status} ${p.hasOverrides ? "edited" : ""} ${
        featured ? "featured" : ""
      }`}
    >
      <span className="card-spotlight" aria-hidden />

      <header className="card-top">
        <div>
          <h3 className="card-title">{p.name}</h3>
          <p className="card-path">{p.dir.replace(/^\/(Users|home)\/[^/]+\//, "~/")}</p>
        </div>
        <div className="card-top-badges">
          <button
            className={`pin-btn ${pinned ? "pinned" : ""}`}
            onClick={onTogglePin}
            title={pinned ? "Unpin from top" : "Pin to top"}
            aria-label={pinned ? "Unpin project" : "Pin project"}
          >
            {pinned ? "★" : "☆"}
          </button>
          <span
            className={`health-pill health-${health.level}`}
            title={health.tooltip}
            aria-label={`Health: ${health.level}`}
          >
            <span className="health-dot" />
            {health.signals[0] ?? health.level}
          </span>
          {p.processCheck && (
            <ProcessStatusBadge
              check={p.processCheck}
              status={processStatus}
            />
          )}
          <span className={`badge ${p.status}`}>{p.status}</span>
        </div>
      </header>

      <div className="card-meta">
        <span className="stack-pill">{p.stack}</span>
        <button
          className="ghost-btn primary claude-btn"
          onClick={onOpenInClaude}
          title={`Open a new Terminal in ${p.dir} and start claude`}
        >
          <span className="claude-glyph" aria-hidden>
            ◈
          </span>
          Open in Claude
        </button>
        <button
          className="ghost-btn desktop-btn"
          onClick={onOpenInDesktop}
          title={`Run claude in ${p.dir} inside the ProjectDashboard desktop app`}
        >
          <span className="desktop-glyph" aria-hidden>
            ▣
          </span>
          Desktop
        </button>
        {p.hasOverrides && (
          <button
            className="ghost-btn"
            onClick={() => overridesApi.resetProject(p.id)}
            title="Reset local label overrides for this project"
          >
            reset labels
          </button>
        )}
      </div>

      {p.description && <p className="card-desc">{p.description}</p>}

      {p.connections.length > 0 && (
        <section className="field">
          <div className="field-head">
            <span className="field-label">Connections</span>
            <span className="field-meta">{connSummary}</span>
          </div>
          {p.connections.map((c) => (
            <ConnectionRow
              key={`${c.index}-${c.originalUrl}`}
              conn={c}
              copied={copied === c.url}
              onCopy={() => copy(c.url)}
              onSave={(nextUrl) =>
                overridesApi.setConnectionUrl(p.id, c.index, nextUrl)
              }
              onReset={() => overridesApi.clearConnection(p.id, c.index)}
              onToast={onToast}
            />
          ))}
        </section>
      )}

      {hasSubs && (
        <section className="field">
          <button
            className="sub-toggle"
            onClick={onToggle}
            aria-expanded={open}
          >
            <span>
              {p.subRoutes!.length} sub-route
              {p.subRoutes!.length === 1 ? "" : "s"}
            </span>
            <span className={`caret ${open ? "open" : ""}`} aria-hidden>
              ›
            </span>
          </button>
          {open && (
            <div className="sub-list">
              {p.subRoutes!.map((s) => (
                <SubRouteRow
                  key={`${s.index}-${s.originalPath}`}
                  sub={s}
                  base={subBase}
                  onSavePath={(path) =>
                    overridesApi.setSubRoute(p.id, s.index, { path })
                  }
                  onReset={() => overridesApi.clearSubRoute(p.id, s.index)}
                  onToast={onToast}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {passwordsLoaded && (
        <section className="field">
          <div className="field-head">
            <span className="field-label">Access password</span>
            {password && (
              <span className="field-meta">{password.label ?? "Shared"}</span>
            )}
          </div>
          <AccessPasswordRow
            projectId={p.id}
            entry={password}
            onSave={onSavePassword}
            onDelete={onDeletePassword}
            onCopy={copy}
            copied={password ? copied === password.password : false}
            onToast={onToast}
          />
        </section>
      )}

      {(p.bots?.length ?? 0) > 0 && (
        <section className="field">
          <div className="field-head">
            <span className="field-label">Python bots</span>
            <span className="field-meta">
              {p.bots!.filter((b) => botStatus[b.id]?.running).length}/
              {p.bots!.length} running
            </span>
          </div>
          <div className="bot-list">
            {p.bots!.map((b) => {
              const st = botStatus[b.id];
              const running = !!st?.running;
              return (
                <div key={b.id} className={`bot-row ${running ? "running" : ""}`}>
                  <span
                    className={`bot-dot ${running ? "on" : "off"}`}
                    aria-hidden
                  />
                  <div className="bot-meta">
                    <span className="bot-name">{b.name}</span>
                    <span className="bot-path">{b.relativePath}</span>
                  </div>
                  <span className="bot-pid">
                    {running && st?.pid ? `pid ${st.pid}` : "stopped"}
                  </span>
                  <button
                    className={`ghost-btn bot-toggle ${running ? "stop" : "start"}`}
                    onClick={() =>
                      onBotToggle(
                        { id: b.id, path: b.path, name: b.name },
                        !running,
                      )
                    }
                    title={running ? "Stop bot (SIGTERM)" : "Start bot"}
                  >
                    {running ? "Stop" : "Start"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="tags">
        {p.tags.map((t) => {
          const isCustom = p.customTags.includes(t);
          const isActive = activeTag === t;
          return (
            <span
              key={t}
              className={`tag ${isActive ? "active" : ""} ${
                isCustom ? "custom" : ""
              }`}
            >
              <button
                className="tag-label"
                onClick={() => onTagClick(t)}
                title={
                  isActive
                    ? `Clear filter: ${t}`
                    : `Filter by ${t}`
                }
              >
                #{t}
              </button>
              {isCustom && (
                <button
                  className="tag-x"
                  onClick={() => overridesApi.removeTag(p.id, t)}
                  aria-label={`Remove tag ${t}`}
                  title="Remove custom tag"
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        {addingTag ? (
          <input
            className="tag-input"
            autoFocus
            value={tagDraft}
            placeholder="tag name"
            onChange={(e) => setTagDraft(e.target.value)}
            onBlur={submitTag}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTag();
              if (e.key === "Escape") {
                setTagDraft("");
                setAddingTag(false);
              }
            }}
            spellCheck={false}
          />
        ) : (
          <button
            className="tag tag-add"
            onClick={() => setAddingTag(true)}
            title="Add a custom tag"
          >
            + tag
          </button>
        )}
      </div>

      <div className="card-footer">
        {p.devCommand && p.devCommand !== "—" ? (
          <span>
            <kbd>
              {p.devCommand.length > 40
                ? p.devCommand.slice(0, 38) + "…"
                : p.devCommand}
            </kbd>
            {p.localPort && <>  :{p.localPort}</>}
          </span>
        ) : (
          <span>— no dev command —</span>
        )}
        <div className="card-footer-end">
          {mtime && (
            <span
              className={`mtime ${mtime.source}`}
              title={`${
                mtime.source === "git" ? "Last commit" : "Last file change"
              }: ${new Date(mtime.mtime).toLocaleString()}`}
            >
              {mtime.source === "git" ? "⎇" : "◔"} {formatAgo(mtime.mtime)}
            </span>
          )}
          {p.gitRemote ? (
            <a
              className="git-link"
              href={p.gitRemote}
              target="_blank"
              rel="noreferrer"
            >
              git ↗
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ProcessStatusBadge({
  check,
  status,
}: {
  check: ProcessCheck;
  status?: ProcessStatusResult;
}) {
  const loaded = status !== undefined;
  const running = loaded && status?.running === true;
  const cls = !loaded
    ? "process-badge loading"
    : running
      ? "process-badge running"
      : "process-badge stopped";
  const dotCls = running ? "process-dot running" : "process-dot stopped";
  const label = !loaded
    ? "checking…"
    : running
      ? "running"
      : "stopped";
  const title = !loaded
    ? `Checking ${check.kind} ${check.pattern}…`
    : running
      ? `Running (${check.kind}: ${check.pattern}${
          status?.pid ? ` · pid ${status.pid}` : ""
        })`
      : `Not running (${check.kind}: ${check.pattern})`;
  return (
    <span className={cls} title={title}>
      <span className={dotCls} aria-hidden />
      {label}
    </span>
  );
}

function ConnectionRow({
  conn,
  copied,
  onCopy,
  onSave,
  onReset,
  onToast,
}: {
  conn: ResolvedConnection;
  copied: boolean;
  onCopy: () => void;
  onSave: (url: string) => void;
  onReset: () => void;
  onToast: (kind: "ok" | "error", text: string, ms?: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conn.url);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  const begin = () => {
    setDraft(conn.url);
    setStatus({ kind: "idle" });
    setEditing(true);
  };
  const cancel = () => {
    setDraft(conn.url);
    setStatus({ kind: "idle" });
    setEditing(false);
  };
  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed === conn.url) {
      setEditing(false);
      return;
    }
    onSave(trimmed);
    setEditing(false);
  };

  const busy = status.kind === "saving";
  const rowClass = [
    "conn-row",
    conn.kind,
    conn.edited ? "edited" : "",
    busy ? "busy" : "",
    status.kind === "error" ? "error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClass}>
      <span className={`conn-dot ${conn.kind}`} aria-hidden />
      <span className="conn-label">{conn.label}</span>

      {editing ? (
        <input
          className="inline-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          disabled={busy}
          spellCheck={false}
        />
      ) : conn.url.startsWith("http") ? (
        <a
          className="conn-url"
          href={conn.url}
          target="_blank"
          rel="noreferrer"
          title={conn.edited ? `Edited from ${conn.originalUrl}` : conn.url}
        >
          {conn.url}
          {conn.edited && <span className="edited-dot" aria-hidden />}
        </a>
      ) : (
        <span className="conn-url" title={conn.url}>
          {conn.url}
        </span>
      )}

      {editing ? (
        <>
          {busy ? (
            <span className="status-inline">{status.label}…</span>
          ) : status.kind === "error" ? (
            <>
              <span className="status-inline err" title={status.message}>
                error
              </span>
              <button className="ghost-btn primary" onClick={save}>
                Retry
              </button>
              <button className="ghost-btn" onClick={cancel}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="ghost-btn primary" onClick={save}>
                Save
              </button>
              <button className="ghost-btn" onClick={cancel}>
                Cancel
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <button
            className={`icon-btn ${copied ? "ok" : ""}`}
            onClick={onCopy}
            aria-label="Copy URL"
            title="Copy"
          >
            {copied ? "✓" : "⧉"}
          </button>
          <button
            className="icon-btn"
            onClick={begin}
            aria-label="Edit URL"
            title="Edit"
          >
            ✎
          </button>
          {conn.edited && (
            <button
              className="icon-btn danger"
              onClick={onReset}
              title={`Reset to ${conn.originalUrl}`}
              aria-label="Reset"
            >
              ↺
            </button>
          )}
        </>
      )}
    </div>
  );
}

function SubRouteRow({
  sub,
  base,
  onSavePath,
  onReset,
  onToast,
}: {
  sub: ResolvedSubRoute;
  base?: string;
  onSavePath: (path: string) => void;
  onReset: () => void;
  onToast: (kind: "ok" | "error", text: string, ms?: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sub.path);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  const begin = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraft(sub.path);
    setStatus({ kind: "idle" });
    setEditing(true);
  };
  const cancel = () => {
    setDraft(sub.path);
    setStatus({ kind: "idle" });
    setEditing(false);
  };
  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const normalized = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
    if (normalized === sub.path) {
      setEditing(false);
      return;
    }
    const slug = normalized.replace(/^\//, "");
    if (!SAFE_SLUG_RE.test(slug)) {
      const msg = "Path must match [a-z0-9_-] (no subdirs).";
      setStatus({ kind: "error", message: msg });
      onToast("error", msg, 5000);
      return;
    }

    onSavePath(normalized);
    setEditing(false);
  };

  const href = base ? `${base.replace(/\/$/, "")}${sub.path}` : undefined;
  const isLink = !!href && (href.startsWith("http") || href.startsWith("/"));
  const busy = status.kind === "saving";

  const inner = (
    <>
      {editing ? (
        <input
          className="inline-edit small"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          onClick={(e) => e.preventDefault()}
          disabled={busy}
          spellCheck={false}
        />
      ) : (
        <span className="sub-path">
          {sub.path}
          {sub.edited && <span className="edited-dot" aria-hidden />}
        </span>
      )}
      <span className="sub-name">{sub.name}</span>
      {sub.description && !editing && (
        <span className="sub-desc">{sub.description}</span>
      )}

      {editing ? (
        <span className="sub-actions">
          {busy ? (
            <span className="status-inline">working…</span>
          ) : status.kind === "error" ? (
            <>
              <span className="status-inline err" title={status.message}>
                error
              </span>
              <button
                className="ghost-btn primary"
                onClick={(e) => {
                  e.preventDefault();
                  save();
                }}
              >
                Retry
              </button>
              <button
                className="ghost-btn"
                onClick={(e) => {
                  e.preventDefault();
                  cancel();
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="ghost-btn primary"
                onClick={(e) => {
                  e.preventDefault();
                  save();
                }}
                title="Save label"
              >
                Save
              </button>
              <button
                className="ghost-btn"
                onClick={(e) => {
                  e.preventDefault();
                  cancel();
                }}
              >
                Cancel
              </button>
            </>
          )}
        </span>
      ) : (
        <span className="sub-actions">
          <button
            className="icon-btn"
            onClick={begin}
            aria-label="Edit path"
            title="Edit label"
          >
            ✎
          </button>
          {sub.edited && (
            <button
              className="icon-btn danger"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onReset();
              }}
              title={`Reset to ${sub.originalPath}`}
              aria-label="Reset"
            >
              ↺
            </button>
          )}
        </span>
      )}
    </>
  );

  const rowClass = [
    "sub-row",
    sub.edited ? "edited" : "",
    busy ? "busy" : "",
    status.kind === "error" ? "error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (editing || !isLink) {
    return <div className={rowClass}>{inner}</div>;
  }

  return (
    <a className={rowClass} href={href} target="_blank" rel="noreferrer">
      {inner}
    </a>
  );
}

function AccessPasswordRow({
  projectId,
  entry,
  onSave,
  onDelete,
  onCopy,
  copied,
  onToast,
}: {
  projectId: string;
  entry?: AccessPassword;
  onSave: (
    projectId: string,
    password: string,
    label: string | null,
  ) => Promise<void>;
  onDelete: (projectId: string) => Promise<void>;
  onCopy: (value: string) => Promise<void>;
  copied: boolean;
  onToast: (kind: "ok" | "error", text: string, ms?: number) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [revealed, setRevealed] = useState(false);
  const [draftPassword, setDraftPassword] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const begin = () => {
    setDraftPassword(entry?.password ?? "");
    setDraftLabel(entry?.label ?? "");
    setMode("edit");
  };
  const cancel = () => {
    setMode("view");
    setDraftPassword("");
    setDraftLabel("");
  };
  const save = async () => {
    if (!draftPassword.trim()) return;
    setBusy(true);
    try {
      await onSave(projectId, draftPassword, draftLabel.trim() || null);
      onToast("ok", `Saved access password for ${projectId}.`);
      setMode("view");
      setRevealed(false);
    } catch (e) {
      onToast("error", `Save failed: ${(e as Error).message}`, 6000);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm("Remove this access password?")) return;
    setBusy(true);
    try {
      await onDelete(projectId);
      onToast("ok", `Cleared access password for ${projectId}.`);
      setMode("view");
    } catch (e) {
      onToast("error", `Remove failed: ${(e as Error).message}`, 6000);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "edit") {
    return (
      <div className="password-row">
        <span className="password-icon" aria-hidden>
          🔒
        </span>
        <input
          className="inline-edit"
          autoFocus
          value={draftPassword}
          placeholder="password"
          onChange={(e) => setDraftPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          disabled={busy}
          spellCheck={false}
        />
        <input
          className="inline-edit small"
          value={draftLabel}
          placeholder="label (optional)"
          onChange={(e) => setDraftLabel(e.target.value)}
          disabled={busy}
          style={{ maxWidth: 160 }}
        />
        <button className="ghost-btn primary" onClick={save} disabled={busy}>
          {busy ? "…" : "Save"}
        </button>
        <button className="ghost-btn" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  if (!entry) {
    return (
      <button
        className="ghost-btn subtle"
        onClick={begin}
        style={{ width: "100%", height: 36 }}
      >
        + Add access password
      </button>
    );
  }

  const display = revealed ? entry.password : "•".repeat(Math.max(entry.password.length, 6));

  return (
    <div className="password-row">
      <span className="password-icon" aria-hidden>
        🔒
      </span>
      <span className={`password-value ${revealed ? "" : "masked"}`}>
        {display}
      </span>
      <button
        className="icon-btn"
        onClick={() => setRevealed((r) => !r)}
        title={revealed ? "Hide" : "Reveal"}
        aria-label={revealed ? "Hide password" : "Reveal password"}
      >
        {revealed ? "⊘" : "◉"}
      </button>
      <button
        className={`icon-btn ${copied ? "ok" : ""}`}
        onClick={() => onCopy(entry.password)}
        title="Copy password"
        aria-label="Copy password"
      >
        {copied ? "✓" : "⧉"}
      </button>
      <button
        className="icon-btn"
        onClick={begin}
        title="Edit password"
        aria-label="Edit password"
      >
        ✎
      </button>
      <button
        className="icon-btn danger"
        onClick={remove}
        title="Remove password"
        aria-label="Remove password"
      >
        ×
      </button>
    </div>
  );
}
