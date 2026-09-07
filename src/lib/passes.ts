// Satellite pass helpers shared by the worker results, the detail panel and the maps.
import { EARTH_RADIUS_KM, destinationPoint } from "./geo";

export interface Pass {
  start: number; // ms since epoch
  max: number;
  end: number;
  maxEl: number; // degrees
  startAz: number;
  maxAz: number;
  endAz: number;
  truncated?: boolean; // still up when the search window ended
}

export interface PassSet {
  id: string; // target id
  origin: string; // `${lat},${lon}` the passes were computed for
  at: number; // when the search started
  hours: number;
  passes: Pass[];
}

/** "in 1 h 23 min", "in 4 min 10 s", "now", "3 min ago". */
export function formatCountdown(ms: number): string {
  const s = Math.round(ms / 1000);
  const a = Math.abs(s);
  const suffix = s < 0 ? " ago" : "";
  const prefix = s < 0 ? "" : "in ";
  if (a < 5) return "now";
  if (a < 60) return `${prefix}${a} s${suffix}`;
  if (a < 3600) return `${prefix}${Math.floor(a / 60)} min${a % 60 && a < 600 ? ` ${a % 60} s` : ""}${suffix}`;
  const h = Math.floor(a / 3600);
  const m = Math.round((a % 3600) / 60);
  return `${prefix}${h} h${m ? ` ${m} min` : ""}${suffix}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export const formatClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Whether the pass list says the satellite never sets (geostationary or nearly so) within the window. */
export function alwaysUp(set: PassSet): boolean {
  const p = set.passes[0];
  return set.passes.length === 1 && p.start <= set.at + 60e3 && p.truncated === true;
}

/** The circle on the ground from which a satellite at `heightKm` above (subLat, subLon) is above the horizon. */
export function footprint(subLat: number, subLon: number, heightKm: number, n = 72): [number, number][] {
  const theta = Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(1, heightKm))); // central angle, radians
  const dist = theta * EARTH_RADIUS_KM;
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const p = destinationPoint(subLat, subLon, (360 * i) / n, dist);
    out.push([p.lat, p.lon]);
  }
  return out;
}
