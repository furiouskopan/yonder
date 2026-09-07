import { useMemo, useRef } from "react";
import * as A from "astronomy-engine";
import type { Category, Origin, Target, Vec3 } from "../types";
import type { BodyTable } from "../lib/horizons";
import { KIND_LABELS, interpolate } from "../lib/horizons";
import {
  SOLAR_BODIES,
  earthHelioEqj,
  helioEcliptic,
  makeObserver,
  makeTime,
  observerVectorKm,
  rotationEqjToEqd,
  solarBodyState,
  toEcliptic,
  topocentricAltAz,
} from "../lib/astro";
import { KM_PER_AU } from "../lib/units";
import { norm } from "../lib/search";

export interface SpaceResult {
  targets: Target[];
  earthHelio: Vec3; // Earth's heliocentric ecliptic position, AU
}

function wikiFor(t: BodyTable): string {
  switch (t.kind) {
    case "moon":
      return `${t.name} (moon)`;
    case "asteroid":
    case "dwarf":
    case "tno":
    case "centaur":
      return `${t.name.replace(/ \(asteroid\)$/, "")} asteroid`;
    default:
      return t.name;
  }
}

type Base = Omit<Target, "distanceKm">;

const SOLAR_BASES: Base[] = SOLAR_BODIES.map((def) => ({
  id: `sol-${def.name}`,
  name: def.name,
  category: "solar",
  subtitle: def.kind,
  key: norm(`${def.name} ${def.kind}`),
  note: def.note,
  kind: def.kind,
  wiki: def.wiki,
  facts: [["Radius", `${def.radiusKm.toLocaleString()} km`], ...(def.periodDays ? [["Orbital period", def.periodDays < 400 ? `${def.periodDays} days` : `${(def.periodDays / 365.25).toFixed(1)} years`] as [string, string]] : [])],
}));

function horizonsBase(t: BodyTable): Base {
  const category: Category = t.kind === "probe" ? "probe" : "solar";
  const subtitle = t.kind === "moon" ? `Moon of ${t.parent}` : KIND_LABELS[t.kind];
  return { id: `hz-${t.id}`, name: t.name, category, subtitle, key: norm(`${t.name} ${subtitle}`), kind: t.kind, wiki: wikiFor(t), wiki2: t.name, facts: t.facts };
}

/** Sun, Moon, planets (local math) plus every Horizons body, recomputed every tick. */
export function useSpaceTargets(now: number, origin: Origin, tables: BodyTable[]): SpaceResult {
  const prev = useRef(new Map<string, { d: number; t: number }>());
  // The constant part of every target (names, search keys, facts) is built once per table set.
  const hzBases = useMemo(() => tables.map(horizonsBase), [tables]);

  return useMemo(() => {
    const time = makeTime(now);
    const observer = makeObserver(origin);
    const obs = observerVectorKm(time, observer);
    const rot = rotationEqjToEqd(time);
    const earth = earthHelioEqj(time);
    const earthHelio = helioEcliptic(earth, { x: 0, y: 0, z: 0 });

    const rateOf = (id: string, d: number): number | undefined => {
      const p = prev.current.get(id);
      prev.current.set(id, { d, t: now });
      if (!p || now <= p.t || !Number.isFinite(d) || !Number.isFinite(p.d)) return undefined;
      return (d - p.d) / ((now - p.t) / 1000);
    };

    // Geocentric ICRF vectors (AU) of the planets that have moons, computed once per tick on demand.
    const parentGeo = new Map<string, A.Vector>();
    const geoOf = (name: string): A.Vector | undefined => {
      let v = parentGeo.get(name);
      if (!v) {
        const body = (A.Body as Record<string, A.Body>)[name];
        if (!body) return undefined;
        v = A.GeoVector(body, time, true);
        parentGeo.set(name, v);
      }
      return v;
    };

    const targets: Target[] = [];
    for (let i = 0; i < SOLAR_BODIES.length; i++) {
      const def = SOLAR_BODIES[i];
      const base = SOLAR_BASES[i];
      const s = solarBodyState(def, time, observer);
      const t: Target = { ...base, distanceKm: s.distKm, rateKms: rateOf(base.id, s.distKm), altDeg: s.alt, azDeg: s.az, helio: s.helio ?? undefined };
      if (def.body === A.Body.Moon) {
        const geo = A.GeoVector(A.Body.Moon, time, true);
        t.rel = toEcliptic(geo);
        t.parent = "Earth";
        t.helio = helioEcliptic(earth, { x: geo.x * KM_PER_AU, y: geo.y * KM_PER_AU, z: geo.z * KM_PER_AU });
        t.kind = "moon";
      }
      targets.push(t);
    }

    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      const base = hzBases[i];
      const id = base.id;
      const g = interpolate(t, now);
      if (!g) {
        targets.push({
          ...base,
          distanceKm: NaN,
          note: t.status === "error" ? `Unavailable from Horizons: ${t.error ?? "unknown error"}` : "Loading from NASA Horizons…",
        });
        continue;
      }
      const topo = { x: g.x - obs.x, y: g.y - obs.y, z: g.z - obs.z };
      const d = Math.hypot(topo.x, topo.y, topo.z);
      const { alt, az } = topocentricAltAz(time, observer, rot, topo);
      const out: Target = {
        ...base,
        distanceKm: d,
        rateKms: rateOf(id, d),
        altDeg: alt,
        azDeg: az,
        speedKms: Math.hypot(g.vx, g.vy, g.vz),
        helio: helioEcliptic(earth, g),
        note: t.note,
      };
      if (t.kind === "moon" && t.parent) {
        const pg = geoOf(t.parent);
        if (pg) {
          out.parent = t.parent;
          out.rel = toEcliptic(new A.Vector(g.x / KM_PER_AU - pg.x, g.y / KM_PER_AU - pg.y, g.z / KM_PER_AU - pg.z, time));
        }
      }
      targets.push(out);
    }
    return { targets, earthHelio };
  }, [now, origin.lat, origin.lon, origin.alt, tables, hzBases]);
}
