import { useEffect, useMemo, useRef, useState } from "react";
import type { Origin, Target } from "../types";
import { destinationPoint, lookAngles } from "../lib/geo";
import { KM_PER_FT, KM_PER_NM, formatAltitudeFt } from "../lib/units";
import { norm } from "../lib/search";

export interface AircraftState {
  status: "idle" | "loading" | "ready" | "error";
  count: number;
  source?: string;
  fetchedAt?: number;
  error?: string;
}

interface Ac {
  hex: string;
  flight: string;
  reg: string;
  type: string;
  desc: string;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKts: number | null;
  track: number | null;
  vrate: number | null;
  squawk: string;
  onGround: boolean;
  category: string;
  ageSec: number;
}

interface Sample {
  fetchedAt: number;
  source: string;
  aircraft: Ac[];
}

const POLL_MS = 10_000;
const RADIUS_NM = 250;

/** Live aircraft near the origin, polled every 10 s and dead-reckoned between polls. */
export function useAircraft(now: number, origin: Origin, enabled: boolean): { targets: Target[]; state: AircraftState } {
  const [sample, setSample] = useState<Sample | null>(null);
  const [state, setState] = useState<AircraftState>({ status: "idle", count: 0 });
  const prev = useRef(new Map<string, { d: number; t: number }>());
  const olat = Math.round(origin.lat * 20) / 20;
  const olon = Math.round(origin.lon * 20) / 20;

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle", count: 0 });
      return;
    }
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const r = await fetch(`/api/aircraft?lat=${olat}&lon=${olon}&nm=${RADIUS_NM}`);
        const j = (await r.json()) as Sample & { error?: string; count?: number };
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setSample({ fetchedAt: j.fetchedAt, source: j.source, aircraft: j.aircraft });
        setState({ status: "ready", count: j.aircraft.length, source: j.source, fetchedAt: j.fetchedAt });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, status: "error", error: (e as Error).message }));
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };
    setState((s) => ({ ...s, status: "loading" }));
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [olat, olon, enabled]);

  const targets = useMemo(() => {
    if (!enabled || !sample) return [];
    const out: Target[] = [];
    for (const a of sample.aircraft) {
      const sampleTime = sample.fetchedAt - a.ageSec * 1000;
      const dt = Math.max(0, Math.min(600, (now - sampleTime) / 1000)); // seconds since the position report
      let { lat, lon } = a;
      if (a.gsKts && a.track !== null && !a.onGround) {
        const moved = destinationPoint(lat, lon, a.track, ((a.gsKts * KM_PER_NM) / 3600) * dt);
        lat = moved.lat;
        lon = moved.lon;
      }
      const altFt = a.altFt === null ? null : a.onGround ? 0 : a.altFt + ((a.vrate ?? 0) / 60) * dt;
      const hKm = altFt === null ? 0 : altFt * KM_PER_FT;
      const look = lookAngles(origin.lat, origin.lon, (origin.alt ?? 0) / 1000, lat, lon, hKm);
      const id = `air-${a.hex}`;
      const p = prev.current.get(id);
      prev.current.set(id, { d: look.rangeKm, t: now });
      const rate = p && now > p.t ? (look.rangeKm - p.d) / ((now - p.t) / 1000) : undefined;
      const name = a.flight || a.reg || a.hex.toUpperCase();
      const speedKms = a.gsKts ? (a.gsKts * KM_PER_NM) / 3600 : undefined;
      out.push({
        id,
        name,
        category: "aircraft",
        subtitle: [a.desc || a.type, a.reg].filter(Boolean).join(" · ") || "Aircraft",
        key: norm(`${name} ${a.reg} ${a.type} ${a.desc} aircraft`),
        distanceKm: look.rangeKm,
        rateKms: rate,
        lat,
        lon,
        heightKm: hKm,
        altDeg: look.elDeg,
        azDeg: look.azDeg,
        heading: a.track ?? undefined,
        speedKms,
        note: `${formatAltitudeFt(altFt)}${a.gsKts ? ` · ${Math.round(a.gsKts)} kts` : ""}${a.track !== null ? ` · heading ${Math.round(a.track)}°` : ""}`,
        kind: a.onGround ? "ground" : "airborne",
        facts: [
          ["Callsign", a.flight || "unknown"],
          ["Registration", a.reg || "unknown"],
          ["Aircraft", [a.desc, a.type].filter(Boolean).join(" · ") || "unknown"],
          ["Altitude", formatAltitudeFt(altFt)],
          ["Ground speed", a.gsKts ? `${Math.round(a.gsKts)} kts (${Math.round(a.gsKts * KM_PER_NM)} km/h)` : "unknown"],
          ["Vertical rate", a.vrate ? `${a.vrate > 0 ? "+" : ""}${Math.round(a.vrate)} ft/min` : "level"],
          ["Heading", a.track !== null ? `${Math.round(a.track)}°` : "unknown"],
          ["Squawk", a.squawk || "none"],
          ["Position age", `${Math.round(dt)} s (dead-reckoned)`],
          ["Source", `${sample.source} ADS-B`],
        ],
      });
    }
    return out;
  }, [now, sample, origin.lat, origin.lon, origin.alt, enabled]);

  return { targets, state };
}
