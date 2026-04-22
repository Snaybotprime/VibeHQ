import { useEffect, useMemo, useRef, useState } from "react";
import { useTabs } from "./store";
import { fetchProjects, type ScannedProject } from "./api";
import { AgentModal } from "./AgentModal";
import type { AgentInfo } from "../../shared/ipc";

type ContextMenuState = {
  project: ScannedProject;
  x: number;
  y: number;
} | null;

type AgentModalState = {
  project: ScannedProject;
  scope: "global" | "project";
} | null;

export function Sidebar({
  onToast,
}: {
  onToast: (kind: "ok" | "error", text: string) => void;
}) {
  const tabs = useTabs((s) => s.tabs);
  const projects = useTabs((s) => s.projects);
  const selectedProjectId = useTabs((s) => s.selectedProjectId);
  const sidebarOpen = useTabs((s) => s.sidebarOpen);
  const selectProject = useTabs((s) => s.selectProject);
  const newTab = useTabs((s) => s.newTab);
  const splitPane = useTabs((s) => s.splitPane);
  const attentionPaneIds = useTabs((s) => s.attentionPaneIds);
  const addManualProject = useTabs((s) => s.addManualProject);
  const removeProjectFromHQ = useTabs((s) => s.removeProjectFromHQ);
  const setProjects = useTabs((s) => s.setProjects);

  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);

  const handleAddProject = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const result = await window.helix.actions.pickProjectDir();
      if (!result.ok) {
        if ("cancelled" in result) return;
        onToast("error", result.error);
        return;
      }
      const added = addManualProject(result.path);
      if (added.ok) {
        onToast("ok", `Added ${result.path.replace(/^\/Users\/[^/]+/, "~")}`);
      } else {
        onToast("error", added.error);
      }
    } finally {
      setAdding(false);
    }
  };

  const handleScanProjects = async () => {
    if (scanning) return;
    setScanning(true);
    const before = useTabs.getState().projects.length;
    try {
      const scanned = await fetchProjects();
      setProjects(scanned);
      const after = useTabs.getState().projects.length;
      const delta = after - before;
      const msg =
        delta > 0
          ? `Found ${after} project${after === 1 ? "" : "s"} (+${delta} new)`
          : `Found ${after} project${after === 1 ? "" : "s"}`;
      onToast("ok", msg);
    } catch (err) {
      onToast(
        "error",
        `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setScanning(false);
    }
  };

  const handleCreateProject = () => {
    // Open a tab in $HOME that prompts the user for a project name in the
    // shell, creates the folder, cds in, and launches claude. The typed name
    // never touches renderer code — it's consumed entirely by `read` in zsh.
    const script =
      'read "?Project name (under ~/): " __hqname && ' +
      '[ -n "$__hqname" ] && ' +
      'mkdir -p "$HOME/$__hqname" && ' +
      'cd "$HOME/$__hqname" && ' +
      "clear && claude";
    newTab({
      cwd: window.helix.app.homedir,
      cmd: script,
      title: "New project",
    });
  };

  const [menu, setMenu] = useState<ContextMenuState>(null);
  const [agentModal, setAgentModal] = useState<AgentModalState>(null);
  const [menuAgents, setMenuAgents] = useState<AgentInfo[] | null>(null);

  // Close menu on outside click / escape
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Fetch agents (global + project-scoped) whenever the menu opens.
  useEffect(() => {
    if (!menu) {
      setMenuAgents(null);
      return;
    }
    let cancelled = false;
    window.helix.actions
      .listAgents({ projectDir: menu.project.dir })
      .then((res) => {
        if (cancelled) return;
        setMenuAgents(res.ok ? res.agents : []);
      })
      .catch(() => {
        if (!cancelled) setMenuAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [menu]);

  // Tab-count & attention-count per project dir
  const stats = useMemo(() => {
    const byDir = new Map<string, { tabs: number; attention: number }>();
    for (const t of tabs) {
      // Find the deepest-matching project dir for this tab
      let match: string | null = null;
      for (const p of projects) {
        if (t.cwd === p.dir || t.cwd.startsWith(p.dir + "/")) {
          if (!match || p.dir.length > match.length) match = p.dir;
        }
      }
      if (!match) continue;
      const cur = byDir.get(match) ?? { tabs: 0, attention: 0 };
      cur.tabs += 1;
      // Tab has attention if any of its panes is attention-marked
      // (walk layout — but for perf we just check focusedPaneId)
      if (attentionPaneIds[t.focusedPaneId]) cur.attention += 1;
      byDir.set(match, cur);
    }
    return byDir;
  }, [tabs, projects, attentionPaneIds]);

  // Sorted projects: most tabs first, then name (stable, alphabetical).
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const ca = stats.get(a.dir)?.tabs ?? 0;
      const cb = stats.get(b.dir)?.tabs ?? 0;
      if (cb !== ca) return cb - ca;
      return a.name.localeCompare(b.name);
    });
  }, [projects, stats]);

  // Split into active (has tabs) and inactive (no tabs) buckets.
  const { activeProjects, inactiveProjects } = useMemo(() => {
    const a: typeof sortedProjects = [];
    const i: typeof sortedProjects = [];
    for (const p of sortedProjects) {
      const count = stats.get(p.dir)?.tabs ?? 0;
      if (count > 0) a.push(p);
      else i.push(p);
    }
    return { activeProjects: a, inactiveProjects: i };
  }, [sortedProjects, stats]);

  const [inactiveExpanded, setInactiveExpanded] = useState(false);

  const handleProjectClick = (p: ScannedProject) => {
    selectProject(p.id === selectedProjectId ? null : p.id);
  };

  // Used by inactive-row entries to distinguish single vs. double click.
  // A single click (selection toggle) is deferred briefly so a double click
  // (open-in-new-tab) can cancel it.
  const clickTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  const handleProjectRightClick = (
    e: React.MouseEvent,
    p: ScannedProject,
  ) => {
    e.preventDefault();
    setMenu({ project: p, x: e.clientX, y: e.clientY });
  };

  const openTabForProject = (p: ScannedProject) => {
    newTab({ cwd: p.dir, cmd: "claude", title: p.name });
    selectProject(p.id);
  };

  const openTabForProjectAllowBypass = (p: ScannedProject) => {
    newTab({
      cwd: p.dir,
      cmd: "claude --allow-dangerously-skip-permissions",
      title: p.name,
    });
    selectProject(p.id);
  };

  const launchAgentForProject = (p: ScannedProject, agent: AgentInfo) => {
    // Agent names are constrained to [a-z0-9_-]; still single-quote for safety.
    const msg = `Use the ${agent.name} subagent.`;
    const quoted = `'${msg.replace(/'/g, "'\\''")}'`;
    newTab({
      cwd: p.dir,
      cmd: `claude ${quoted}`,
      title: `${p.name} · ${agent.name}`,
    });
    selectProject(p.id);
  };

  const openSplitForProject = (p: ScannedProject) => {
    const st = useTabs.getState();
    if (!st.activeTabId) {
      openTabForProject(p);
      return;
    }
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab) return;
    const newId = splitPane(st.activeTabId, tab.focusedPaneId, "h");
    if (newId) {
      onToast(
        "ok",
        `Split pane created — start claude manually with ⌘⇧C or just type \`claude\`.`,
      );
    }
  };

  if (!sidebarOpen) return null;

  return (
    <>
      <aside className="pd-sidebar">
        <div className="pd-sidebar-head">
          <span className="pd-sidebar-title">Projects</span>
          <span className="pd-sidebar-count">{projects.length}</span>
        </div>

        <div className="pd-sidebar-list">
          <button
            className={`pd-sidebar-item all ${
              selectedProjectId === null ? "active" : ""
            }`}
            onClick={() => selectProject(null)}
          >
            <span className="pd-sidebar-dot all" />
            <span className="pd-sidebar-name">All tabs</span>
            <span className="pd-sidebar-badge">{tabs.length}</span>
          </button>

          {activeProjects.map((p) => {
            const s = stats.get(p.dir);
            const attn = (s?.attention ?? 0) > 0;
            return (
              <button
                key={p.id}
                className={`pd-sidebar-item ${
                  selectedProjectId === p.id ? "active" : ""
                } ${attn ? "attention" : ""}`}
                onClick={() => handleProjectClick(p)}
                onContextMenu={(e) => handleProjectRightClick(e, p)}
                title={p.dir}
              >
                <span className={`pd-sidebar-dot ${attn ? "attention" : ""}`} />
                <span className="pd-sidebar-name">{p.name}</span>
                {s && s.tabs > 0 && (
                  <span className="pd-sidebar-badge">{s.tabs}</span>
                )}
              </button>
            );
          })}

          {inactiveProjects.length > 0 && (
            <>
              <button
                className="pd-sidebar-section"
                onClick={() => setInactiveExpanded((v) => !v)}
                aria-expanded={inactiveExpanded}
              >
                <span
                  className={`pd-sidebar-caret ${
                    inactiveExpanded ? "open" : ""
                  }`}
                  aria-hidden
                >
                  ›
                </span>
                <span className="pd-sidebar-section-label">Inactive</span>
                <span className="pd-sidebar-badge subtle">
                  {inactiveProjects.length}
                </span>
              </button>

              {inactiveExpanded &&
                inactiveProjects.map((p) => (
                  <button
                    key={p.id}
                    className={`pd-sidebar-item inactive ${
                      selectedProjectId === p.id ? "active" : ""
                    }`}
                    onClick={() => {
                      if (clickTimerRef.current !== null) {
                        window.clearTimeout(clickTimerRef.current);
                      }
                      clickTimerRef.current = window.setTimeout(() => {
                        clickTimerRef.current = null;
                        handleProjectClick(p);
                      }, 220);
                    }}
                    onDoubleClick={() => {
                      if (clickTimerRef.current !== null) {
                        window.clearTimeout(clickTimerRef.current);
                        clickTimerRef.current = null;
                      }
                      openTabForProjectAllowBypass(p);
                    }}
                    onContextMenu={(e) => handleProjectRightClick(e, p)}
                    title={`${p.dir} — double-click to open in new tab`}
                  >
                    <span className="pd-sidebar-dot" />
                    <span className="pd-sidebar-name">{p.name}</span>
                  </button>
                ))}
            </>
          )}
        </div>

        <div className="pd-sidebar-foot">
          <button
            className="pd-sidebar-add"
            onClick={handleCreateProject}
            title="Open a new tab that prompts for a name and creates the folder"
          >
            <span aria-hidden>✦</span>
            <span>Create new project</span>
          </button>
          <button
            className="pd-sidebar-add"
            onClick={handleAddProject}
            disabled={adding}
            title="Add an existing project folder from Finder"
          >
            <span aria-hidden>+</span>
            <span>{adding ? "Adding…" : "Add project"}</span>
          </button>
          <button
            className="pd-sidebar-add"
            onClick={handleScanProjects}
            disabled={scanning}
            title="Rescan $HOME for project folders"
          >
            <span aria-hidden>⟳</span>
            <span>{scanning ? "Scanning…" : "Scan for projects"}</span>
          </button>
        </div>
      </aside>

      {menu && (
        <div
          className="pd-contextmenu"
          style={{ top: menu.y, left: menu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              openTabForProject(menu.project);
              setMenu(null);
            }}
          >
            Open in new tab
            <span className="pd-ctx-sub">claude in {tildePath(menu.project.dir)}</span>
          </button>
          <button
            onClick={() => {
              openTabForProjectAllowBypass(menu.project);
              setMenu(null);
            }}
          >
            Open in new tab (allow bypass)
            <span className="pd-ctx-sub">
              claude --allow-dangerously-skip-permissions
            </span>
          </button>
          <button
            onClick={() => {
              openSplitForProject(menu.project);
              setMenu(null);
            }}
          >
            Open in split pane
          </button>
          {menuAgents && menuAgents.length > 0 && (
            <>
              <div className="pd-ctx-sep" />
              <div className="pd-ctx-heading">Launch agent</div>
              {menuAgents.map((a) => (
                <button
                  key={a.path}
                  onClick={() => {
                    launchAgentForProject(menu.project, a);
                    setMenu(null);
                  }}
                  title={a.description || a.path}
                >
                  {a.name}
                  <span className="pd-ctx-sub">
                    {a.scope === "project" ? "this project" : "global"}
                    {a.description ? ` · ${a.description}` : ""}
                  </span>
                </button>
              ))}
            </>
          )}
          <div className="pd-ctx-sep" />
          <button
            onClick={() => {
              setAgentModal({ project: menu.project, scope: "global" });
              setMenu(null);
            }}
          >
            New agent (global)…
            <span className="pd-ctx-sub">~/.claude/agents/</span>
          </button>
          <button
            onClick={() => {
              setAgentModal({ project: menu.project, scope: "project" });
              setMenu(null);
            }}
          >
            New sub-agent (this project)…
            <span className="pd-ctx-sub">
              {tildePath(menu.project.dir)}/.claude/agents/
            </span>
          </button>
          <div className="pd-ctx-sep" />
          <button
            onClick={() => {
              window.helix.actions.clipboardWrite(menu.project.dir);
              onToast("ok", `Copied path: ${menu.project.dir}`);
              setMenu(null);
            }}
          >
            Copy path
          </button>
          <button
            onClick={() => {
              window.helix.actions.revealInFinder(menu.project.dir);
              setMenu(null);
            }}
          >
            Reveal in Finder
          </button>
          <div className="pd-ctx-sep" />
          <button
            className="danger"
            onClick={() => {
              removeProjectFromHQ(menu.project.id);
              onToast("ok", `Removed ${menu.project.name} from HQ`);
              setMenu(null);
            }}
          >
            Remove from HQ
            <span className="pd-ctx-sub">hides it; doesn't delete the folder</span>
          </button>
        </div>
      )}

      {agentModal && (
        <AgentModal
          project={agentModal.project}
          defaultScope={agentModal.scope}
          onClose={() => setAgentModal(null)}
          onToast={onToast}
        />
      )}
    </>
  );
}

function tildePath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}
