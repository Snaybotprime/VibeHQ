import { useEffect, useMemo, useRef, useState } from "react";
import type { AccessPassword } from "./api";

type PaletteConnection = {
  label: string;
  url: string;
  kind: "local" | "deployed";
  index: number;
};

type PaletteProject = {
  id: string;
  name: string;
  dir: string;
  connections: PaletteConnection[];
};

type ActionKind = "claude" | "desktop" | "copy-pw" | "pin" | "unpin" | "open-url";

type Action = {
  id: string;
  kind: ActionKind;
  title: string;
  subtitle: string;
  hint: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  projects,
  passwords,
  onOpenInClaude,
  onOpenInDesktop,
  onRescan,
  onToast,
  onTogglePin,
  isPinned,
}: {
  open: boolean;
  onClose: () => void;
  projects: PaletteProject[];
  passwords: Record<string, AccessPassword>;
  onOpenInClaude: (dir: string) => void;
  onOpenInDesktop: (dir: string, name: string) => void;
  onRescan: () => void;
  onToast: (kind: "ok" | "error", text: string, ms?: number) => void;
  onTogglePin: (id: string) => void;
  isPinned: (id: string) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  const actions: Action[] = useMemo(() => {
    const list: Action[] = [];
    list.push({
      id: "rescan",
      kind: "claude",
      title: "Rescan ~ for new projects",
      subtitle: "Run /api/scan-projects now",
      hint: "scan",
      run: () => {
        onRescan();
        onToast("ok", "Rescanning…");
      },
    });
    for (const p of projects) {
      const pinned = isPinned(p.id);
      list.push({
        id: `claude:${p.id}`,
        kind: "claude",
        title: `Open ${p.name} in Claude`,
        subtitle: p.dir.replace(/^\/(Users|home)\/[^/]+\//, "~/"),
        hint: "Terminal + claude",
        run: () => onOpenInClaude(p.dir),
      });
      list.push({
        id: `desktop:${p.id}`,
        kind: "desktop",
        title: `Open ${p.name} in HQ`,
        subtitle: p.dir.replace(/^\/(Users|home)\/[^/]+\//, "~/"),
        hint: "Desktop pane",
        run: () => onOpenInDesktop(p.dir, p.name),
      });
      list.push({
        id: `pin:${p.id}`,
        kind: pinned ? "unpin" : "pin",
        title: `${pinned ? "Unpin" : "Pin"} ${p.name}`,
        subtitle: pinned ? "Remove from top of grid" : "Sort to top of grid",
        hint: pinned ? "unpin" : "pin",
        run: () => {
          onTogglePin(p.id);
          onToast("ok", `${pinned ? "Unpinned" : "Pinned"} ${p.name}`);
        },
      });
      const pw = passwords[p.id];
      if (pw) {
        list.push({
          id: `pw:${p.id}`,
          kind: "copy-pw",
          title: `Copy access password · ${p.name}`,
          subtitle: pw.label ?? "Shared",
          hint: "Clipboard",
          run: async () => {
            try {
              await navigator.clipboard.writeText(pw.password);
              onToast("ok", `Copied password for ${p.name}`);
            } catch {
              onToast("error", "Clipboard blocked");
            }
          },
        });
      }
      for (const c of p.connections) {
        if (c.kind !== "deployed") continue;
        list.push({
          id: `url:${p.id}:${c.index}`,
          kind: "open-url",
          title: `Open ${c.label} · ${p.name}`,
          subtitle: c.url,
          hint: "Browser",
          run: () => {
            window.open(c.url, "_blank", "noopener,noreferrer");
          },
        });
      }
    }
    return list;
  }, [
    projects,
    passwords,
    onOpenInClaude,
    onOpenInDesktop,
    onRescan,
    onToast,
    onTogglePin,
    isPinned,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions.slice(0, 40);
    const hit = (a: Action) =>
      `${a.title} ${a.subtitle} ${a.hint}`.toLowerCase().includes(q);
    return actions.filter(hit).slice(0, 40);
  }, [actions, query]);

  useEffect(() => {
    if (index >= filtered.length) setIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, index]);

  if (!open) return null;

  const run = (a: Action) => {
    a.run();
    onClose();
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[index];
      if (a) run(a);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <span className="palette-icon" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Jump to project, open Claude, copy password…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKey}
          />
          <kbd className="palette-kbd">esc</kbd>
        </div>
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matching actions.</div>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.id}
                className={`palette-row ${i === index ? "active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(a)}
              >
                <span className={`palette-row-kind kind-${a.kind}`}>
                  {kindGlyph(a.kind)}
                </span>
                <span className="palette-row-body">
                  <span className="palette-row-title">{a.title}</span>
                  <span className="palette-row-sub">{a.subtitle}</span>
                </span>
                <span className="palette-row-hint">{a.hint}</span>
              </button>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
          <span className="palette-count">{filtered.length} action{filtered.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}

function kindGlyph(kind: ActionKind): string {
  switch (kind) {
    case "claude":
      return "◈";
    case "desktop":
      return "▣";
    case "copy-pw":
      return "⚿";
    case "pin":
      return "★";
    case "unpin":
      return "☆";
    case "open-url":
      return "↗";
  }
}
