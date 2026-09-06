// Orbit shapes for the 3D solar-system view: heliocentric osculating elements for small bodies
// (drawn as ellipses or hyperbolae in the browser) and sampled heliocentric trajectories for
// spacecraft. Ecliptic J2000 frame, AU. Refreshed monthly and cached on disk.
import { readCache, writeCache, sleep } from "./cache";
import { allBodies, extractCsvRows, fmtUtc, horizonsQuery, isRefreshing, jdToMs, runPool, type HorizonsBody } from "./horizons";

export interface OrbitElements {
  epochJd: number;
  e: number;
  q: number; // perihelion distance, AU
  i: number; // deg
  om: number; // longitude of ascending node, deg
  w: number; // argument of perihelion, deg
  tp: number; // time of perihelion, JD
  n: number; // mean motion, deg/day
  ma: number; // mean anomaly, deg
  a: number | null; // semi-major axis, AU (null for hyperbolic)
  period: number | null; // days
}

export interface OrbitInfo {
  id: string;
  name: string;
  kind: string;
  status: "ok" | "error" | "pending";
  error?: string;
  fetchedAt?: number;
  elements?: OrbitElements;
  trail?: { t0: number; stepSec: number; rows: number[][] }; // [x, y, z] AU, ecliptic J2000
}

const ELEMENT_KINDS = new Set(["dwarf", "asteroid", "tno", "centaur", "comet", "interstellar", "neo"]);
const TRAIL_KINDS = new Set(["probe"]);
const TTL_MS = 30 * 24 * 3600e3;
const NEO_TTL_MS = 7 * 24 * 3600e3;
const RETRY_MS = 60 * 60e3;
const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const orbits = new Map<string, OrbitInfo>();
const nextTry = new Map<string, number>();
let refreshing: Promise<void> | null = null;

const keyOf = (id: string): string => `orbit-${id.replace(/[^A-Za-z0-9-]+/g, "_")}`;

function wanted(b: HorizonsBody): boolean {
  return ELEMENT_KINDS.has(b.kind) || TRAIL_KINDS.has(b.kind);
}

async function fetchElements(b: HorizonsBody, now: number): Promise<OrbitElements> {
  const text = await horizonsQuery({
    COMMAND: `'${b.id}'`,
    OBJ_DATA: "NO",
    MAKE_EPHEM: "YES",
    EPHEM_TYPE: "ELEMENTS",
    CENTER: "'500@10'", // the Sun
    REF_PLANE: "ECLIPTIC",
    OUT_UNITS: "AU-D",
    CSV_FORMAT: "YES",
    START_TIME: `'${fmtUtc(now)}'`,
    STOP_TIME: `'${fmtUtc(now + 86400e3)}'`,
    STEP_SIZE: "'1d'",
  });
  const row = extractCsvRows(text)[0];
  if (!row || row.length < 14) throw new Error("no elements returned");
  // JDTDB, date, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
  const v = row.map(Number);
  const e = v[2];
  return {
    epochJd: v[0], e, q: v[3], i: v[4], om: v[5], w: v[6], tp: v[7], n: v[8], ma: v[9],
    a: e < 1 && Number.isFinite(v[11]) ? v[11] : null,
    period: e < 1 && Number.isFinite(v[13]) ? v[13] : null,
  };
}

function parseLimit(msg: string): { kind: "prior" | "after"; ms: number } | null {
  const m = /(prior to|after) A\.D\. (\d{4})-([A-Z]{3})-(\d{2})/i.exec(msg);
  if (!m) return null;
  const month = MONTHS[m[3].toUpperCase()];
  if (month === undefined) return null;
  return { kind: m[1].toLowerCase().startsWith("prior") ? "prior" : "after", ms: Date.UTC(Number(m[2]), month, Number(m[4])) };
}

async function fetchTrail(b: HorizonsBody, now: number): Promise<OrbitInfo["trail"]> {
  let start = now - 3 * 365.25 * 86400e3;
  let stop = now + 2 * 365.25 * 86400e3;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await horizonsQuery({
        COMMAND: `'${b.id}'`,
        OBJ_DATA: "NO",
        MAKE_EPHEM: "YES",
        EPHEM_TYPE: "VECTORS",
        CENTER: "'500@10'",
        REF_PLANE: "ECLIPTIC",
        VEC_TABLE: "1",
        CSV_FORMAT: "YES",
        OUT_UNITS: "AU-D",
        START_TIME: `'${fmtUtc(start)}'`,
        STOP_TIME: `'${fmtUtc(stop)}'`,
        STEP_SIZE: "'10d'",
      });
      const rows: number[][] = [];
      const jds: number[] = [];
      for (const p of extractCsvRows(text)) {
        if (p.length < 5) continue;
        const xyz = p.slice(2, 5).map(Number);
        if (xyz.some((x) => !Number.isFinite(x))) continue;
        jds.push(Number(p[0]));
        rows.push(xyz.map((x) => Math.round(x * 1e5) / 1e5));
      }
      if (rows.length < 2) throw new Error("too few trail rows");
      return { t0: jdToMs(jds[0]), stepSec: Math.round((jds[1] - jds[0]) * 86400), rows };
    } catch (err) {
      const limit = parseLimit((err as Error).message);
      if (!limit) throw err;
      if (limit.kind === "prior") start = limit.ms + 2 * 86400e3;
      else stop = limit.ms - 2 * 86400e3;
      if (stop - start < 30 * 86400e3) throw err;
    }
  }
  throw new Error("could not fit the trajectory span");
}

export function loadOrbitsFromDisk(): void {
  for (const b of allBodies()) {
    if (!wanted(b) || orbits.has(b.id)) continue;
    const cached = readCache<OrbitInfo>(keyOf(b.id));
    orbits.set(b.id, cached?.data?.status === "ok" ? cached.data : { id: b.id, name: b.name, kind: b.kind, status: "pending" });
  }
}

export function ensureOrbitsRefresh(): Promise<void> {
  if (refreshing) return refreshing;
  // Never run alongside the position-table refresh: Horizons rate-limits parallel clients with 503s.
  if (isRefreshing()) return Promise.resolve();
  refreshing = (async () => {
    loadOrbitsFromDisk();
    const now = Date.now();
    const stale = allBodies().filter((b) => {
      if (!wanted(b)) return false;
      const o = orbits.get(b.id);
      const ttl = b.kind === "neo" ? NEO_TTL_MS : TTL_MS;
      return (!o || o.status !== "ok" || !o.fetchedAt || now - o.fetchedAt > ttl) && (nextTry.get(b.id) ?? 0) <= now;
    });
    if (stale.length === 0) return;
    console.log(`[orbits] refreshing ${stale.length} orbits`);
    await runPool(stale, 1, async (b) => {
      try {
        const info: OrbitInfo = { id: b.id, name: b.name, kind: b.kind, status: "ok", fetchedAt: Date.now() };
        if (ELEMENT_KINDS.has(b.kind)) info.elements = await fetchElements(b, now);
        else info.trail = await fetchTrail(b, now);
        orbits.set(b.id, info);
        writeCache(keyOf(b.id), info);
        nextTry.delete(b.id);
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`[orbits] ${b.name}: ${msg}`);
        const prev = orbits.get(b.id);
        if (!prev || prev.status !== "ok") orbits.set(b.id, { id: b.id, name: b.name, kind: b.kind, status: "error", error: msg });
        nextTry.set(b.id, Date.now() + RETRY_MS);
      }
      await sleep(200);
    });
    console.log("[orbits] refresh done");
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function getOrbits(): { generatedAt: number; pending: number; refreshing: boolean; bodies: OrbitInfo[] } {
  void ensureOrbitsRefresh();
  const bodies = allBodies()
    .filter(wanted)
    .map((b) => orbits.get(b.id) ?? { id: b.id, name: b.name, kind: b.kind, status: "pending" as const });
  return { generatedAt: Date.now(), pending: bodies.filter((b) => b.status === "pending").length, refreshing: refreshing !== null, bodies };
}
