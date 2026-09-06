import { useCallback, useEffect, useRef, useState } from "react";
import type { Origin, Target } from "../types";
import { norm } from "../lib/search";

export interface SatSetInfo {
  id: string;
  label: string;
  approx: number;
  description: string;
}

export interface SatState {
  status: "idle" | "loading" | "ready" | "error";
  count: number;
  error?: string;
  fetchedAt?: number;
}

interface SatFacts {
  owner: string;
  launched: string;
  site: string;
  type: string;
  status: string;
  period: number | null;
  inc: number | null;
  apogee: number | null;
  perigee: number | null;
  rcs: number | null;
}

interface SatMeta {
  norad: number;
  name: string;
  intl: string;
  group: string;
  cls: string;
  key: string;
  facts?: SatFacts;
  wiki: string;
}

interface ApiSet {
  set: string;
  fetchedAt: number;
  count: number;
  errors: string[];
  sats: { name: string; l1: string; l2: string; norad: number; intl: string; group: string; cls: string; facts?: SatFacts }[];
}

export const CLASS_LABELS: Record<string, string> = {
  station: "Space station",
  navigation: "Navigation satellite",
  communications: "Communications satellite",
  "earth-observation": "Earth observation satellite",
  science: "Science satellite",
  megaconstellation: "Internet constellation satellite",
  military: "Military satellite",
  cubesat: "CubeSat",
  "rocket-body": "Rocket body",
  debris: "Debris",
  other: "Satellite",
};

const WIKI_ALIASES: [RegExp, string][] = [
  [/^ISS \(ZARYA\)|^ISS$/, "International Space Station"],
  [/^CSS \(TIANHE\)|^TIANGONG|^CSS \(/, "Tiangong space station"],
  [/^HST$/, "Hubble Space Telescope"],
  [/^STARLINK/, "Starlink"],
  [/^ONEWEB/, "OneWeb"],
  [/^KUIPER/, "Amazon Leo"],
  [/^GPS |^NAVSTAR/, "Global Positioning System"],
  [/^GALILEO|^GSAT0/, "Galileo (satellite navigation)"],
  [/GLONASS/, "GLONASS"],
  [/^BEIDOU/, "BeiDou"],
  [/^IRIDIUM/, "Iridium satellite constellation"],
  [/^NOAA /, "NOAA satellites"],
  [/^GOES/, "Geostationary Operational Environmental Satellite"],
  [/^METOP/, "MetOp"],
  [/^METEOSAT|^MSG-|^MTG-/, "Meteosat"],
  [/^SENTINEL/, "Copernicus Programme"],
  [/^LANDSAT/, "Landsat program"],
  [/^TERRA$/, "Terra (satellite)"],
  [/^AQUA$/, "Aqua (satellite)"],
  [/^TESS$/, "Transiting Exoplanet Survey Satellite"],
  [/^FERMI/, "Fermi Gamma-ray Space Telescope"],
  [/^CHANDRA|^AXAF/, "Chandra X-ray Observatory"],
  [/^XMM/, "XMM-Newton"],
  [/^SWIFT$/, "Neil Gehrels Swift Observatory"],
  [/^NUSTAR/, "NuSTAR"],
  [/^IXPE/, "IXPE"],
  [/^SDO$/, "Solar Dynamics Observatory"],
  [/^LAGEOS/, "LAGEOS"],
  [/^TDRS/, "Tracking and Data Relay Satellite"],
  [/^INTELSAT/, "Intelsat"],
  [/^EUTELSAT/, "Eutelsat"],
  [/^INMARSAT/, "Inmarsat"],
  [/^ORBCOMM/, "Orbcomm"],
  [/^GLOBALSTAR/, "Globalstar"],
  [/^O3B/, "O3b"],
  [/^SES-/, "SES S.A."],
  [/^PROGRESS/, "Progress (spacecraft)"],
  [/^SOYUZ/, "Soyuz (spacecraft)"],
  [/^CYGNUS/, "Cygnus (spacecraft)"],
  [/^CREW DRAGON|^DRAGON/, "SpaceX Dragon 2"],
  [/^SHENZHOU/, "Shenzhou (spacecraft)"],
  [/^TIANZHOU/, "Tianzhou (spacecraft)"],
  [/^FLOCK/, "Planet Labs"],
  [/^LEMUR/, "Spire Global"],
  [/^SKYSAT/, "SkySat"],
  [/^YAOGAN/, "Yaogan"],
  [/^FENGYUN|^FY-/, "Fengyun"],
  [/^HIMAWARI/, "Himawari (satellite)"],
  [/^JASON/, "Jason-3"],
  [/^SWOT/, "Surface Water and Ocean Topography"],
  [/^GRACE/, "GRACE-FO"],
  [/^ICESAT/, "ICESat-2"],
  [/^SMAP/, "Soil Moisture Active Passive"],
  [/^GPM/, "Global Precipitation Measurement"],
  [/^AJISAI|^EGS/, "Ajisai"],
  [/^DSCOVR/, "Deep Space Climate Observatory"],
  [/^ACE$/, "Advanced Composition Explorer"],
  [/^WIND$/, "Wind (spacecraft)"],
  [/^SOHO/, "Solar and Heliospheric Observatory"],
  [/^COSMOS /, "Kosmos (satellite)"],
  [/^ENVISAT/, "Envisat"],
];

function wikiHint(name: string): string {
  for (const [re, title] of WIKI_ALIASES) if (re.test(name)) return title;
  return name.replace(/\s*\(.*\)\s*$/, "");
}

function launchYear(intl: string): string {
  const yy = parseInt(intl.slice(0, 2), 10);
  if (!Number.isFinite(yy)) return "?";
  return String(yy >= 57 ? 1900 + yy : 2000 + yy);
}

const STRIDE = 7; // values per satellite in the worker result

export function useSatellites(now: number, origin: Origin, setId: string) {
  const workerRef = useRef<Worker | null>(null);
  const metaRef = useRef<SatMeta[]>([]);
  const genRef = useRef(0);
  const prevRef = useRef<{ t: number; dist: Float32Array } | null>(null);
  const busyRef = useRef(false);
  const trackWaiters = useRef(new Map<number, (pts: [number, number][]) => void>());
  const [targets, setTargets] = useState<Target[]>([]);
  const [state, setState] = useState<SatState>({ status: "idle", count: 0 });
  const [sets, setSets] = useState<SatSetInfo[]>([]);

  useEffect(() => {
    fetch("/api/satellites/sets")
      .then((r) => (r.ok ? (r.json() as Promise<SatSetInfo[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setSets)
      .catch(() => setSets([]));
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("../workers/sat.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type: "result"; gen: number; t: number; data: Float32Array }
        | { type: "track"; norad: number; points: [number, number][] }
        | { type: "loaded"; gen: number; count: number };
      if (m.type === "result") {
        busyRef.current = false;
        if (m.gen !== genRef.current) return;
        const meta = metaRef.current;
        const prev = prevRef.current;
        const dt = prev ? (m.t - prev.t) / 1000 : 0;
        const out: Target[] = [];
        const dist = new Float32Array(meta.length);
        for (let i = 0; i < meta.length; i++) {
          const o = i * STRIDE;
          const d = m.data[o];
          dist[i] = d;
          if (!Number.isFinite(d)) continue;
          const mt = meta[i];
          const rate = prev && dt > 0 && Number.isFinite(prev.dist[i]) ? (d - prev.dist[i]) / dt : undefined;
          const height = m.data[o + 5];
          const f = mt.facts;
          out.push({
            id: `sat-${mt.norad}`,
            name: mt.name,
            category: "satellite",
            subtitle: `${CLASS_LABELS[mt.cls] ?? "Satellite"}${f?.owner ? ` · ${f.owner}` : ""}`,
            key: mt.key,
            distanceKm: d,
            rateKms: rate,
            azDeg: m.data[o + 1],
            altDeg: m.data[o + 2],
            subLat: m.data[o + 3],
            subLon: m.data[o + 4],
            heightKm: height,
            speedKms: m.data[o + 6],
            note: `${Math.round(height).toLocaleString()} km up · ${m.data[o + 6].toFixed(2)} km/s · launched ${f?.launched || launchYear(mt.intl)}`,
            kind: mt.cls,
            wiki: mt.wiki,
            facts: [
              ["NORAD ID", String(mt.norad)],
              ["International designator", mt.intl],
              ...(f
                ? ([
                    ["Owner", f.owner],
                    ["Launched", `${f.launched}${f.site ? ` from ${f.site}` : ""}`],
                    ["Object type", f.type],
                    ["Status", f.status],
                    ["Orbit", f.perigee !== null && f.apogee !== null ? `${Math.round(f.perigee).toLocaleString()} × ${Math.round(f.apogee).toLocaleString()} km` : "unknown"],
                    ["Period", f.period !== null ? `${f.period.toFixed(1)} min` : "unknown"],
                    ["Inclination", f.inc !== null ? `${f.inc.toFixed(1)}°` : "unknown"],
                    ["Radar cross-section", f.rcs !== null ? `${f.rcs} m²` : "unknown"],
                  ] as [string, string][])
                : []),
            ],
          });
        }
        prevRef.current = { t: m.t, dist };
        setTargets(out);
      } else if (m.type === "track") {
        const cb = trackWaiters.current.get(m.norad);
        if (cb) {
          trackWaiters.current.delete(m.norad);
          cb(m.points);
        }
      } else if (m.type === "loaded") {
        if (m.gen === genRef.current) setState((s) => ({ ...s, status: "ready", count: m.count }));
      }
    };
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "origin", lat: origin.lat, lon: origin.lon, altKm: (origin.alt ?? 0) / 1000 });
  }, [origin.lat, origin.lon, origin.alt]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", count: 0 });
    setTargets([]);
    prevRef.current = null;
    metaRef.current = [];
    fetch(`/api/satellites/${encodeURIComponent(setId)}`)
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as ApiSet;
      })
      .then((api) => {
        if (cancelled) return;
        genRef.current += 1;
        metaRef.current = api.sats.map((s) => ({
          norad: s.norad,
          name: s.name,
          intl: s.intl,
          group: s.group,
          cls: s.cls,
          key: norm(`${s.name} ${CLASS_LABELS[s.cls] ?? ""} ${s.facts?.owner ?? ""}`),
          facts: s.facts,
          wiki: wikiHint(s.name),
        }));
        prevRef.current = null;
        busyRef.current = false;
        workerRef.current?.postMessage({ type: "load", gen: genRef.current, sats: api.sats.map((s) => ({ norad: s.norad, l1: s.l1, l2: s.l2 })) });
        setState({ status: "ready", count: api.count, fetchedAt: api.fetchedAt, error: api.errors?.length ? api.errors.join("; ") : undefined });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ status: "error", count: 0, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [setId]);

  useEffect(() => {
    if (busyRef.current || metaRef.current.length === 0) return;
    busyRef.current = true;
    workerRef.current?.postMessage({ type: "tick", t: now });
  }, [now]);

  const trackOf = useCallback((targetId: string, t: number, minutes = 92): Promise<[number, number][]> => {
    const norad = Number(targetId.replace("sat-", ""));
    const index = metaRef.current.findIndex((m) => m.norad === norad);
    if (index < 0 || !workerRef.current) return Promise.resolve([]);
    return new Promise((resolve) => {
      trackWaiters.current.set(norad, resolve);
      workerRef.current?.postMessage({ type: "track", index, norad, t, minutes, stepSec: 30 });
    });
  }, []);

  return { targets, state, sets, trackOf };
}
