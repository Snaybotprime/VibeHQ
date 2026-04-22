import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { produce } from "immer";
import type { ScannedProject } from "./api";

export type LeafNode = {
  kind: "leaf";
  paneId: string;
  cwd: string;
  cmd?: string;
};

export type SplitNode = {
  kind: "split";
  direction: "h" | "v";
  ratio: number;
  a: PaneNode;
  b: PaneNode;
};

export type PaneNode = LeafNode | SplitNode;

export type PermissionMode = "default" | "auto" | "bypass";

export type Tab = {
  id: string;
  title: string;
  cwd: string;
  cmd?: string;
  createdAt: number;
  layout: PaneNode;
  focusedPaneId: string;
  permissionMode?: PermissionMode;
};

type PersistedShape = {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarOpen: boolean;
  selectedProjectId: string | null;
  manualProjectDirs: string[];
  hiddenProjectDirs: string[];
};

type TransientShape = {
  projects: ScannedProject[];
  attentionPaneIds: Record<string, true>;
};

type TabActions = {
  newTab: (init?: {
    cwd?: string;
    cmd?: string;
    title?: string;
  }) => string;
  closeTab: (id: string) => "ok" | "last";
  activate: (id: string) => void;
  cycle: (delta: 1 | -1) => void;
  jumpTo: (index: number) => void;
  rename: (id: string, title: string) => void;
  reorder: (from: number, to: number) => void;
  setPermissionMode: (id: string, mode: PermissionMode) => void;

  // Pane operations within a tab
  splitPane: (
    tabId: string,
    paneId: string,
    direction: "h" | "v",
  ) => string | null;
  closePane: (tabId: string, paneId: string) => "ok" | "closed-tab";
  focusPane: (tabId: string, paneId: string) => void;
  setSplitRatio: (tabId: string, path: number[], ratio: number) => void;

  // Sidebar / projects
  setProjects: (projects: ScannedProject[]) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  selectProject: (projectId: string | null) => void;
  addManualProject: (dir: string) => { ok: true; id: string } | { ok: false; error: string };
  removeProjectFromHQ: (id: string) => void;

  // Attention (BEL from claude / other tools)
  markAttention: (paneId: string) => void;
  clearAttention: (paneId: string) => void;
  clearAttentionForTab: (tabId: string) => void;

  resetForTesting: () => void;
};

export type TabStore = PersistedShape & TransientShape & TabActions;

const HOME = typeof window !== "undefined" ? window.hq.app.homedir : "/";

function genId(prefix = "t"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function manualProjectId(dir: string): string {
  // Stable, collision-free within manual set; used as ScannedProject.id.
  let hash = 0;
  for (let i = 0; i < dir.length; i++) {
    hash = (hash * 31 + dir.charCodeAt(i)) | 0;
  }
  return `manual-${(hash >>> 0).toString(36)}`;
}

function makeManualProject(dir: string): ScannedProject {
  const base = dir.replace(/\/+$/, "").split("/").pop() ?? dir;
  return {
    id: manualProjectId(dir),
    name: base || dir,
    dir,
    stack: "Manual",
    description: "",
    devCommand: "",
    localPort: null,
    gitRemote: null,
    status: "active",
    tags: ["manual"],
  };
}

function computeProjects(
  scanned: ScannedProject[],
  manualDirs: string[],
  hiddenDirs: string[],
): ScannedProject[] {
  const hidden = new Set(hiddenDirs);
  const visibleScanned = scanned.filter((p) => !hidden.has(p.dir));
  const visibleScannedDirs = new Set(visibleScanned.map((p) => p.dir));
  const extras = manualDirs
    .filter((d) => !hidden.has(d) && !visibleScannedDirs.has(d))
    .map(makeManualProject);
  return [...visibleScanned, ...extras];
}

function defaultTitle(cwd: string, cmd: string | undefined, name?: string): string {
  if (name) return name;
  if (cmd) return cmd.split(/\s+/)[0];
  const base = cwd.replace(/\/+$/, "").split("/").pop() ?? cwd;
  return base || "~";
}

// ---- Tree helpers ----
export function findLeaf(node: PaneNode, paneId: string): LeafNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId);
}

export function collectLeaves(node: PaneNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  return [...collectLeaves(node.a), ...collectLeaves(node.b)];
}

function replaceLeaf(
  node: PaneNode,
  paneId: string,
  replacement: PaneNode,
): PaneNode {
  if (node.kind === "leaf")
    return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    a: replaceLeaf(node.a, paneId, replacement),
    b: replaceLeaf(node.b, paneId, replacement),
  };
}

function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

function firstLeafPaneId(node: PaneNode): string {
  if (node.kind === "leaf") return node.paneId;
  return firstLeafPaneId(node.a);
}

// ---- Store ----
export const useTabs = create<TabStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      sidebarOpen: true,
      selectedProjectId: null,
      manualProjectDirs: [],
      hiddenProjectDirs: [],
      projects: [],
      attentionPaneIds: {},

      newTab: (init) => {
        const id = genId("t");
        const cwd = init?.cwd ?? HOME;
        const cmd = init?.cmd;
        // Resolve title preference order:
        //   1. explicit title passed in
        //   2. matching project's name (deepest dir prefix)
        //   3. cmd's first word
        //   4. cwd basename
        let title = init?.title;
        if (!title) {
          const projs = get().projects;
          let best: { name: string; depth: number } | null = null;
          for (const p of projs) {
            if (cwd === p.dir || cwd.startsWith(p.dir + "/")) {
              const depth = p.dir.length;
              if (!best || depth > best.depth) best = { name: p.name, depth };
            }
          }
          if (best) title = best.name;
        }
        if (!title) title = defaultTitle(cwd, cmd);
        const paneId = genId("p");
        set(
          produce((s: PersistedShape) => {
            s.tabs.push({
              id,
              title,
              cwd,
              cmd,
              createdAt: Date.now(),
              layout: { kind: "leaf", paneId, cwd, cmd },
              focusedPaneId: paneId,
            });
            s.activeTabId = id;
          }),
        );
        return id;
      },

      closeTab: (id) => {
        const cur = get();
        const idx = cur.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return "ok";
        const isLast = cur.tabs.length === 1;
        set(
          produce((s: PersistedShape) => {
            s.tabs.splice(idx, 1);
            if (s.activeTabId === id) {
              const next = s.tabs[idx] ?? s.tabs[idx - 1] ?? null;
              s.activeTabId = next ? next.id : null;
            }
          }),
        );
        return isLast ? "last" : "ok";
      },

      activate: (id) =>
        set((s) => (s.tabs.some((t) => t.id === id) ? { activeTabId: id } : s)),

      cycle: (delta) => {
        const { tabs, activeTabId } = get();
        if (tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx === -1) {
          set({ activeTabId: tabs[0].id });
          return;
        }
        const next = (idx + delta + tabs.length) % tabs.length;
        set({ activeTabId: tabs[next].id });
      },

      jumpTo: (index) => {
        const { tabs } = get();
        const t = tabs[index];
        if (t) set({ activeTabId: t.id });
      },

      rename: (id, title) =>
        set(
          produce((s: PersistedShape) => {
            const t = s.tabs.find((t) => t.id === id);
            if (t) t.title = title.trim() || t.title;
          }),
        ),

      reorder: (from, to) =>
        set(
          produce((s: PersistedShape) => {
            if (
              from < 0 ||
              to < 0 ||
              from >= s.tabs.length ||
              to >= s.tabs.length ||
              from === to
            )
              return;
            const [moved] = s.tabs.splice(from, 1);
            s.tabs.splice(to, 0, moved);
          }),
        ),

      setPermissionMode: (id, mode) =>
        set(
          produce((s: PersistedShape) => {
            const t = s.tabs.find((t) => t.id === id);
            if (!t) return;
            t.permissionMode = mode === "default" ? undefined : mode;
          }),
        ),

      splitPane: (tabId, paneId, direction) => {
        const cur = get().tabs.find((t) => t.id === tabId);
        if (!cur) return null;
        const leaf = findLeaf(cur.layout, paneId);
        if (!leaf) return null;
        const newPaneId = genId("p");
        set(
          produce((s: PersistedShape) => {
            const t = s.tabs.find((x) => x.id === tabId);
            if (!t) return;
            const newLeaf: LeafNode = {
              kind: "leaf",
              paneId: newPaneId,
              // Inherit cwd from the split source; no command runs in the new pane.
              cwd: leaf.cwd,
            };
            const split: SplitNode = {
              kind: "split",
              direction,
              ratio: 0.5,
              a: { ...leaf },
              b: newLeaf,
            };
            t.layout = replaceLeaf(t.layout, paneId, split);
            t.focusedPaneId = newPaneId;
          }),
        );
        return newPaneId;
      },

      closePane: (tabId, paneId) => {
        const cur = get().tabs.find((t) => t.id === tabId);
        if (!cur) return "ok";
        const nextLayout = removeLeaf(cur.layout, paneId);
        if (nextLayout === null) {
          // No panes left — close the tab.
          const r = get().closeTab(tabId);
          return r === "last" ? "closed-tab" : "closed-tab";
        }
        set(
          produce((s: PersistedShape) => {
            const t = s.tabs.find((x) => x.id === tabId);
            if (!t) return;
            t.layout = nextLayout;
            if (t.focusedPaneId === paneId) {
              t.focusedPaneId = firstLeafPaneId(nextLayout);
            }
          }),
        );
        return "ok";
      },

      focusPane: (tabId, paneId) =>
        set(
          produce((s: PersistedShape) => {
            const t = s.tabs.find((x) => x.id === tabId);
            if (!t) return;
            if (findLeaf(t.layout, paneId)) t.focusedPaneId = paneId;
          }),
        ),

      setSplitRatio: (tabId, path, ratio) =>
        set(
          produce((s: PersistedShape) => {
            const t = s.tabs.find((x) => x.id === tabId);
            if (!t) return;
            let node: PaneNode = t.layout;
            for (let i = 0; i < path.length - 1; i++) {
              if (node.kind !== "split") return;
              node = path[i] === 0 ? node.a : node.b;
            }
            if (node.kind === "split") node.ratio = ratio;
          }),
        ),

      setProjects: (projects) =>
        set((s) => ({
          projects: computeProjects(projects, s.manualProjectDirs, s.hiddenProjectDirs),
        })),

      addManualProject: (dir) => {
        const resolved = dir.replace(/\/+$/, "");
        if (!resolved) return { ok: false, error: "empty path" };
        const state = get();
        // If previously hidden, un-hide so it shows up again.
        const nextHidden = state.hiddenProjectDirs.filter((d) => d !== resolved);
        const nextManual = state.manualProjectDirs.includes(resolved)
          ? state.manualProjectDirs
          : [...state.manualProjectDirs, resolved];
        const scanned = state.projects.filter((p) => !p.tags.includes("manual"));
        set({
          manualProjectDirs: nextManual,
          hiddenProjectDirs: nextHidden,
          projects: computeProjects(scanned, nextManual, nextHidden),
        });
        return { ok: true, id: manualProjectId(resolved) };
      },

      removeProjectFromHQ: (id) => {
        const state = get();
        const target = state.projects.find((p) => p.id === id);
        if (!target) return;
        const isManual = target.tags.includes("manual");
        const nextManual = isManual
          ? state.manualProjectDirs.filter((d) => d !== target.dir)
          : state.manualProjectDirs;
        const nextHidden = state.hiddenProjectDirs.includes(target.dir)
          ? state.hiddenProjectDirs
          : [...state.hiddenProjectDirs, target.dir];
        const scanned = state.projects.filter((p) => !p.tags.includes("manual"));
        set({
          manualProjectDirs: nextManual,
          hiddenProjectDirs: nextHidden,
          projects: computeProjects(scanned, nextManual, nextHidden),
          selectedProjectId:
            state.selectedProjectId === id ? null : state.selectedProjectId,
        });
      },

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      selectProject: (projectId) =>
        set((s) => {
          if (!projectId) return { selectedProjectId: null };
          const proj = s.projects.find((p) => p.id === projectId);
          if (!proj) return { selectedProjectId: projectId };
          const firstMatch = s.tabs.find(
            (t) =>
              t.cwd === proj.dir || t.cwd.startsWith(proj.dir + "/"),
          );
          return {
            selectedProjectId: projectId,
            activeTabId: firstMatch ? firstMatch.id : s.activeTabId,
          };
        }),

      markAttention: (paneId) =>
        set((s) =>
          s.attentionPaneIds[paneId]
            ? s
            : { attentionPaneIds: { ...s.attentionPaneIds, [paneId]: true } },
        ),

      clearAttention: (paneId) =>
        set((s) => {
          if (!s.attentionPaneIds[paneId]) return s;
          const { [paneId]: _, ...rest } = s.attentionPaneIds;
          return { attentionPaneIds: rest };
        }),

      clearAttentionForTab: (tabId) =>
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (!tab) return s;
          const leaves = collectLeaves(tab.layout);
          const next = { ...s.attentionPaneIds };
          let changed = false;
          for (const l of leaves) {
            if (next[l.paneId]) {
              delete next[l.paneId];
              changed = true;
            }
          }
          return changed ? { attentionPaneIds: next } : s;
        }),

      resetForTesting: () =>
        set({
          tabs: [],
          activeTabId: null,
          sidebarOpen: true,
          selectedProjectId: null,
          manualProjectDirs: [],
          hiddenProjectDirs: [],
          projects: [],
          attentionPaneIds: {},
        }),
    }),
    {
      name: "hq.tabs.v2",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): PersistedShape => ({
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        sidebarOpen: s.sidebarOpen,
        selectedProjectId: s.selectedProjectId,
        manualProjectDirs: s.manualProjectDirs,
        hiddenProjectDirs: s.hiddenProjectDirs,
      }),
      // Drop any v1 persisted state — tab shape is incompatible.
      migrate: () => ({
        tabs: [],
        activeTabId: null,
        sidebarOpen: true,
        selectedProjectId: null,
        manualProjectDirs: [],
        hiddenProjectDirs: [],
      }),
      onRehydrateStorage: () => (state) => {
        if (state && state.manualProjectDirs.length > 0) {
          state.projects = computeProjects(
            [],
            state.manualProjectDirs,
            state.hiddenProjectDirs,
          );
        }
      },
    },
  ),
);

export function ensureInitialTab(): void {
  const { tabs, newTab } = useTabs.getState();
  if (tabs.length === 0) newTab();
}

// Used by the App to collect all live pane ids across all tabs — e.g. for fg polling.
export function collectAllPaneIds(tabs: Tab[]): string[] {
  const ids: string[] = [];
  for (const t of tabs) {
    for (const l of collectLeaves(t.layout)) ids.push(l.paneId);
  }
  return ids;
}

/**
 * A tab "belongs" to a project if the tab's primary cwd equals the project's
 * dir or is a descendant of it. Uses a path-prefix check (with trailing sep
 * so "/a/foo" doesn't match a project at "/a/f").
 */
export function tabMatchesProject(tab: Tab, project: ScannedProject): boolean {
  if (tab.cwd === project.dir) return true;
  return tab.cwd.startsWith(project.dir + "/");
}

export function findProjectForTab(
  tab: Tab,
  projects: ScannedProject[],
): ScannedProject | null {
  // Prefer the deepest-matching project (longest dir prefix).
  let best: ScannedProject | null = null;
  for (const p of projects) {
    if (tabMatchesProject(tab, p)) {
      if (!best || p.dir.length > best.dir.length) best = p;
    }
  }
  return best;
}
