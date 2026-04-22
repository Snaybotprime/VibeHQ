import { useEffect, useRef, useState } from "react";
import { TabBar } from "./TabBar";
import { PaneTree } from "./PaneTree";
import { Sidebar } from "./Sidebar";
import {
  collectAllPaneIds,
  ensureInitialTab,
  findProjectForTab,
  useTabs,
} from "./store";
import { focusTerminal } from "./terminalRegistry";
import { fetchProjects } from "./api";

export default function App() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const newTab = useTabs((s) => s.newTab);
  const closeTab = useTabs((s) => s.closeTab);
  const cycle = useTabs((s) => s.cycle);
  const jumpTo = useTabs((s) => s.jumpTo);
  const splitPane = useTabs((s) => s.splitPane);
  const closePane = useTabs((s) => s.closePane);
  const focusPane = useTabs((s) => s.focusPane);

  const [fg, setFg] = useState<Record<string, string | undefined>>({});
  const [toast, setToast] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);
  const renameOnce = useRef<Set<string>>(new Set());
  // Tabs that have already been anchored to their project name. Prevents
  // the project-name enforcer from clobbering a user's manual rename
  // (since we only force the project name once per tab).
  const projectAnchored = useRef<Set<string>>(new Set());
  const projects = useTabs((s) => s.projects);
  const sidebarOpen = useTabs((s) => s.sidebarOpen);
  const toggleSidebar = useTabs((s) => s.toggleSidebar);
  const setProjects = useTabs((s) => s.setProjects);
  const selectedProjectId = useTabs((s) => s.selectedProjectId);
  const clearAttentionForTab = useTabs((s) => s.clearAttentionForTab);
  const attentionPaneIds = useTabs((s) => s.attentionPaneIds);

  useEffect(() => {
    ensureInitialTab();
  }, []);

  // Fetch projects from the web dashboard at :4321 on mount + every 60s.
  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      fetchProjects(ctrl.signal)
        .then(setProjects)
        .catch(() => {
          /* web dashboard may be down — keep last-known */
        });
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [setProjects]);

  // Clear attention for a tab when it becomes active.
  useEffect(() => {
    if (activeTabId) clearAttentionForTab(activeTabId);
  }, [activeTabId, clearAttentionForTab]);

  // Stop the browser from navigating away when a file is dropped outside a
  // TerminalPane. Pane-level drop handlers preventDefault themselves; this is
  // a safety net for drops on the sidebar, tab bar, gaps, etc.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const showToast = (kind: "ok" | "error", text: string) => {
    setToast({ kind, text });
  };

  // Imperative focus: whenever the active tab changes or its focused pane
  // changes, forcibly focus that terminal. Belt-and-braces over the effect
  // chain inside TerminalPane — Electron sometimes drops .focus() when the
  // window's OS-level focus is still settling from a fresh app:open-project.
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const focusedPaneId = activeTab?.focusedPaneId ?? null;
  useEffect(() => {
    if (!focusedPaneId) return;
    focusTerminal(focusedPaneId);
    // Retry once after another tick — fixes the "/open from browser" case
    // where the window is still gaining OS focus.
    const t = window.setTimeout(() => focusTerminal(focusedPaneId), 120);
    return () => window.clearTimeout(t);
  }, [activeTabId, focusedPaneId]);

  // When the OS-level window regains focus (user clicks Dock icon, window
  // foregrounded by /open, etc.), refocus the active terminal.
  useEffect(() => {
    const onWinFocus = () => {
      const st = useTabs.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (tab) focusTerminal(tab.focusedPaneId);
    };
    window.addEventListener("focus", onWinFocus);
    return () => window.removeEventListener("focus", onWinFocus);
  }, []);

  // Safety net: if a keystroke arrives and focus isn't on an xterm textarea
  // (e.g. the user clicked the titlebar), bounce focus back to the active
  // terminal. Doesn't replay the key — next one lands.
  //
  // Skip when focus is on a real editable control (modal inputs, tab-rename
  // input, etc.) — otherwise every keystroke would yank focus back into the
  // terminal and the user could only ever type one character.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae?.classList.contains("xterm-helper-textarea")) return;
      const tag = ae?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (ae?.isContentEditable) return;
      const st = useTabs.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (tab) focusTerminal(tab.focusedPaneId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // /open from the web dashboard → new tab
  useEffect(() => {
    const off = window.hq.app.onOpenProject(({ dir, cmd, name }) => {
      newTab({ cwd: dir, cmd, title: name });
    });
    return off;
  }, [newTab]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      const alt = e.altKey;
      const shift = e.shiftKey;

      // ⌘T — new tab
      if (e.key === "t" && !shift && !alt) {
        e.preventDefault();
        newTab();
        return;
      }

      // ⌘B — toggle sidebar
      if (e.key === "b" && !shift && !alt) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⌘W — close focused pane; if last pane in tab → closeTab; if last tab → close window
      if (e.key === "w" && !shift && !alt) {
        e.preventDefault();
        const st = useTabs.getState();
        const id = st.activeTabId;
        if (!id) {
          window.close();
          return;
        }
        const tab = st.tabs.find((t) => t.id === id);
        if (!tab) return;
        const result = closePane(id, tab.focusedPaneId);
        if (result === "closed-tab" && useTabs.getState().tabs.length === 0) {
          window.close();
        }
        return;
      }

      // ⌘⇧] / ⌘⇧[ — cycle tabs
      if (shift && (e.key === "]" || e.key === "}")) {
        e.preventDefault();
        cycle(1);
        return;
      }
      if (shift && (e.key === "[" || e.key === "{")) {
        e.preventDefault();
        cycle(-1);
        return;
      }

      // ⌘D — split vertical (left|right). ⌘⇧D — split horizontal (top|bottom).
      if (e.key.toLowerCase() === "d" && !alt) {
        e.preventDefault();
        const st = useTabs.getState();
        const id = st.activeTabId;
        if (!id) return;
        const tab = st.tabs.find((t) => t.id === id);
        if (!tab) return;
        const direction = shift ? "v" : "h";
        splitPane(id, tab.focusedPaneId, direction);
        return;
      }

      // ⌘⌥←↑→↓ — focus nav within current tab's split tree
      if (alt && !shift && e.key.startsWith("Arrow")) {
        e.preventDefault();
        focusNeighbor(
          e.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
          focusPane,
        );
        return;
      }

      // ⌘1..9 — jump tabs
      if (!shift && !alt && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number(e.key);
        const { tabs: cur } = useTabs.getState();
        if (n === 9) jumpTo(cur.length - 1);
        else jumpTo(n - 1);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    newTab,
    closeTab,
    closePane,
    cycle,
    jumpTo,
    splitPane,
    focusPane,
    toggleSidebar,
  ]);

  // Foreground process polling across every live pane in every tab.
  const allPaneIds = collectAllPaneIds(tabs);
  const paneIdsKey = allPaneIds.join("|");
  useEffect(() => {
    if (allPaneIds.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const results = await Promise.all(
        allPaneIds.map(async (paneId) => {
          try {
            const r = await window.hq.pty.fg({ paneId });
            return [paneId, r.ok ? r.name : undefined] as const;
          } catch {
            return [paneId, undefined] as const;
          }
        }),
      );
      if (cancelled) return;
      setFg((prev) => {
        const next: Record<string, string | undefined> = { ...prev };
        let changed = false;
        for (const [id, name] of results) {
          if (next[id] !== name) {
            next[id] = name;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    tick();
    const id = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneIdsKey]);

  // Enforce project-named tabs: when a tab's cwd is inside a known project,
  // anchor its title to the project name. This wins over fg-process
  // promotion and survives the race where projects load after the first
  // fg poll (which would previously clobber the project name to "claude"
  // because the basename of the cwd matched the title). Runs once per tab;
  // manual renames after the anchor stick because we never re-anchor.
  useEffect(() => {
    const { rename } = useTabs.getState();
    const projectNames = new Set(projects.map((p) => p.name));
    const findProject = (cwd: string): string | null => {
      let best: { name: string; depth: number } | null = null;
      for (const p of projects) {
        if (cwd === p.dir || cwd.startsWith(p.dir + "/")) {
          if (!best || p.dir.length > best.depth) {
            best = { name: p.name, depth: p.dir.length };
          }
        }
      }
      return best?.name ?? null;
    };
    for (const t of tabs) {
      const projName = findProject(t.cwd);
      if (projName && !projectAnchored.current.has(t.id)) {
        if (t.title !== projName) rename(t.id, projName);
        projectAnchored.current.add(t.id);
        renameOnce.current.add(t.id);
        continue;
      }
      if (projName) continue; // already anchored; manual renames stick.
      const proc = fg[t.focusedPaneId];
      if (!proc) continue;
      if (renameOnce.current.has(t.id)) continue;
      if (projectNames.has(t.title)) {
        renameOnce.current.add(t.id);
        continue;
      }
      const looksDefault =
        t.title === "~" ||
        t.title === t.cwd.split("/").pop() ||
        t.title === t.cmd?.split(/\s+/)[0];
      if (looksDefault && proc !== t.title && isInterestingProc(proc)) {
        rename(t.id, proc);
        renameOnce.current.add(t.id);
      }
    }
  }, [fg, tabs, projects]);

  // Tab pill shows the fg process of the tab's currently focused pane.
  const tabFg: Record<string, string | undefined> = {};
  for (const t of tabs) tabFg[t.id] = fg[t.focusedPaneId];

  void activeTab; // consumed implicitly via activeTabId in pane-slot render

  // Attention → Set of tab ids where any leaf pane has attention marked
  const attentionTabIds = new Set<string>();
  for (const t of tabs) {
    for (const id of collectAllPaneIds([t])) {
      if (attentionPaneIds[id]) {
        attentionTabIds.add(t.id);
        break;
      }
    }
  }

  // Filter tabs for the bar based on selected project.
  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;
  const visibleTabs = selectedProject
    ? tabs.filter(
        (t) =>
          t.cwd === selectedProject.dir ||
          t.cwd.startsWith(selectedProject.dir + "/"),
      )
    : tabs;

  void findProjectForTab; // helper is available for future use in the pane header

  return (
    <div className="relative flex h-screen w-screen flex-row overflow-hidden bg-surface-deep">
      <div className="bg-noise pointer-events-none absolute inset-0 z-0" />
      <div className="bg-blobs pointer-events-none absolute inset-0 z-0" />

      <Sidebar onToast={showToast} />

      <div
        className={`relative z-10 flex flex-1 flex-col overflow-hidden ${
          sidebarOpen ? "pd-shell-with-sidebar" : ""
        }`}
      >
        <TabBar fg={tabFg} tabs={visibleTabs} attentionTabIds={attentionTabIds} />

        <main className="relative flex-1 overflow-hidden">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`pane-slot ${t.id === activeTabId ? "active" : ""}`}
              aria-hidden={t.id !== activeTabId}
            >
              <PaneTree tab={t} isTabActive={t.id === activeTabId} fg={fg} />
            </div>
          ))}
        </main>
      </div>

      {toast && (
        <div className={`pd-toast pd-toast-${toast.kind}`} role="status">
          <span className="pd-toast-ico">
            {toast.kind === "ok" ? "✓" : "!"}
          </span>
          <span className="pd-toast-text">{toast.text}</span>
          <button className="pd-toast-close" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function isInterestingProc(name: string): boolean {
  const boring = new Set(["zsh", "bash", "fish", "sh", "-zsh", "-bash", "dash"]);
  return !boring.has(name);
}

function focusNeighbor(
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  focusPane: (tabId: string, paneId: string) => void,
) {
  const st = useTabs.getState();
  const tabId = st.activeTabId;
  if (!tabId) return;
  const tab = st.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Find all pane DOM elements for this tab.
  const slot = document.querySelector(
    `.pane-slot.active`,
  ) as HTMLElement | null;
  if (!slot) return;
  const panes = Array.from(
    slot.querySelectorAll<HTMLElement>("[data-pane-id]"),
  );
  if (panes.length < 2) return;

  const current = panes.find(
    (el) => el.dataset.paneId === tab.focusedPaneId,
  );
  if (!current) return;
  const cur = current.getBoundingClientRect();
  const curCx = cur.left + cur.width / 2;
  const curCy = cur.top + cur.height / 2;

  let best: { id: string; score: number } | null = null;
  for (const el of panes) {
    if (el === current) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - curCx;
    const dy = cy - curCy;

    let ok = false;
    let score = 0;
    if (key === "ArrowRight") {
      ok = dx > 10;
      score = dx + Math.abs(dy) * 2;
    } else if (key === "ArrowLeft") {
      ok = dx < -10;
      score = -dx + Math.abs(dy) * 2;
    } else if (key === "ArrowDown") {
      ok = dy > 10;
      score = dy + Math.abs(dx) * 2;
    } else {
      ok = dy < -10;
      score = -dy + Math.abs(dx) * 2;
    }
    if (!ok) continue;
    if (!best || score < best.score) {
      best = { id: el.dataset.paneId!, score };
    }
  }

  if (best) focusPane(tabId, best.id);
}
