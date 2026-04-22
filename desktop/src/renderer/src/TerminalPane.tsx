import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { registerTerminal, unregisterTerminal } from "./terminalRegistry";
import { useTabs } from "./store";
import promptChimeUrl from "./assets/prompt-chime.mp3";

// Shared across panes — one Audio element is enough. Resetting currentTime
// lets rapid consecutive prompts re-fire the chime without overlap.
let promptChimeAudio: HTMLAudioElement | null = null;
function playPromptChime(): void {
  if (!promptChimeAudio) {
    promptChimeAudio = new Audio(promptChimeUrl);
    promptChimeAudio.volume = 0.6;
  }
  try {
    promptChimeAudio.currentTime = 0;
    void promptChimeAudio.play().catch(() => {});
  } catch {
    /* autoplay restrictions or element in bad state — ignore */
  }
}

type Props = {
  paneId: string;
  cwd: string;
  cmd?: string;
  active: boolean;
  onExit?: (code: number | null, signal: number | null) => void;
};

const THEME = {
  background: "#000000",
  foreground: "#e4e4e7",
  cursor: "#C24AF9",
  cursorAccent: "#000000",
  selectionBackground: "rgba(126, 56, 255, 0.35)",
  black: "#000000",
  red: "#ff6b7a",
  green: "#30d158",
  yellow: "#f2a03d",
  blue: "#5833F2",
  magenta: "#C24AF9",
  cyan: "#64d2ff",
  white: "#d4d4d8",
  brightBlack: "#52525b",
  brightRed: "#ff8a95",
  brightGreen: "#5ce88a",
  brightYellow: "#ffc470",
  brightBlue: "#7E38FF",
  brightMagenta: "#d580ff",
  brightCyan: "#8dd9ff",
  brightWhite: "#fafafa",
};

export function TerminalPane({ paneId, cwd, cmd, active, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Create/destroy the terminal + PTY. This only depends on identity props.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // Keep the WebGL canvas opaque — otherwise content from whatever window
      // is below the Electron window bleeds through the empty regions of the
      // xterm canvas on macOS.
      allowTransparency: false,
      scrollback: 10000,
      macOptionIsMeta: true,
      theme: THEME,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    term.open(host);
    registerTerminal(paneId, { term, fit });

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("[TerminalPane] WebGL renderer failed, using canvas", err);
    }

    const fitSafe = () => {
      try {
        fit.fit();
      } catch {
        /* host not measured yet */
      }
    };

    fitSafe();

    let disposed = false;
    const api = window.helix;

    // ⌘C / ⌘A / ⌘X — copy selection, select all. ⌘V is handled by xterm's
    // native paste event listener, which respects bracketed-paste mode and
    // routes through onData below. Don't intercept it here or it pastes twice.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c" || key === "x") {
        const sel = term.getSelection();
        if (sel && sel.length > 0) {
          api.actions.clipboardWrite(sel).catch(() => {});
          // Clear selection so the next copy feels fresh; matches iTerm/Terminal.
          term.clearSelection();
          return false;
        }
        // No selection → let the key pass so ⌘C can't silently eat Ctrl+C intent.
        // (On macOS ⌘C isn't mapped to SIGINT in xterm by default, so passing it
        // through is harmless — but it keeps future bindings consistent.)
        return true;
      }
      if (key === "a") {
        term.selectAll();
        return false;
      }
      return true;
    });

    const input = term.onData((data) => {
      if (!disposed) api.pty.write({ paneId, data });
    });

    // Scan the visible xterm buffer for Claude Code prompts that are waiting
    // on a user decision (permission dialogs). When detected, mark the pane
    // for attention so the tab flashes red.
    //   "❯ 1." / "❯ 2." / "❯ 3."   — numbered-option cursor row. This is the
    // only signal we trust: the ❯ indicator is only present while Claude is
    // waiting on a selection, and disappears once the user answers. Phrases
    // like "Do you want to …" linger in scrollback after an answer, which
    // would wedge `promptAttentionActive` high and skip the chime on the next
    // prompt.
    const CLAUDE_PROMPT_RE = /❯\s*[123]\./;
    let promptCheckTimer: number | null = null;
    // Tracks whether *we* (prompt detector) currently own this pane's
    // attention flag. Lets us clear our own mark without touching attention
    // set by other sources (e.g., the terminal bell).
    let promptAttentionActive = false;
    const scanBufferForPrompt = () => {
      promptCheckTimer = null;
      const buf = term.buffer.active;
      const endY = buf.baseY + buf.cursorY;
      // Narrow window: the ❯ cursor is always within a handful of lines of
      // the terminal cursor while the prompt is open. A wide window catches
      // stale matches from prior prompts still in scrollback.
      const startY = Math.max(0, endY - 8);
      let text = "";
      for (let y = startY; y <= endY; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        text += line.translateToString(true) + "\n";
      }
      const matched = CLAUDE_PROMPT_RE.test(text);
      if (matched) {
        // Play a chime only on the leading edge (false → true). Prevents
        // re-firing on every scan while the prompt is still on screen.
        if (!promptAttentionActive) playPromptChime();
        useTabs.getState().markAttention(paneId);
        promptAttentionActive = true;
      } else if (promptAttentionActive) {
        // Prompt has disappeared (user answered) — clear the flash.
        useTabs.getState().clearAttention(paneId);
        promptAttentionActive = false;
      }
    };
    const schedulePromptCheck = () => {
      if (promptCheckTimer != null) return;
      promptCheckTimer = window.setTimeout(scanBufferForPrompt, 250);
    };

    const offData = api.pty.onData(({ paneId: id, data }) => {
      if (id === paneId) {
        term.write(data);
        schedulePromptCheck();
      }
    });

    const bellSub = term.onBell(() => {
      // Claude Code rings the terminal bell whenever it's waiting on user
      // input. Always chime + mark red, even if this pane is currently focused
      // — the user may be looking elsewhere on screen.
      playPromptChime();
      useTabs.getState().markAttention(paneId);
    });

    const offExit = api.pty.onExit(({ paneId: id, exitCode, signal }) => {
      if (id !== paneId) return;
      term.write(
        `\r\n\x1b[38;5;244m[process exited${
          exitCode !== null ? ` · code ${exitCode}` : ""
        }${signal !== null ? ` · signal ${signal}` : ""}]\x1b[0m\r\n`,
      );
      onExit?.(exitCode, signal);
    });

    (async () => {
      const result = await api.pty.spawn({
        paneId,
        cwd,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposed) return;
      if (!result.ok) {
        term.write(
          `\r\n\x1b[31mPTY spawn failed: ${result.error ?? ""}\x1b[0m\r\n`,
        );
        return;
      }
      if (cmd) {
        await api.pty.write({ paneId, data: `${cmd}\r` });
      }
      // Focus only on mount if this pane is currently active. The active-watch
      // effect below handles the case when we become active later.
      if (activeRef.current) term.focus();
    })();

    const onHostMouseDown = () => term.focus();
    host.addEventListener("mousedown", onHostMouseDown);

    // Drag-and-drop: dropped files have their absolute paths typed into the
    // PTY (space-separated; paths with special chars are single-quoted).
    // Claude Code and most CLIs accept paths as plain args, so this lets the
    // user drag a file from Finder to reference it in a prompt.
    const shellQuote = (p: string): string => {
      if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p;
      return `'${p.replace(/'/g, `'\\''`)}'`;
    };
    const onHostDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      host.classList.add("pd-pane-dragover");
    };
    const onHostDragLeave = (e: DragEvent) => {
      // Only clear when leaving the host itself, not a child.
      if (e.target === host) host.classList.remove("pd-pane-dragover");
    };
    const onHostDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      host.classList.remove("pd-pane-dragover");
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const p = api.actions.getPathForFile(files[i]);
          if (p) paths.push(shellQuote(p));
        } catch {
          /* ignore — non-file drop */
        }
      }
      if (paths.length === 0) return;
      api.pty.write({ paneId, data: paths.join(" ") });
      term.focus();
    };
    host.addEventListener("dragover", onHostDragOver);
    host.addEventListener("dragleave", onHostDragLeave);
    host.addEventListener("drop", onHostDrop);

    const ro = new ResizeObserver(() => {
      fitSafe();
      api.pty.resize({ paneId, cols: term.cols, rows: term.rows });
    });
    ro.observe(host);

    const onWinResize = () => {
      fitSafe();
      api.pty.resize({ paneId, cols: term.cols, rows: term.rows });
    };
    window.addEventListener("resize", onWinResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onWinResize);
      host.removeEventListener("mousedown", onHostMouseDown);
      host.removeEventListener("dragover", onHostDragOver);
      host.removeEventListener("dragleave", onHostDragLeave);
      host.removeEventListener("drop", onHostDrop);
      ro.disconnect();
      if (promptCheckTimer != null) {
        window.clearTimeout(promptCheckTimer);
        promptCheckTimer = null;
      }
      input.dispose();
      bellSub.dispose();
      offData();
      offExit();
      unregisterTerminal(paneId);
      api.pty.kill({ paneId });
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // Keep a ref to the latest `active` value so the spawn effect can read it.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // On activation, refit + refocus. Hidden panes may have stale sizes.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    // Let the browser commit visibility change first.
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      window.helix.pty.resize({
        paneId,
        cols: term.cols,
        rows: term.rows,
      });
      term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, paneId]);

  return (
    <div
      ref={hostRef}
      className="pd-term-host h-full w-full px-3 py-3"
      tabIndex={-1}
    />
  );
}
