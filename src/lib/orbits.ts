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
  fetchedAt?: number;
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

/**
 * Points along a conic orbit from its elements: a closed ellipse for e < 1 (sampled by true anomaly, dense near
 * perihelion), an open hyperbola for e > 1 (sampled by hyperbolic anomaly out to `maxAu`, so the line reaches an
 * interstellar object wherever it is: a true-anomaly cut-off at 98.5 % of the asymptote angle stopped
 * ʻOumuamua's line at 22 AU while the object was at 55 AU), or a parabola for e = 1.
 */
export function conicPath(el: OrbitElements, n = 256, maxAu = 300): Vec3[] {
  const { e, q } = el;
  const cO = Math.cos(el.om * D2R);
  const sO = Math.sin(el.om * D2R);
  const ci = Math.cos(el.i * D2R);
  const si = Math.sin(el.i * D2R);
  const cw = Math.cos(el.w * D2R);
  const sw = Math.sin(el.w * D2R);
  const out: Vec3[] = [];
  // perifocal (perihelion along +x) → ecliptic: Rz(Ω) · Rx(i) · Rz(ω)
  const push = (xp: number, yp: number) => {
    if (!Number.isFinite(xp) || !Number.isFinite(yp)) return;
    const x1 = cw * xp - sw * yp;
    const y1 = sw * xp + cw * yp;
    const y2 = ci * y1;
    const z2 = si * y1;
    out.push({ x: cO * x1 - sO * y2, y: sO * x1 + cO * y2, z: z2 });
  };
  if (e > 1) {
    const a = q / (e - 1); // |semi-major axis|
    const b = a * Math.sqrt(e * e - 1);
    const fMax = Math.acosh(Math.max(1, (maxAu / a + 1) / e)); // r = a (e cosh F - 1)
    for (let k = 0; k <= n; k++) {
      const f = -fMax + (2 * fMax * k) / n;
      push(a * (e - Math.cosh(f)), b * Math.sinh(f));
    }
    return out;
  }
  const p = q * (1 + e);
  const numax = e < 1 ? Math.PI : Math.acos(Math.max(-1, Math.min(1, (p / maxAu - 1) / e)));
  for (let k = 0; k <= n; k++) {
    const nu = -numax + (2 * numax * k) / n;
    const r = p / (1 + e * Math.cos(nu));
    if (!Number.isFinite(r) || r <= 0 || r > maxAu * 1.001) continue;
    push(r * Math.cos(nu), r * Math.sin(nu));
  }
  return out;
}
