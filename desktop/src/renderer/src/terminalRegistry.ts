import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

type Entry = { term: Terminal; fit: FitAddon };

const registry = new Map<string, Entry>();

export function registerTerminal(paneId: string, entry: Entry): void {
  registry.set(paneId, entry);
}

export function unregisterTerminal(paneId: string): void {
  registry.delete(paneId);
}

export function getTerminal(paneId: string): Entry | undefined {
  return registry.get(paneId);
}

/** Aggressive focus — waits for layout, refits, refocuses. */
export function focusTerminal(paneId: string): void {
  const entry = registry.get(paneId);
  if (!entry) return;
  const { term, fit } = entry;
  // Two ticks: one for React commit, one for browser paint.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* host not measured */
      }
      try {
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        /* ignore */
      }
      term.focus();
      // Also directly focus the textarea as a belt-and-braces measure —
      // some Electron/WebKit situations drop .focus() if the window isn't
      // fully foregrounded yet.
      const el = document.querySelector<HTMLTextAreaElement>(
        `[data-pane-id="${paneId}"] .xterm-helper-textarea`,
      );
      el?.focus();
    });
  });
}
