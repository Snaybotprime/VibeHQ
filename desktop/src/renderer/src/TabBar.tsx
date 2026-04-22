import { useEffect, useRef, useState } from "react";
import { useTabs, type PermissionMode, type Tab } from "./store";

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  auto: "Auto (safer)",
  bypass: "Dangerous · skip permissions",
};

const MODE_DESC: Record<PermissionMode, string> = {
  default: "Standard claude — prompts for each permission",
  auto: "claude --permission-mode auto (classifier-guarded)",
  bypass: "claude --dangerously-skip-permissions (no guardrails)",
};

function claudeCommandFor(mode: PermissionMode): string {
  switch (mode) {
    case "auto":
      return "claude --permission-mode auto";
    case "bypass":
      return "claude --dangerously-skip-permissions";
    case "default":
      return "claude";
  }
}

async function applyModeToTab(tab: Tab, mode: PermissionMode): Promise<void> {
  const paneId = tab.focusedPaneId;
  const api = window.helix;
  // Interrupt anything running, then type the new claude invocation.
  await api.pty.write({ paneId, data: "" });
  await new Promise((r) => setTimeout(r, 60));
  await api.pty.write({ paneId, data: `${claudeCommandFor(mode)}\r` });
}

type FgMap = Record<string, string | undefined>;

export function TabBar({
  fg,
  tabs,
  attentionTabIds,
}: {
  fg: FgMap;
  tabs: Tab[];
  attentionTabIds: Set<string>;
}) {
  const activeTabId = useTabs((s) => s.activeTabId);
  const newTab = useTabs((s) => s.newTab);
  const closeTab = useTabs((s) => s.closeTab);
  const activate = useTabs((s) => s.activate);
  const rename = useTabs((s) => s.rename);
  const reorder = useTabs((s) => s.reorder);
  const setPermissionMode = useTabs((s) => s.setPermissionMode);

  const [ctxMenu, setCtxMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu]);

  const handleClose = (id: string) => {
    const result = closeTab(id);
    if (result === "last") {
      window.close();
    }
  };

  const handlePickMode = async (tabId: string, mode: PermissionMode) => {
    setCtxMenu(null);
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    setPermissionMode(tabId, mode);
    try {
      await applyModeToTab(tab, mode);
    } catch {
      /* pty may not be alive yet — flag still stored */
    }
  };

  const menuTab = ctxMenu ? tabs.find((t) => t.id === ctxMenu.tabId) : null;
  const currentMode: PermissionMode = menuTab?.permissionMode ?? "default";

  return (
    <div className="pd-tabbar relative z-30 flex h-10 items-end gap-0 border-b border-white/5 pl-[76px] pr-2">
      <div className="flex flex-1 items-end overflow-x-auto">
        {tabs.map((t, i) => (
          <TabItem
            key={t.id}
            tab={t}
            index={i}
            active={t.id === activeTabId}
            fgName={fg[t.id]}
            attention={attentionTabIds.has(t.id)}
            onActivate={() => activate(t.id)}
            onClose={() => handleClose(t.id)}
            onRename={(title) => rename(t.id, title)}
            onReorder={reorder}
            onContextMenu={(x, y) => setCtxMenu({ tabId: t.id, x, y })}
          />
        ))}
      </div>
      <button
        className="new-tab-btn"
        onClick={() => newTab()}
        title="New tab (⌘T)"
        aria-label="New tab"
      >
        +
      </button>
      {ctxMenu && menuTab && (
        <div
          className="tab-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          <div className="tab-ctx-head">
            <span className="tab-ctx-title">Claude mode · {menuTab.title}</span>
            <span className="tab-ctx-sub">Restarts claude in focused pane</span>
          </div>
          {(["default", "auto", "bypass"] as PermissionMode[]).map((m) => (
            <button
              key={m}
              className={`tab-ctx-row mode-${m} ${currentMode === m ? "active" : ""}`}
              onClick={() => handlePickMode(menuTab.id, m)}
              role="menuitem"
            >
              <span className={`tab-ctx-dot mode-${m}`} />
              <span className="tab-ctx-body">
                <span className="tab-ctx-label">{MODE_LABEL[m]}</span>
                <span className="tab-ctx-desc">{MODE_DESC[m]}</span>
              </span>
              {currentMode === m && <span className="tab-ctx-check">✓</span>}
            </button>
          ))}
          <div className="tab-ctx-foot">
            Dangerous mode has no guardrails — only use in containers or throwaway dirs.
          </div>
        </div>
      )}
    </div>
  );
}

function TabItem({
  tab,
  index,
  active,
  fgName,
  attention,
  onActivate,
  onClose,
  onRename,
  onReorder,
  onContextMenu,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  fgName?: string;
  attention: boolean;
  onActivate: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onReorder: (from: number, to: number) => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    onRename(draft);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(tab.title);
    setEditing(false);
  };

  const fgPill = fgName && fgName !== tab.title ? fgName : null;

  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab-item group ${active ? "tab-active" : ""} ${
        attention ? "tab-attention" : ""
      }`}
      onMouseDown={(e) => {
        // Left-click activates; prevent starting a drag when clicking close/input
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest(".tab-close") || target.closest("input")) return;
        onActivate();
      }}
      onDoubleClick={() => setEditing(true)}
      onAuxClick={(e) => {
        if (e.button === 1) onClose(); // middle click
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/pd-tab", String(index));
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/pd-tab")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData("text/pd-tab");
        if (!raw) return;
        const from = Number(raw);
        if (Number.isFinite(from) && from !== index) onReorder(from, index);
      }}
    >
      <span className={`tab-dot ${active ? "accent" : ""}`} aria-hidden />
      {editing ? (
        <input
          ref={inputRef}
          className="tab-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          spellCheck={false}
        />
      ) : (
        <span className="tab-title" title={`${tab.cwd}${tab.cmd ? ` · ${tab.cmd}` : ""}`}>
          {tab.title}
        </span>
      )}
      {fgPill && !editing && (
        <span className="tab-fg" title={`foreground: ${fgPill}`}>
          {fgPill}
        </span>
      )}
      {tab.permissionMode && tab.permissionMode !== "default" && (
        <span
          className={`tab-mode-badge mode-${tab.permissionMode}`}
          title={MODE_DESC[tab.permissionMode]}
        >
          {tab.permissionMode === "bypass" ? "YOLO" : "auto"}
        </span>
      )}
      <button
        className="tab-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={`Close ${tab.title}`}
        title="Close (⌘W)"
      >
        ×
      </button>
      {active && <span className="tab-underline" aria-hidden />}
    </div>
  );
}
