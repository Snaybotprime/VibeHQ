export type Connection = {
  label: string;
  url: string;
  kind: "local" | "deployed";
};

export type SubRoute = {
  path: string;
  name: string;
  description?: string;
};

export type ProcessCheck =
  | { kind: "launchd"; pattern: string; label?: string }
  | { kind: "pgrep"; pattern: string; label?: string };

export type ProjectBot = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
};

export type Project = {
  id: string;
  name: string;
  dir: string;
  stack: string;
  description: string;
  devCommand: string;
  localPort: number | null;
  connections: Connection[];
  subRoutes?: SubRoute[];
  gitRemote?: string;
  status: "active" | "backup" | "stub";
  tags: string[];
  processCheck?: ProcessCheck;
  bots?: ProjectBot[];
};

// Hand-curated projects with rich metadata appear here. Anything not listed
// still shows up via the `/api/scan-projects` HOME walk in server.js — so the
// dashboard works with an empty list, and this is the place to pin a few
// first-class entries when you want richer metadata than the scanner provides.
//
// Example entry (delete once you add your own):
//
// {
//   id: "my-app",
//   name: "My App",
//   dir: `${process.env.HOME}/my-app`,
//   stack: "Vite React",
//   description: "Short blurb about the project.",
//   devCommand: "npm run dev",
//   localPort: 5173,
//   connections: [
//     { label: "Local", url: "http://localhost:5173", kind: "local" },
//   ],
//   status: "active",
//   tags: ["web"],
// },
export const projects: Project[] = [];
