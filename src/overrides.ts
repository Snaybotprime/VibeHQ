import { useCallback, useEffect, useState } from "react";

const KEY = "projectdashboard.overrides.v1";

export type ProjectOverride = {
  connections?: Record<number, string>;
  subRoutes?: Record<number, { path?: string; name?: string }>;
  tags?: string[];
};

export type OverridesMap = Record<string, ProjectOverride>;

function read(): OverridesMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OverridesMap) : {};
  } catch {
    return {};
  }
}

function write(next: OverridesMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}

export function useOverrides() {
  const [overrides, setOverrides] = useState<OverridesMap>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setOverrides(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const mutate = useCallback(
    (projectId: string, updater: (cur: ProjectOverride) => ProjectOverride) => {
      setOverrides((prev) => {
        const cur = prev[projectId] ?? {};
        const nextForProject = updater(cur);
        const hasAny =
          (nextForProject.connections &&
            Object.keys(nextForProject.connections).length > 0) ||
          (nextForProject.subRoutes &&
            Object.keys(nextForProject.subRoutes).length > 0) ||
          (nextForProject.tags && nextForProject.tags.length > 0);
        const next = { ...prev };
        if (hasAny) next[projectId] = nextForProject;
        else delete next[projectId];
        write(next);
        return next;
      });
    },
    [],
  );

  const setConnectionUrl = useCallback(
    (projectId: string, index: number, url: string) => {
      mutate(projectId, (cur) => ({
        ...cur,
        connections: { ...(cur.connections ?? {}), [index]: url },
      }));
    },
    [mutate],
  );

  const clearConnection = useCallback(
    (projectId: string, index: number) => {
      mutate(projectId, (cur) => {
        const { [index]: _, ...rest } = cur.connections ?? {};
        return { ...cur, connections: rest };
      });
    },
    [mutate],
  );

  const setSubRoute = useCallback(
    (
      projectId: string,
      index: number,
      patch: { path?: string; name?: string },
    ) => {
      mutate(projectId, (cur) => {
        const prev = cur.subRoutes?.[index] ?? {};
        return {
          ...cur,
          subRoutes: {
            ...(cur.subRoutes ?? {}),
            [index]: { ...prev, ...patch },
          },
        };
      });
    },
    [mutate],
  );

  const clearSubRoute = useCallback(
    (projectId: string, index: number) => {
      mutate(projectId, (cur) => {
        const { [index]: _, ...rest } = cur.subRoutes ?? {};
        return { ...cur, subRoutes: rest };
      });
    },
    [mutate],
  );

  const addTag = useCallback(
    (projectId: string, tag: string) => {
      const clean = tag.trim().toLowerCase().replace(/^#+/, "");
      if (!clean) return;
      mutate(projectId, (cur) => {
        const existing = cur.tags ?? [];
        if (existing.includes(clean)) return cur;
        return { ...cur, tags: [...existing, clean] };
      });
    },
    [mutate],
  );

  const removeTag = useCallback(
    (projectId: string, tag: string) => {
      mutate(projectId, (cur) => {
        const filtered = (cur.tags ?? []).filter((t) => t !== tag);
        return {
          ...cur,
          tags: filtered.length > 0 ? filtered : undefined,
        };
      });
    },
    [mutate],
  );

  const resetProject = useCallback((projectId: string) => {
    setOverrides((prev) => {
      if (!prev[projectId]) return prev;
      const { [projectId]: _, ...rest } = prev;
      write(rest);
      return rest;
    });
  }, []);

  const resetAll = useCallback(() => {
    write({});
    setOverrides({});
  }, []);

  return {
    overrides,
    setConnectionUrl,
    clearConnection,
    setSubRoute,
    clearSubRoute,
    addTag,
    removeTag,
    resetProject,
    resetAll,
  };
}

export function countOverrides(o: OverridesMap): number {
  let n = 0;
  for (const p of Object.values(o)) {
    n += Object.keys(p.connections ?? {}).length;
    n += Object.keys(p.subRoutes ?? {}).length;
    n += (p.tags ?? []).length;
  }
  return n;
}

// Pinned projects ---------------------------------------------------------

const PINNED_KEY = "projectdashboard.pinned.v1";

function readPinned(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writePinned(ids: string[]) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

export function usePinned() {
  const [pinned, setPinned] = useState<string[]>(() => readPinned());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PINNED_KEY) setPinned(readPinned());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      writePinned(next);
      return next;
    });
  }, []);

  const isPinned = useCallback((id: string) => pinned.includes(id), [pinned]);

  return { pinned, toggle, isPinned };
}
