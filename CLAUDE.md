# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout: two apps, one tree

This directory contains **two independent npm packages** that talk to each other over HTTP:

- **`/` (package `projectdashboard`)** — the **web dashboard**. A React + Vite SPA (`src/`) served by an Express server (`server.js`) on `http://127.0.0.1:4321`. Scans `$HOME` for projects, tracks process/launchd state, stores shared access passwords, and aggregates Claude Code token usage.
- **`/desktop/` (package `hq`)** — the **HQ desktop app**. A tabbed, split-pane Claude Code terminal built on electron-vite + node-pty + xterm.js. Fetches the project list from the web dashboard's `/api/scan-projects`.

The two apps are coupled by a small open-protocol: HQ runs an HTTP server on `127.0.0.1:4322` (`HQ_OPEN_PORT`) with a `/open?dir=...&cmd=...&name=...` endpoint; the web dashboard (or any local tool) hits it to spawn a new tab in HQ. On macOS the open handler calls `app.focus({ steal: true })` to pull OS focus away from the browser — don't remove that without a replacement.

When changing APIs shared across the boundary, the two type surfaces to keep in sync are `server.js` (Express routes) and:
- `src/api.ts` (web dashboard client)
- `desktop/src/renderer/src/api.ts` (desktop client — currently only consumes `/api/scan-projects`)

## Commands

### Web dashboard (from repo root)

```bash
npm run dev       # Vite dev server @ :4322, proxies /api → 127.0.0.1:4321
npm run build     # tsc -b + vite build → dist/
npm run serve     # node server.js on :4321 (serves dist/ + API)
npm start         # build && serve (production-style)
```

Run `npm run serve` in one terminal and `npm run dev` in another to get HMR on the SPA while the Express API stays hot. In production both are served together by `npm start`.

### HQ desktop app (from `desktop/`)

```bash
npm run dev       # electron-vite dev (HMR for renderer + main reload)
npm run build     # electron-vite build → out/
npm run preview   # run the packaged build
npm run typecheck # runs BOTH tsconfigs: node (main/preload) and web (renderer)
npm run format    # prettier on src/**
npm run rebuild   # rebuild native deps (node-pty) against Electron's Node ABI
```

There are no test suites in either package — don't claim tests exist.

`npm run typecheck` in `desktop/` is the only way to catch main↔renderer type drift; the root has `tsc -b` folded into `build`.

## Architecture: what you need to read multiple files to learn

### Web dashboard data flow

- **`server.js`** is the only backend. It binds to `127.0.0.1` only (never expose). All filesystem access is sandboxed: `path.resolve` then reject anything not under `$HOME`. Every slug/pattern input goes through `SLUG_ID_RE` or `PATTERN_RE` before being shelled out. Preserve these guards when adding endpoints.
- **`src/projects.ts`** is a hand-maintained list of known projects with rich metadata (connections, subRoutes, tags, `processCheck`). **`server.js /api/scan-projects`** separately walks `$HOME` for any project-shaped directory and returns a lighter shape. The UI merges the two: hand-curated entries from `projects.ts` are authoritative; scanned entries fill in the rest. Editing one without considering the other will cause drift.
- **`src/overrides.ts`** persists per-project UI edits to `localStorage` under `projectdashboard.overrides.v1`. Connection URLs, subRoute paths, and ad-hoc tags are stored as index-keyed maps over the base project's arrays.
- **Claude usage** (`/api/claude-usage`): reads every `.jsonl` under `~/.claude/projects/*/`, sums `input_tokens + output_tokens + cache_creation + cache_read` into day/week/month buckets using local-time boundaries (week = ISO, Monday-start). Budgets overridable via `CLAUDE_DAILY_BUDGET` / `CLAUDE_WEEKLY_BUDGET` / `CLAUDE_MONTHLY_BUDGET` env vars.
- **`.access-passwords.json`** stores shared access passwords at repo root, chmod 600. It's git-ignored and must never be bundled into `dist/`. `DELETE /api/access-password` and `PUT` with `password: ""` both remove an entry.

### HQ desktop architecture

Three processes, standard Electron split:

- **main** (`desktop/src/main/`): owns node-pty processes, writes Claude agents to disk, runs the `/open` server, handles clipboard/reveal-in-Finder. `pty.ts` keeps a `paneId → IPty` map and broadcasts `pty:data` / `pty:exit` events scoped to the window that spawned the pane. Killing a pane = killing its pty (replace-on-reuse if you spawn into an existing paneId).
- **preload** (`desktop/src/preload/index.ts`): exposes exactly one bridge, `window.helix`, with `pty`, `app`, and `actions` namespaces. All new IPC must go through the typed `IPC` constants in `desktop/src/shared/ipc.ts` — that file is the single source of truth for channel names and payload types, imported by both sides.
- **renderer** (`desktop/src/renderer/src/`): React + xterm.js + Zustand + Tailwind.
  - `store.ts` (Zustand with `persist`) models the tab/pane tree as a recursive `PaneNode = LeafNode | SplitNode`. Tree helpers (`findLeaf`, `replaceLeaf`, `removeLeaf`, `collectLeaves`) are shared. Persisted under `hq.tabs.v2`; the migrate function wipes v1 state deliberately (shape incompatible).
  - Tab title precedence: explicit `title` → deepest-matching project's name → fg process name → cwd basename. `App.tsx` has a `projectAnchored` ref that anchors a tab to its project name exactly once; this wins over the fg-process promoter, so manual renames stick after anchoring.
  - `TerminalPane.tsx` keeps one xterm + node-pty pair per paneId across tab switches — tabs are hidden via CSS, not unmounted, so scrollback and process state survive.
  - The renderer polls every live pane's foreground process (`pty:fg`) on a 2.5 s interval and surfaces it in the tab bar.

### Cross-app port map

| Port  | Owned by                       | Notes                                         |
|-------|--------------------------------|-----------------------------------------------|
| 4321  | `server.js` (Express)          | Bound 127.0.0.1 only; serves dist/ + API      |
| 4322  | Vite dev (web) OR HQ `/open`   | Conflict only if both dev-running at once     |
| 5173  | Allowed CORS origin            | Legacy — from when HQ ran on Vite's default   |

The CORS allowlist in `server.js` and `openServer.ts` are hand-curated sets. Add new origins to both.

## Conventions worth knowing before editing

- **Path sandboxing** is repeated in both apps (web `server.js`, desktop `actions.ts`, desktop `openServer.ts`). The pattern is always: resolve, then assert `resolved === HOME || resolved.startsWith(HOME + sep)`. Don't skip this when adding any endpoint/IPC that accepts a path.
- **Shell-quoting** in `server.js` uses the `sq` helper (`'…'` with `'\''` escaping). `ALLOWED_COMMANDS` is a small allowlist — extend it rather than accepting arbitrary commands.
- **Slug regex** `^[a-z0-9][a-z0-9_-]{0,48}$/i` is repeated in `server.js`, `src/api.ts`, and `desktop/src/main/actions.ts`. Keep them in sync.
- The root project uses **tsc in noEmit mode**; Vite handles actual compilation. Adding `.ts` files without listing them in `tsconfig.json`'s `include` is fine as long as they're under `src/`.
- The `desktop/` package intentionally duplicates `@xterm/*`, `node-pty`, and `zustand` — it's a self-contained Electron app and must not reach into the root's `node_modules`.
