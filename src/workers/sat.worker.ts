// Web Worker: propagates satellite orbits (SGP4 via satellite.js) and returns, for every satellite,
// its distance from the observer, look angles, ground point, height and speed.
import * as satellite from "satellite.js";

type Vec3 = { x: number; y: number; z: number };
type Geodetic = { longitude: number; latitude: number; height: number };

// satellite.js declares branded unit types; this thin facade keeps the worker independent of them.
const S = satellite as unknown as {
  twoline2satrec(l1: string, l2: string): { error: number };
  propagate(rec: unknown, date: Date): { position?: Vec3 | boolean | null; velocity?: Vec3 | boolean | null } | null | undefined;
  gstime(date: Date): number;
  eciToEcf(p: Vec3, gmst: number): Vec3;
  eciToGeodetic(p: Vec3, gmst: number): Geodetic;
  ecfToLookAngles(gd: Geodetic, ecf: Vec3): { azimuth: number; elevation: number; rangeSat: number };
  geodeticToEcf(gd: Geodetic): Vec3;
};

type InMsg =
  | { type: "load"; gen: number; sats: { norad: number; l1: string; l2: string }[] }
  | { type: "origin"; lat: number; lon: number; altKm: number }
  | { type: "tick"; t: number }
  | { type: "track"; index: number; norad: number; t: number; minutes: number; stepSec: number }
  | { type: "passes"; index: number; norad: number; t: number; hours: number; stepSec: number; minEl: number };

interface Pass {
  start: number;
  max: number;
  end: number;
  maxEl: number;
  startAz: number;
  maxAz: number;
  endAz: number;
  truncated?: boolean; // still above the horizon when the search window ended
}

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const STRIDE = 7;

let recs: (unknown | null)[] = [];
let gen = 0;
let obsGd: Geodetic = { longitude: 0, latitude: 0, height: 0 };
let obsEcf: Vec3 = S.geodeticToEcf(obsGd);

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

function isVec(v: Vec3 | boolean | null | undefined): v is Vec3 {
  return typeof v === "object" && v !== null && Number.isFinite(v.x);
}

function tick(t: number): void {
  const date = new Date(t);
  const gmst = S.gstime(date);
  const n = recs.length;
  const out = new Float32Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    const rec = recs[i];
    let ok = false;
    if (rec) {
      try {
        const pv = S.propagate(rec, date);
        const pos = pv?.position;
        if (isVec(pos)) {
          const ecf = S.eciToEcf(pos, gmst);
          const dx = ecf.x - obsEcf.x;
          const dy = ecf.y - obsEcf.y;
          const dz = ecf.z - obsEcf.z;
          const look = S.ecfToLookAngles(obsGd, ecf);
          const gd = S.eciToGeodetic(pos, gmst);
          const vel = pv?.velocity;
          out[o] = Math.sqrt(dx * dx + dy * dy + dz * dz);
          out[o + 1] = look.azimuth * R2D;
          out[o + 2] = look.elevation * R2D;
          out[o + 3] = gd.latitude * R2D;
          out[o + 4] = gd.longitude * R2D;
          out[o + 5] = gd.height;
          out[o + 6] = isVec(vel) ? Math.hypot(vel.x, vel.y, vel.z) : NaN;
          ok = Number.isFinite(out[o]) && Number.isFinite(gd.height);
        }
      } catch {
        ok = false; // decayed or numerically invalid element set
      }
    }
    if (!ok) out.fill(NaN, o, o + STRIDE);
  }
  ctx.postMessage({ type: "result", gen, t, data: out }, [out.buffer]);
}

function track(m: Extract<InMsg, { type: "track" }>): void {
  const rec = recs[m.index];
  const points: [number, number, number][] = [];
  if (rec) {
    const half = (m.minutes * 60e3) / 2;
    for (let dt = -half; dt <= half; dt += m.stepSec * 1000) {
      const date = new Date(m.t + dt);
      try {
        const pv = S.propagate(rec, date);
        const pos = pv?.position;
        if (!isVec(pos)) continue;
        const gd = S.eciToGeodetic(pos, S.gstime(date));
        points.push([gd.latitude * R2D, gd.longitude * R2D, gd.height]);
      } catch {
        /* skip */
      }
    }
  }
  ctx.postMessage({ type: "track", norad: m.norad, points });
}

/** Every interval in the next `hours` during which the satellite is above the observer's horizon. */
function passes(m: Extract<InMsg, { type: "passes" }>): void {
  const rec = recs[m.index];
  const out: Pass[] = [];
  if (rec) {
    let cur: Pass | null = null;
    let lastAz = 0;
    let lastT = m.t;
    const end = m.t + m.hours * 3600e3;
    for (let t = m.t; t <= end; t += m.stepSec * 1000) {
      const date = new Date(t);
      let el = -90;
      let az = 0;
      try {
        const pv = S.propagate(rec, date);
        const pos = pv?.position;
        if (isVec(pos)) {
          const look = S.ecfToLookAngles(obsGd, S.eciToEcf(pos, S.gstime(date)));
          el = look.elevation * R2D;
          az = look.azimuth * R2D;
        }
      } catch {
        el = -90;
      }
      if (el > 0) {
        if (!cur) cur = { start: t, max: t, end: t, maxEl: el, startAz: az, maxAz: az, endAz: az };
        else if (el > cur.maxEl) {
          cur.maxEl = el;
          cur.max = t;
          cur.maxAz = az;
        }
        lastAz = az;
        lastT = t;
      } else if (cur) {
        cur.end = lastT;
        cur.endAz = lastAz;
        if (cur.maxEl >= m.minEl) out.push(cur);
        cur = null;
      }
    }
    if (cur) {
      cur.end = lastT;
      cur.endAz = lastAz;
      cur.truncated = true;
      if (cur.maxEl >= m.minEl) out.push(cur);
    }
  }
  ctx.postMessage({ type: "passes", norad: m.norad, passes: out });
}

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as InMsg;
  switch (m.type) {
    case "load": {
      gen = m.gen;
      recs = m.sats.map((s) => {
        try {
          const r = S.twoline2satrec(s.l1, s.l2);
          return r.error ? null : r;
        } catch {
          return null;
        }
      });
      ctx.postMessage({ type: "loaded", gen, count: recs.filter(Boolean).length });
      break;
    }
    case "origin":
      obsGd = { longitude: m.lon * D2R, latitude: m.lat * D2R, height: m.altKm };
      obsEcf = S.geodeticToEcf(obsGd);
      break;
    case "tick":
      tick(m.t);
      break;
    case "track":
      track(m);
      break;
    case "passes":
      passes(m);
      break;
  }
};
