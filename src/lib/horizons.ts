// Client-side handling of the NASA Horizons vector tables served by /api/horizons.
export type BodyKind = "probe" | "dwarf" | "asteroid" | "tno" | "centaur" | "comet" | "interstellar" | "moon" | "neo";

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

/** Cubic Hermite interpolation between hourly rows using the tabulated velocities. */
export function interpolate(t: BodyTable, tMs: number): State6 | null {
  if (t.status !== "ok" || !t.rows || t.rows.length < 2 || t.t0 === undefined || !t.stepSec) return null;
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
