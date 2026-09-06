import { useEffect, useState } from "react";
import type { Origin } from "../types";

export interface PoiRow {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  wiki?: string;
  wikidata?: string;
  ele?: number;
  website?: string;
}

export interface PoiState {
  status: "idle" | "loading" | "ready" | "error";
  count: number;
  error?: string;
  radiusKm?: number;
}

/** OpenStreetMap places of interest around the origin. Fetched (debounced) whenever the origin moves. */
export function usePoi(origin: Origin, enabled: boolean): { pois: PoiRow[]; state: PoiState } {
  const [pois, setPois] = useState<PoiRow[]>([]);
  const [state, setState] = useState<PoiState>({ status: "idle", count: 0 });
  const lat = Math.round(origin.lat * 50) / 50;
  const lon = Math.round(origin.lon * 50) / 50;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    setState((s) => ({ ...s, status: "loading" }));
    const timer = window.setTimeout(async () => {
      try {
        const r = await fetch(`/api/poi?lat=${lat}&lon=${lon}`, { signal: controller.signal });
        const j = (await r.json()) as { pois?: PoiRow[]; radiusKm?: number; error?: string };
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setPois(j.pois ?? []);
        setState({ status: "ready", count: j.pois?.length ?? 0, radiusKm: j.radiusKm });
      } catch (e) {
        if (cancelled || (e as Error).name === "AbortError") return;
        setState({ status: "error", count: 0, error: (e as Error).message });
      }
    }, 800);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [lat, lon, enabled]);

  return { pois: enabled ? pois : [], state };
}
