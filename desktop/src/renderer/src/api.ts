export type ScannedProject = {
  id: string;
  name: string;
  dir: string;
  stack: string;
  description: string;
  devCommand: string;
  localPort: number | null;
  gitRemote: string | null;
  status: "active";
  tags: string[];
};

const DASHBOARD_BASE =
  (import.meta.env.VITE_DASHBOARD_URL as string | undefined) ??
  "http://localhost:4321";

export async function fetchProjects(
  signal?: AbortSignal,
): Promise<ScannedProject[]> {
  const res = await fetch(`${DASHBOARD_BASE}/api/scan-projects`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { projects: ScannedProject[] };
  return body.projects;
}
