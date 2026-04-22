import { useMemo, useState } from "react";

type MapProject = {
  id: string;
  name: string;
  description: string;
  stack: string;
  status: "active" | "backup" | "stub";
  dir: string;
  tags: string[];
};

type Cluster = "apps" | "meta";

const CLUSTER_LABEL: Record<Cluster, string> = {
  apps: "Apps",
  meta: "Meta / Tooling",
};

const CLUSTER_COLOR: Record<Cluster, string> = {
  apps: "#30d158",
  meta: "#ff6b7a",
};

type MapNode = {
  id: string;
  name: string;
  description: string;
  stack: string;
  status: "active" | "backup" | "stub";
  dir: string;
  tags: string[];
  cluster: Cluster;
  virtual?: boolean;
};

type MapEdge = {
  from: string;
  to: string;
  label: string;
  kind: "subroute" | "backup" | "stub" | "http" | "data";
};

const VIRTUAL_NODES: MapNode[] = [
  {
    id: "projectdashboard",
    name: "Project Dashboard",
    description:
      "This app. Express on :4321 serving the React SPA, scanning ~ for projects, and acting as the hub the HQ desktop app calls.",
    stack: "Vite React · Express",
    status: "active",
    dir: "~/VibeHQ",
    tags: ["dashboard", "hub"],
    cluster: "meta",
    virtual: true,
  },
  {
    id: "hq-desktop",
    name: "HQ (Desktop)",
    description:
      "Electron terminal app in ~/VibeHQ/desktop. Tabbed Claude Code panes over node-pty; fetches its project list from this dashboard.",
    stack: "Electron · xterm.js · node-pty",
    status: "active",
    dir: "~/VibeHQ/desktop",
    tags: ["electron", "terminal"],
    cluster: "meta",
    virtual: true,
  },
];

const EDGES: MapEdge[] = [
  { from: "hq-desktop", to: "projectdashboard", label: "/api/scan-projects", kind: "http" },
  { from: "projectdashboard", to: "hq-desktop", label: "/open?dir=…", kind: "http" },
];

function classifyCluster(_p: MapProject): Cluster {
  return "apps";
}

type PositionedNode = MapNode & { x: number; y: number };

function layoutNodes(nodes: MapNode[]): PositionedNode[] {
  const byCluster: Record<Cluster, MapNode[]> = {
    apps: [],
    meta: [],
  };
  for (const n of nodes) byCluster[n.cluster].push(n);

  const WIDTH = 1200;
  const HEIGHT = 760;

  const clusterOrder: Cluster[] = ["apps", "meta"];
  const centers: Record<Cluster, { cx: number; cy: number; r: number }> = {
    apps: { cx: WIDTH * 0.5, cy: HEIGHT * 0.42, r: 220 },
    meta: { cx: WIDTH * 0.5, cy: HEIGHT * 0.84, r: 140 },
  };

  const out: PositionedNode[] = [];
  for (const c of clusterOrder) {
    const list = byCluster[c];
    if (list.length === 0) continue;
    const { cx, cy, r } = centers[c];
    const step = (Math.PI * 2) / list.length;
    const startAngle = -Math.PI / 2;
    list.forEach((n, i) => {
      if (list.length === 1) {
        out.push({ ...n, x: cx, y: cy });
        return;
      }
      const a = startAngle + step * i;
      out.push({ ...n, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    });
  }
  return out;
}

export function ProjectMap({
  projects,
  clusterFilter,
  onClusterClick,
}: {
  projects: MapProject[];
  clusterFilter?: string | null;
  onClusterClick?: (cluster: string) => void;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const positioned = useMemo(() => {
    const real: MapNode[] = projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      stack: p.stack,
      status: p.status,
      dir: p.dir.replace(/^\/(Users|home)\/[^/]+\//, "~/"),
      tags: p.tags,
      cluster: classifyCluster(p),
    }));
    const all = [...real, ...VIRTUAL_NODES.filter((v) => !real.some((r) => r.id === v.id))];
    return layoutNodes(all);
  }, [projects]);

  const nodeById = useMemo(() => {
    const m = new Map<string, PositionedNode>();
    for (const n of positioned) m.set(n.id, n);
    return m;
  }, [positioned]);

  const edges = useMemo(
    () => EDGES.filter((e) => nodeById.has(e.from) && nodeById.has(e.to)),
    [nodeById],
  );

  const connected = useMemo(() => {
    if (!hoverId) return new Set<string>();
    const s = new Set<string>([hoverId]);
    for (const e of edges) {
      if (e.from === hoverId) s.add(e.to);
      if (e.to === hoverId) s.add(e.from);
    }
    return s;
  }, [hoverId, edges]);

  const hovered = hoverId ? nodeById.get(hoverId) ?? null : null;

  return (
    <section className="project-map" aria-label="Project relationship map">
      <div className="map-head">
        <p className="hero-tag">Relationship map</p>
        <h2 className="map-title">How the pieces fit</h2>
        <p className="map-sub">
          Every tracked project, grouped by cluster. Hover a node for its
          description; edges show routing, data, and backup links.
        </p>
      </div>

      <div className="map-legend">
        {(Object.keys(CLUSTER_LABEL) as Cluster[]).map((c) => (
          <span key={c} className="map-legend-item">
            <span
              className="map-legend-dot"
              style={{ background: CLUSTER_COLOR[c] }}
            />
            {CLUSTER_LABEL[c]}
          </span>
        ))}
        <span className="map-legend-item map-legend-edge">
          <span className="map-legend-line subroute" />
          sub-route
        </span>
        <span className="map-legend-item map-legend-edge">
          <span className="map-legend-line backup" />
          backup
        </span>
        <span className="map-legend-item map-legend-edge">
          <span className="map-legend-line http" />
          http
        </span>
      </div>

      <div className="map-canvas-wrap">
        <svg
          viewBox="0 0 1200 760"
          className="map-canvas"
          role="img"
          aria-label="Project relationship graph"
          onMouseLeave={() => setHoverId(null)}
        >
          <defs>
            <radialGradient id="mapHalo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(94,106,210,0.18)" />
              <stop offset="100%" stopColor="rgba(94,106,210,0)" />
            </radialGradient>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.55)" />
            </marker>
          </defs>

          <circle cx="600" cy="380" r="360" fill="url(#mapHalo)" />

          {(Object.keys(CLUSTER_LABEL) as Cluster[]).map((c) => {
            const members = positioned.filter((n) => n.cluster === c);
            if (members.length === 0) return null;
            const xs = members.map((m) => m.x);
            const ys = members.map((m) => m.y);
            const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
            const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
            const maxDist = Math.max(
              ...members.map((m) => Math.hypot(m.x - cx, m.y - cy)),
            );
            const r = maxDist + 60;
            const isActive = clusterFilter === c;
            const clickable = onClusterClick && c !== "meta";
            return (
              <g
                key={c}
                className={`map-cluster ${isActive ? "active" : ""} ${clickable ? "clickable" : ""}`}
                onClick={clickable ? () => onClusterClick!(c) : undefined}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={`${CLUSTER_COLOR[c]}${isActive ? "22" : "0f"}`}
                  stroke={`${CLUSTER_COLOR[c]}${isActive ? "99" : "40"}`}
                  strokeWidth={isActive ? 2 : 1}
                  strokeDasharray={isActive ? "none" : "4 6"}
                />
                <text
                  x={cx}
                  y={cy - r - 10}
                  textAnchor="middle"
                  className="map-cluster-label"
                  fill={CLUSTER_COLOR[c]}
                >
                  {CLUSTER_LABEL[c]}
                  {clickable ? (isActive ? " · active" : " · click to filter") : ""}
                </text>
              </g>
            );
          })}

          {edges.map((e, i) => {
            const a = nodeById.get(e.from)!;
            const b = nodeById.get(e.to)!;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2 - 30;
            const path = `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
            const active =
              hoverId && (hoverId === e.from || hoverId === e.to);
            const dim = hoverId && !active;
            return (
              <g
                key={i}
                className={`map-edge map-edge-${e.kind} ${
                  active ? "active" : ""
                } ${dim ? "dim" : ""}`}
              >
                <path d={path} markerEnd="url(#arrow)" />
                {active && (
                  <text x={mx} y={my - 6} textAnchor="middle" className="map-edge-label">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {positioned.map((n) => {
            const active = hoverId === n.id;
            const dim = hoverId && !connected.has(n.id);
            return (
              <g
                key={n.id}
                className={`map-node map-node-${n.status} ${
                  active ? "active" : ""
                } ${dim ? "dim" : ""} ${n.virtual ? "virtual" : ""}`}
                transform={`translate(${n.x} ${n.y})`}
                onMouseEnter={() => setHoverId(n.id)}
                onFocus={() => setHoverId(n.id)}
                tabIndex={0}
              >
                <circle
                  r={active ? 30 : 24}
                  fill={CLUSTER_COLOR[n.cluster]}
                />
                <circle
                  r={active ? 30 : 24}
                  className="map-node-ring"
                />
                <text y={48} textAnchor="middle" className="map-node-label">
                  {n.name}
                </text>
              </g>
            );
          })}
        </svg>

        <div
          className={`map-tooltip ${hovered ? "visible" : ""}`}
          aria-live="polite"
        >
          {hovered ? (
            <>
              <div className="map-tooltip-head">
                <span
                  className="map-tooltip-dot"
                  style={{ background: CLUSTER_COLOR[hovered.cluster] }}
                />
                <span className="map-tooltip-name">{hovered.name}</span>
                <span className={`map-tooltip-status ${hovered.status}`}>
                  {hovered.status}
                </span>
              </div>
              <div className="map-tooltip-stack">{hovered.stack}</div>
              <p className="map-tooltip-desc">{hovered.description}</p>
              <div className="map-tooltip-path">{hovered.dir}</div>
              {hovered.tags.length > 0 && (
                <div className="map-tooltip-tags">
                  {hovered.tags.slice(0, 6).map((t) => (
                    <span key={t} className="map-tooltip-tag">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="map-tooltip-empty">
              Hover any node to see details.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
