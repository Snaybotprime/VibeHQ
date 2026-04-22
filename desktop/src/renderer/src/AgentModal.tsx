import { useEffect, useRef, useState } from "react";
import type { ScannedProject } from "./api";
import type { AgentScope } from "../../shared/ipc";

type Props = {
  project: ScannedProject;
  defaultScope: AgentScope;
  onClose: () => void;
  onToast: (kind: "ok" | "error", text: string) => void;
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 49);
}

export function AgentModal({ project, defaultScope, onClose, onToast }: Props) {
  const [scope, setScope] = useState<AgentScope>(defaultScope);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cleanName = slugify(name);
  const canSubmit =
    !busy &&
    NAME_RE.test(cleanName) &&
    description.trim().length > 0 &&
    systemPrompt.trim().length > 0;

  // Attach native drag/drop listeners to the textarea. React's synthetic
  // onDrop doesn't reliably fire for file drops in Electron — go native.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.target === el) setDropActive(false);
    };
    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setDropActive(false);
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const p = window.helix.actions.getPathForFile(files[i]);
          if (p) paths.push(p);
        } catch {
          /* ignore non-file drops */
        }
      }
      if (paths.length === 0) return;
      const text = paths.join(" ");
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      setSystemPrompt(next);
      requestAnimationFrame(() => {
        el.focus();
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
      });
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const toolList = tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await window.helix.actions.writeAgent({
        scope,
        projectDir: scope === "project" ? project.dir : undefined,
        name: cleanName,
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        tools: toolList.length ? toolList : undefined,
      });
      if (res.ok) {
        onToast("ok", `Created agent at ${res.path}`);
        onClose();
      } else {
        onToast("error", res.error ?? "Unknown error");
      }
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="pd-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pd-modal" role="dialog" aria-modal="true">
        <header className="pd-modal-head">
          <h2>New Claude Code agent</h2>
          <button className="pd-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="pd-modal-body">
          <label className="pd-field">
            <span className="pd-field-label">Scope</span>
            <div className="pd-scope-row">
              <button
                type="button"
                className={`pd-scope-opt ${scope === "global" ? "active" : ""}`}
                onClick={() => setScope("global")}
              >
                <span className="pd-scope-title">Global</span>
                <span className="pd-scope-hint">~/.claude/agents/</span>
              </button>
              <button
                type="button"
                className={`pd-scope-opt ${scope === "project" ? "active" : ""}`}
                onClick={() => setScope("project")}
              >
                <span className="pd-scope-title">This project</span>
                <span className="pd-scope-hint">
                  {project.dir.replace(/^\/Users\/[^/]+/, "~")}/.claude/agents/
                </span>
              </button>
            </div>
          </label>

          <label className="pd-field">
            <span className="pd-field-label">Name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="deploy-checker"
              spellCheck={false}
              className="pd-input"
            />
            {name && name !== cleanName && (
              <span className="pd-field-note">
                Will be saved as: <code>{cleanName}.md</code>
              </span>
            )}
          </label>

          <label className="pd-field">
            <span className="pd-field-label">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Use when deploying — validates env vars and build output."
              className="pd-input"
            />
          </label>

          <label className="pd-field">
            <span className="pd-field-label">System prompt</span>
            <textarea
              ref={promptRef}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a deployment checker. Before approving a deploy…"
              rows={8}
              className={`pd-textarea${dropActive ? " is-drop-target" : ""}`}
            />
            <span className="pd-field-note">Drop a file to insert its path.</span>
          </label>

          <label className="pd-field">
            <span className="pd-field-label">
              Tools <span className="pd-field-optional">(optional)</span>
            </span>
            <input
              value={tools}
              onChange={(e) => setTools(e.target.value)}
              placeholder="Read, Grep, Bash"
              className="pd-input"
            />
            <span className="pd-field-note">Comma-separated. Leave blank for defaults.</span>
          </label>
        </div>

        <footer className="pd-modal-foot">
          <button className="pd-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="pd-btn-primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy ? "Writing…" : "Create agent"}
          </button>
        </footer>
      </div>
    </div>
  );
}
