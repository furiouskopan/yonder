import type { Vec3 } from "../types";

export const EARTH_RADIUS_KM = 6371.0088;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const WGS_A = 6378.137;
const WGS_F = 1 / 298.257223563;
const WGS_E2 = WGS_F * (2 - WGS_F);

/** Great-circle distance along the surface, km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R;
  const dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Straight-line distance through the Earth for a given surface distance, km. */
export function chordKm(surfaceKm: number): number {
  return 2 * EARTH_RADIUS_KM * Math.sin(surfaceKm / (2 * EARTH_RADIUS_KM));
}

/** Initial compass bearing from point 1 to point 2, degrees clockwise from north. */
export function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compass(bearing: number): string {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
}

export function antipode(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: -lat, lon: lon > 0 ? lon - 180 : lon + 180 };
}

export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Point reached after travelling `distKm` from (lat, lon) on the given bearing. */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distKm: number): { lat: number; lon: number } {
  const d = distKm / EARTH_RADIUS_KM;
  const b = bearingDeg * D2R;
  const p1 = lat * D2R;
  const l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: normalizeLon(l2 * R2D) };
}

/** WGS84 geodetic → Earth-centred, Earth-fixed coordinates, km. */
export function geodeticToEcef(lat: number, lon: number, hKm: number): Vec3 {
  const p = lat * D2R;
  const l = lon * D2R;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const n = WGS_A / Math.sqrt(1 - WGS_E2 * sp * sp);
  return { x: (n + hKm) * cp * Math.cos(l), y: (n + hKm) * cp * Math.sin(l), z: (n * (1 - WGS_E2) + hKm) * sp };
}

/** Straight-line range, azimuth and elevation from an observer to a point at altitude. */
export function lookAngles(
  obsLat: number,
  obsLon: number,
  obsHKm: number,
  tLat: number,
  tLon: number,
  tHKm: number,
): { rangeKm: number; azDeg: number; elDeg: number } {
  const o = geodeticToEcef(obsLat, obsLon, obsHKm);
  const t = geodeticToEcef(tLat, tLon, tHKm);
  const dx = t.x - o.x;
  const dy = t.y - o.y;
  const dz = t.z - o.z;
  const p = obsLat * D2R;
  const l = obsLon * D2R;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sl = Math.sin(l);
  const cl = Math.cos(l);
  const east = -sl * dx + cl * dy;
  const north = -sp * cl * dx - sp * sl * dy + cp * dz;
  const up = cp * cl * dx + cp * sl * dy + sp * dz;
  const rangeKm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { rangeKm, azDeg: (Math.atan2(east, north) * R2D + 360) % 360, elDeg: Math.asin(Math.max(-1, Math.min(1, up / rangeKm))) * R2D };
}

/** Points along the great circle from 1 to 2 (spherical interpolation). */
export function greatCirclePath(lat1: number, lon1: number, lat2: number, lon2: number, n = 96): [number, number][] {
  const toVec = (lat: number, lon: number) => {
    const p = lat * D2R;
    const l = lon * D2R;
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  };
  const a = toVec(lat1, lon1);
  const b = toVec(lat2, lon2);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return [[lat1, lon1], [lat2, lon2]];
  if (Math.PI - omega < 1e-6) {
    const pole = lat1 >= 0 ? 90 : -90;
    return [...greatCirclePath(lat1, lon1, pole, lon1, n / 2), ...greatCirclePath(pole, lon2, lat2, lon2, n / 2)];
  }
  const out: [number, number][] = [];
  const so = Math.sin(omega);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s1 = Math.sin((1 - t) * omega) / so;
    const s2 = Math.sin(t * omega) / so;
    const x = s1 * a[0] + s2 * b[0];
    const y = s1 * a[1] + s2 * b[1];
    const z = s1 * a[2] + s2 * b[2];
    out.push([Math.atan2(z, Math.hypot(x, y)) * R2D, Math.atan2(y, x) * R2D]);
  }
  return out;
}

/** Split a lat/lon path into segments wherever it crosses the ±180° meridian. */
export function splitAtDateline(points: [number, number][]): [number, number][][] {
  const segs: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && Math.abs(points[i][1] - points[i - 1][1]) > 180) {
      segs.push(cur);
      cur = [];
    }
    cur.push(points[i]);
  }
  if (cur.length) segs.push(cur);
  return segs.filter((s) => s.length > 1);
}
