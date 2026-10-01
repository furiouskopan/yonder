import { useEffect, useRef, useState } from "react";
import type { OrbitInfo, OrbitsResponse } from "../lib/orbits";

/** Orbit shapes for the solar-system view, keyed by Horizons body id. */
export function useOrbits(): { orbits: Map<string, OrbitInfo>; pending: number } {
  const [orbits, setOrbits] = useState<Map<string, OrbitInfo>>(new Map());
  const [pending, setPending] = useState(0);
  const signature = useRef("");

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = async () => {
      try {
        const r = await fetch("/api/orbits");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as OrbitsResponse;
        if (cancelled) return;
        // A new Map rebuilds the whole solar-system scene, so only replace it when an orbit actually changed.
        const ok = j.bodies.filter((b) => b.status === "ok");
        const sig = ok.map((b) => `${b.id}@${b.fetchedAt ?? ""}`).join("|");
        if (sig !== signature.current) {
          signature.current = sig;
          setOrbits(new Map(ok.map((b) => [b.id, b])));
        }
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
