import { useMemo } from "react";
import type { CustomPlace, Origin, Target } from "../types";
import type { StaticData } from "./useStaticData";
import type { PoiRow } from "./usePoi";
import { LANDMARKS } from "../data/landmarks";
import { EARTH_RADIUS_KM, antipode, haversineKm } from "../lib/geo";
import { norm } from "../lib/search";

/** The curated landmarks as targets, built once. Distances are assigned in place like every other Earth target. */
export const LANDMARK_TARGETS: Target[] = LANDMARKS.map((l, i) => ({
  id: `lm-${i}`,
  name: l.name,
  category: "landmark",
  subtitle: l.kind,
  key: norm(`${l.name} ${l.kind}`),
  distanceKm: NaN,
  lat: l.lat,
  lon: l.lon,
  note: l.note,
  kind: l.kind,
  wiki: l.name,
}));

/** Points that follow the origin. The antipode's coordinates are rewritten when the origin moves. */
const ANTIPODE: Target = { id: "antipode", name: "Antipode", category: "landmark", subtitle: "Computed", key: "antipode computed opposite", distanceKm: NaN, lat: 0, lon: 0, note: "The farthest surface point from you", kind: "computed", wiki: "Antipodes" };
const COMPUTED: Target[] = [
  ANTIPODE,
  { id: "earth-center", name: "Centre of the Earth", category: "landmark", subtitle: "Computed", key: "centre center of the earth computed", distanceKm: EARTH_RADIUS_KM, note: "Straight down", kind: "computed", wiki: "Earth's inner core" },
  { id: "karman", name: "Kármán line (edge of space)", category: "landmark", subtitle: "Computed", key: "karman line edge of space computed", distanceKm: 100, note: "Straight up", kind: "computed", wiki: "Kármán line" },
];

const EMPTY: Target[] = [];

// Sort key packing: round(distance × 1e4) in the high bits, list index in the low 20 bits.
// Both fit exactly in a double (< 2^48), so a plain numeric Float64Array sort orders 320k rows
// in a few tens of milliseconds instead of a comparator sort over objects.
const IDX_BITS = 20;
const IDX_MOD = 2 ** IDX_BITS;
const FAR = 2 ** 28 - 1; // larger than any surface distance × 1e4

function poiTarget(p: PoiRow): Target {
  return {
    id: `poi-${p.id}`,
    name: p.name,
    category: "poi",
    subtitle: p.kind,
    key: norm(`${p.name} ${p.kind}`),
    distanceKm: NaN,
    lat: p.lat,
    lon: p.lon,
    note: p.ele !== undefined ? `elevation ${Math.round(p.ele)} m` : undefined,
    kind: p.kind,
    facts: [...(p.ele !== undefined ? [["Elevation", `${Math.round(p.ele)} m`] as [string, string]] : []), ...(p.website ? [["Website", p.website] as [string, string]] : [])],
    wiki: p.wiki ?? (p.wikidata ? `wikidata:${p.wikidata}` : undefined) ?? p.name,
    wiki2: p.wiki || p.wikidata ? p.name : undefined,
  };
}

function customTarget(p: CustomPlace): Target {
  return { id: `custom-${p.id}`, name: p.name, category: "custom", subtitle: "My place", key: norm(p.name), distanceKm: NaN, lat: p.lat, lon: p.lon, note: p.note, kind: "custom", wiki: p.name };
}

export interface EarthTargets {
  /** Every Earth target in catalogue order; independent of the origin (useful for sorts that do not involve distance). */
  all: Target[];
  /** The same objects sorted nearest-first for the current origin. */
  byDistance: Target[];
}

/**
 * Every Earth-bound target, with its distance from the origin.
 * The static places are shared objects owned by useStaticData; this hook writes their `distanceKm`
 * in place when the origin moves and returns a freshly sorted array of the same objects. Nothing
 * else may mutate a Target.
 */
export function useEarthTargets(origin: Origin, data: StaticData | null, custom: CustomPlace[], pois: PoiRow[]): EarthTargets {
  const poiTargets = useMemo(() => (pois.length ? pois.map(poiTarget) : EMPTY), [pois]);
  const customTargets = useMemo(() => (custom.length ? custom.map(customTarget) : EMPTY), [custom]);

  const all = useMemo(() => {
    const base = data?.earth ?? EMPTY;
    if (base.length + poiTargets.length + customTargets.length + LANDMARK_TARGETS.length + COMPUTED.length >= IDX_MOD) throw new Error("too many Earth targets to sort");
    return base.concat(LANDMARK_TARGETS, poiTargets, customTargets, COMPUTED);
  }, [data, poiTargets, customTargets]);

  const byDistance = useMemo(() => {
    const { lat: olat, lon: olon } = origin;
    const ap = antipode(olat, olon);
    ANTIPODE.lat = ap.lat;
    ANTIPODE.lon = ap.lon;

    const n = all.length;
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = all[i];
      if (t.lat !== undefined && t.lon !== undefined) t.distanceKm = haversineKm(olat, olon, t.lat, t.lon);
      const d = t.distanceKm;
      keys[i] = (Number.isFinite(d) ? Math.round(d * 1e4) : FAR) * IDX_MOD + i;
    }
    keys.sort();
    const out = new Array<Target>(n);
    for (let i = 0; i < n; i++) out[i] = all[keys[i] % IDX_MOD];
    return out;
  }, [origin.lat, origin.lon, all]);

  return { all, byDistance };
}
