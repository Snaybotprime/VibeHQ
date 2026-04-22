# VibeHQ

A two-app local dev environment for people who juggle a lot of side projects:

- **Project Dashboard** — a web app that scans `$HOME` for your projects, watches process / port / git status, tracks Claude Code token usage, and lets you open any project in a terminal with one click.
- **HQ** — an Electron desktop app that gives you tabbed, split-pane Claude Code terminals, reads the project list from the dashboard, and accepts "open this folder in a new tab" requests over a small local HTTP protocol.

Both apps bind to `127.0.0.1` only. Nothing in this repo is designed to be exposed to the network.

## Layout

```
.
├── server.js        # Express API on :4321
├── src/             # Project Dashboard React SPA
└── desktop/         # HQ Electron app (separate npm package)
```

See [`CLAUDE.md`](./CLAUDE.md) for architecture notes.

## Running

### Web dashboard

```bash
npm install
npm start            # build + serve on http://localhost:4321
```

For development:

```bash
npm run serve        # Express API on :4321
npm run dev          # Vite dev server on :4322 (in another terminal)
```

### HQ desktop

```bash
cd desktop
npm install
npm run dev          # electron-vite dev build
```

To build a packaged app:

```bash
npm run build
npm run preview
```

If `node-pty` complains about ABI version, run `npm run rebuild` from `desktop/`.

## Adding your own projects

Two paths:

1. **Auto-scan** — anything under `$HOME` that looks like a project (has a `package.json`, `.git`, or a handful of other signals) shows up automatically via `/api/scan-projects`.
2. **Hand-curate** — for projects where you want a nice name, description, sub-routes, or process check, add an entry to `src/projects.ts`. The starter file is empty with an example in a comment.

## License

MIT — see [LICENSE](./LICENSE).
