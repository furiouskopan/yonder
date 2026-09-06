// Orbit shapes for the solar-system view, from the server's /api/orbits.
import type { Vec3 } from "../types";

export interface OrbitElements {
  epochJd: number;
  e: number;
  q: number; // perihelion distance, AU
  i: number;
  om: number;
  w: number;
  tp: number;
  n: number;
  ma: number;
  a: number | null;
  period: number | null;
}

export interface OrbitTrail {
  t0: number;
  stepSec: number;
  rows: number[][]; // [x, y, z] AU, ecliptic J2000
}

export interface OrbitInfo {
  id: string;
  name: string;
  kind: string;
  status: "ok" | "error" | "pending";
  error?: string;
  elements?: OrbitElements;
  trail?: OrbitTrail;
}

export interface OrbitsResponse {
  generatedAt: number;
  pending: number;
  refreshing: boolean;
  bodies: OrbitInfo[];
}

const D2R = Math.PI / 180;

/** Points along a conic orbit from its elements: a closed ellipse for e < 1, an open hyperbola branch otherwise. */
export function conicPath(el: OrbitElements, n = 256, maxAu = 300): Vec3[] {
  const { e, q } = el;
  const p = q * (1 + e);
  const cO = Math.cos(el.om * D2R);
  const sO = Math.sin(el.om * D2R);
  const ci = Math.cos(el.i * D2R);
  const si = Math.sin(el.i * D2R);
  const cw = Math.cos(el.w * D2R);
  const sw = Math.sin(el.w * D2R);
  const numax = e < 1 ? Math.PI : Math.acos(-1 / e) * 0.985;
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const nu = -numax + (2 * numax * k) / n;
    const r = p / (1 + e * Math.cos(nu));
    if (!Number.isFinite(r) || r <= 0 || r > maxAu) continue;
    const xp = r * Math.cos(nu);
    const yp = r * Math.sin(nu);
    // perifocal → ecliptic: Rz(Ω) · Rx(i) · Rz(ω)
    const x1 = cw * xp - sw * yp;
    const y1 = sw * xp + cw * yp;
    const y2 = ci * y1;
    const z2 = si * y1;
    out.push({ x: cO * x1 - sO * y2, y: sO * x1 + cO * y2, z: z2 });
  }
  return out;
}
