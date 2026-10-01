// Client-side handling of the NASA Horizons vector tables served by /api/horizons.
export type BodyKind = "planet" | "probe" | "dwarf" | "asteroid" | "tno" | "centaur" | "comet" | "interstellar" | "moon" | "neo";

export interface BodyTable {
  id: string;
  name: string;
  kind: BodyKind;
  note?: string;
  parent?: string;
  facts?: [string, string][];
  status: "ok" | "error" | "pending";
  error?: string;
  fetchedAt?: number;
  t0?: number;
  stepSec?: number;
  rows?: number[][]; // [x, y, z, vx, vy, vz] in km and km/s, Earth-centred ICRF
}

export interface HorizonsResponse {
  generatedAt: number;
  pending: number;
  refreshing: boolean;
  bodies: BodyTable[];
}

export interface State6 {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export const KIND_LABELS: Record<BodyKind, string> = {
  planet: "Planet",
  probe: "Spacecraft",
  dwarf: "Dwarf planet",
  asteroid: "Asteroid",
  tno: "Trans-Neptunian object",
  centaur: "Centaur",
  comet: "Comet",
  interstellar: "Interstellar object",
  moon: "Moon",
  neo: "Near-Earth flyby",
};

/**
 * How far outside its table a body may be extrapolated before its position is treated as unknown. Linear
 * extrapolation of a moon goes wrong within hours (it is orbiting), a close-approach asteroid within a day;
 * everything else moves in near-straight lines relative to Earth for a few days. Tables normally never run out
 * (the server refreshes them with 12 h to spare); this guards a restart with an old cache or a long outage.
 */
export const MAX_OUTSIDE_MS: Record<BodyKind, number> = {
  planet: 2 * 3600e3,
  moon: 1 * 3600e3,
  neo: 6 * 3600e3,
  probe: 72 * 3600e3,
  dwarf: 72 * 3600e3,
  asteroid: 72 * 3600e3,
  tno: 72 * 3600e3,
  centaur: 72 * 3600e3,
  comet: 72 * 3600e3,
  interstellar: 72 * 3600e3,
};

/** Milliseconds by which `tMs` lies outside the table's time span (0 inside it, Infinity without data). */
export function outsideMs(t: BodyTable, tMs: number): number {
  if (t.status !== "ok" || !t.rows || t.rows.length < 2 || t.t0 === undefined || !t.stepSec) return Infinity;
  const end = t.t0 + t.stepSec * 1000 * (t.rows.length - 1);
  return tMs < t.t0 ? t.t0 - tMs : tMs > end ? tMs - end : 0;
}

/**
 * Cubic Hermite interpolation between hourly rows using the tabulated velocities. Outside the table it
 * extrapolates linearly from the nearest row, but returns null once `tMs` is more than `maxOutsideMs`
 * beyond either end.
 */
export function interpolate(t: BodyTable, tMs: number, maxOutsideMs = Infinity): State6 | null {
  if (t.status !== "ok" || !t.rows || t.rows.length < 2 || t.t0 === undefined || !t.stepSec) return null;
  if (outsideMs(t, tMs) > maxOutsideMs) return null;
  const rows = t.rows;
  const h = t.stepSec;
  const f = (tMs - t.t0) / (h * 1000);
  const n = rows.length;
  let i = Math.floor(f);
  if (i < 0) i = 0;
  if (i > n - 2) i = n - 2;
  const u = f - i;
  const a = rows[i];
  const b = rows[i + 1];
  if (u < -1 || u > 2) {
    const r = u < 0 ? a : b;
    const dt = (u < 0 ? u : u - 1) * h;
    return { x: r[0] + r[3] * dt, y: r[1] + r[4] * dt, z: r[2] + r[5] * dt, vx: r[3], vy: r[4], vz: r[5] };
  }
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const d00 = 6 * u2 - 6 * u;
  const d10 = 3 * u2 - 4 * u + 1;
  const d01 = -6 * u2 + 6 * u;
  const d11 = 3 * u2 - 2 * u;
  const out = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const p0 = a[k];
    const p1 = b[k];
    const m0 = a[k + 3] * h;
    const m1 = b[k + 3] * h;
    out[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    out[k + 3] = (d00 * p0 + d10 * m0 + d01 * p1 + d11 * m1) / h;
  }
  return { x: out[0], y: out[1], z: out[2], vx: out[3], vy: out[4], vz: out[5] };
}
