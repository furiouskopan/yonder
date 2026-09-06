// Row access for the distance table without materialising the merged list every second.
//
// The table shows the union of a large static tier (Earth places, stars, exoplanets: ~320k rows,
// re-sorted only when the origin, filter or sort changes) and a small dynamic tier (satellites,
// aircraft, Solar System bodies: a few hundred to ~13k rows, re-sorted every tick). Instead of
// merging them into a new 320k-element array each second, `mergeRows` records where each dynamic
// row would be inserted and answers `at(i)` with two binary searches.
import type { SortState, Target } from "../types";
import { norm } from "./search";

export type Cmp = (a: Target, b: Target) => number;

/** Rows for the virtualised table: length, random access and lookup by id. */
export interface RowSource {
  readonly length: number;
  at(i: number): Target;
  /** Index of the row with this id, or -1. */
  indexOf(id: string): number;
}

export const EMPTY_ROWS: RowSource = {
  length: 0,
  at: () => {
    throw new RangeError("empty row source");
  },
  indexOf: () => -1,
};

const keyOf = (t: Target): string => t.key ?? norm(t.name);

/** Comparator matching the table's sort. Unknown distances (NaN) always sort last. */
export function comparatorFor(sort: SortState): Cmp {
  const dir = sort.dir === "asc" ? 1 : -1;
  if (sort.key === "name") {
    return (a, b) => {
      const x = keyOf(a);
      const y = keyOf(b);
      return x < y ? -dir : x > y ? dir : 0;
    };
  }
  return (a, b) => {
    const x = a.distanceKm;
    const y = b.distanceKm;
    const nx = x !== x; // NaN
    const ny = y !== y;
    if (nx || ny) return nx === ny ? 0 : nx ? 1 : -1;
    return dir * (x - y);
  };
}

/** Merge lists that are each sorted by distance (NaN last) into one sorted list. */
export function mergeByDistance(lists: Target[][]): Target[] {
  const live = lists.filter((l) => l.length > 0);
  if (live.length === 1) return live[0];
  const total = live.reduce((s, l) => s + l.length, 0);
  const out = new Array<Target>(total);
  const idx = live.map(() => 0);
  for (let k = 0; k < total; k++) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < live.length; i++) {
      const l = live[i];
      if (idx[i] >= l.length) continue;
      const d = l[idx[i]].distanceKm;
      const dd = d !== d ? Infinity : d;
      if (best < 0 || dd < bestD) {
        best = i;
        bestD = dd;
      }
    }
    out[k] = live[best][idx[best]++];
  }
  return out;
}

/**
 * Sort by normalised name key, ascending. Keys are read once into a flat string array and an index
 * is sorted, which avoids megamorphic property reads inside the comparator (targets of different
 * categories have different shapes) and is several times faster than sorting the objects directly.
 */
export function sortByKey(list: Target[]): Target[] {
  const n = list.length;
  const keys = new Array<string>(n);
  for (let i = 0; i < n; i++) keys[i] = keyOf(list[i]);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
  const out = new Array<Target>(n);
  for (let i = 0; i < n; i++) out[i] = list[idx[i]];
  return out;
}

/** Sort a static tier for the given sort. Distance-ascending inputs are merged rather than sorted. */
export function sortStatic(lists: Target[][], sort: SortState, cmp: Cmp): Target[] {
  if (sort.key === "distance") {
    const merged = mergeByDistance(lists);
    if (sort.dir === "asc") return merged;
    let firstNaN = merged.length;
    while (firstNaN > 0 && Number.isNaN(merged[firstNaN - 1].distanceKm)) firstNaN--;
    const out = new Array<Target>(merged.length);
    for (let i = 0; i < firstNaN; i++) out[i] = merged[firstNaN - 1 - i];
    for (let i = firstNaN; i < merged.length; i++) out[i] = merged[i];
    return out;
  }
  void cmp;
  const asc = sortByKey(lists.flat());
  return sort.dir === "asc" ? asc : asc.reverse();
}

/** id → index lookup for a static list, built on first use (the list is large and rarely searched). */
export function lazyIndex(list: Target[]): (id: string) => number {
  let map: Map<string, number> | null = null;
  return (id) => {
    if (!map) {
      map = new Map();
      for (let i = 0; i < list.length; i++) map.set(list[i].id, i);
    }
    return map.get(id) ?? -1;
  };
}

/** Rows over a plain array. */
export function arrayRows(list: Target[], lookup: (id: string) => number): RowSource {
  return { length: list.length, at: (i) => list[i], indexOf: lookup };
}

/**
 * Virtual merge of `stat` (large, sorted by `cmp`) and `dyn` (small, sorted by `cmp`).
 * Static rows win ties, so a satellite at exactly the same distance as a city follows it.
 */
export function mergeRows(stat: Target[], dyn: Target[], cmp: Cmp, staticLookup: (id: string) => number): RowSource {
  const ns = stat.length;
  const nd = dyn.length;
  if (nd === 0) return arrayRows(stat, staticLookup);
  if (ns === 0) return arrayRows(dyn, (id) => dyn.findIndex((t) => t.id === id));

  // pos[j] = number of static rows that sort before dyn[j]. Monotone in j, so each search starts where the last ended.
  const pos = new Uint32Array(nd);
  let lo = 0;
  for (let j = 0; j < nd; j++) {
    const d = dyn[j];
    let l = lo;
    let h = ns;
    while (l < h) {
      const m = (l + h) >>> 1;
      if (cmp(stat[m], d) <= 0) l = m + 1;
      else h = m;
    }
    pos[j] = l;
    lo = l;
  }
  // The merged index of dyn[j] is pos[j] + j, strictly increasing in j.

  const at = (i: number): Target => {
    let l = 0;
    let h = nd;
    while (l < h) {
      const m = (l + h) >>> 1;
      if (pos[m] + m <= i) l = m + 1;
      else h = m;
    }
    const c = l; // dynamic rows at or before i
    if (c > 0 && pos[c - 1] + c - 1 === i) return dyn[c - 1];
    return stat[i - c];
  };

  const indexOf = (id: string): number => {
    const k = staticLookup(id);
    if (k >= 0) {
      let l = 0;
      let h = nd;
      while (l < h) {
        const m = (l + h) >>> 1;
        if (pos[m] <= k) l = m + 1;
        else h = m;
      }
      return k + l;
    }
    for (let j = 0; j < nd; j++) if (dyn[j].id === id) return pos[j] + j;
    return -1;
  };

  return { length: ns + nd, at, indexOf };
}
