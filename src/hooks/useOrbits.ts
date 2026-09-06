import { useEffect, useState } from "react";
import type { OrbitInfo, OrbitsResponse } from "../lib/orbits";

/** Orbit shapes for the solar-system view, keyed by Horizons body id. */
export function useOrbits(): { orbits: Map<string, OrbitInfo>; pending: number } {
  const [orbits, setOrbits] = useState<Map<string, OrbitInfo>>(new Map());
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = async () => {
      try {
        const r = await fetch("/api/orbits");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as OrbitsResponse;
        if (cancelled) return;
        setOrbits(new Map(j.bodies.filter((b) => b.status === "ok").map((b) => [b.id, b])));
        setPending(j.pending);
        timer = window.setTimeout(load, j.pending > 0 || j.refreshing ? 45_000 : 30 * 60_000);
      } catch {
        if (!cancelled) timer = window.setTimeout(load, 60_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return { orbits, pending };
}
