import { useMemo, useRef } from "react";
import * as A from "astronomy-engine";
import type { Category, Origin, Target, Vec3 } from "../types";
import type { BodyKind, BodyTable, State6 } from "../lib/horizons";
import { KIND_LABELS, MAX_OUTSIDE_MS, interpolate, outsideMs } from "../lib/horizons";
import {
  AU_PER_DAY_TO_KMS,
  SOLAR_BODIES,
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

/**
 * Planets that get a local system in the solar view. A spacecraft or close-approach asteroid joins a planet's
 * system while it is within twice that planet's Hill radius (the region where the planet's gravity dominates):
 * the Sun-Earth L1/L2 observatories, Mars orbiters and rovers, Juno, flybys within about 8 lunar distances.
 */
export const PLANET_SYSTEMS: { name: string; body: A.Body; radiusKm: number; hillKm: number }[] = [
  { name: "Mercury", body: A.Body.Mercury, radiusKm: 2440, hillKm: 1.75e5 },
  { name: "Venus", body: A.Body.Venus, radiusKm: 6052, hillKm: 1.01e6 },
  { name: "Earth", body: A.Body.Earth, radiusKm: 6371, hillKm: 1.5e6 },
  { name: "Mars", body: A.Body.Mars, radiusKm: 3390, hillKm: 1.08e6 },
  { name: "Jupiter", body: A.Body.Jupiter, radiusKm: 69911, hillKm: 5.3e7 },
  { name: "Saturn", body: A.Body.Saturn, radiusKm: 58232, hillKm: 6.5e7 },
  { name: "Uranus", body: A.Body.Uranus, radiusKm: 25362, hillKm: 7.0e7 },
  { name: "Neptune", body: A.Body.Neptune, radiusKm: 24622, hillKm: 1.16e8 },
  { name: "Pluto", body: A.Body.Pluto, radiusKm: 1188, hillKm: 6.0e6 },
];
const SYSTEM_REACH = 2; // in Hill radii
const FRESH_MS = 3600e3; // a planet-relative offset needs data no more than an hour outside the table

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

const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Sun, Moon, planets (local math) plus every Horizons body, recomputed every tick. */
export function useSpaceTargets(now: number, origin: Origin, tables: BodyTable[]): SpaceResult {
  const prev = useRef(new Map<string, { d: number; t: number }>());
  // Planet-centre tables are references for offsets, not targets of their own.
  const bodyTables = useMemo(() => tables.filter((t) => t.kind !== "planet"), [tables]);
  const planetTables = useMemo(() => new Map(tables.filter((t) => t.kind === "planet").map((t) => [t.name, t])), [tables]);
  // The constant part of every target (names, search keys, facts) is built once per table set.
  const hzBases = useMemo(() => bodyTables.map(horizonsBase), [bodyTables]);

  return useMemo(() => {
    const time = makeTime(now);
    const observer = makeObserver(origin);
    const obs = observerVectorKm(time, observer);
    const obsAu = { x: obs.x / KM_PER_AU, y: obs.y / KM_PER_AU, z: obs.z / KM_PER_AU };
    const rot = rotationEqjToEqd(time);
    const earthState = A.HelioState(A.Body.Earth, time);
    const earth = new A.Vector(earthState.x, earthState.y, earthState.z, time);
    const vEarth = { x: earthState.vx * AU_PER_DAY_TO_KMS, y: earthState.vy * AU_PER_DAY_TO_KMS, z: earthState.vz * AU_PER_DAY_TO_KMS };
    const earthHelio = helioEcliptic(earth, { x: 0, y: 0, z: 0 });

    const rateOf = (id: string, d: number): number | undefined => {
      const p = prev.current.get(id);
      prev.current.set(id, { d, t: now });
      if (!p || now <= p.t || !Number.isFinite(d) || !Number.isFinite(p.d)) return undefined;
      return (d - p.d) / ((now - p.t) / 1000);
    };

    // Geometric geocentric position of each planet centre (ICRF, km). From the planet's Horizons table when fresh,
    // so it shares the moons' frame, time scale and corrections exactly. Otherwise from astronomy-engine without
    // light-time or aberration corrections, which is good enough for a spacecraft's place near a planet but not
    // for moons: its outer-planet positions are off by tens to hundreds of thousands of km (Charon came out
    // 150,000 km from Pluto), so moons wait for the table. Never use an apparent position (A.GeoVector) here:
    // light time and aberration shift a planet by 26,000 km at Mars and 500,000 km at Pluto relative to its
    // moons' geometric positions.
    const planetGeo = new Map<string, { v: Vec3; vel?: Vec3; exact: boolean }>();
    const geoOf = (name: string): { v: Vec3; vel?: Vec3; exact: boolean } | undefined => {
      let g = planetGeo.get(name);
      if (g) return g;
      if (name === "Earth") g = { v: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, exact: true };
      else {
        const table = planetTables.get(name);
        const s = table ? interpolate(table, now, MAX_OUTSIDE_MS.planet) : null;
        if (s) g = { v: { x: s.x, y: s.y, z: s.z }, vel: { x: s.vx, y: s.vy, z: s.vz }, exact: true };
        else {
          const def = PLANET_SYSTEMS.find((p) => p.name === name);
          if (!def) return undefined;
          const h = A.HelioState(def.body, time);
          g = {
            v: { x: (h.x - earth.x) * KM_PER_AU, y: (h.y - earth.y) * KM_PER_AU, z: (h.z - earth.z) * KM_PER_AU },
            vel: { x: h.vx * AU_PER_DAY_TO_KMS - vEarth.x, y: h.vy * AU_PER_DAY_TO_KMS - vEarth.y, z: h.vz * AU_PER_DAY_TO_KMS - vEarth.z },
            exact: false,
          };
        }
      }
      planetGeo.set(name, g);
      return g;
    };
    const relTo = (name: string, g: Vec3, needExact: boolean): Vec3 | undefined => {
      const p = geoOf(name);
      if (!p || (needExact && !p.exact)) return undefined;
      return toEcliptic(new A.Vector((g.x - p.v.x) / KM_PER_AU, (g.y - p.v.y) / KM_PER_AU, (g.z - p.v.z) / KM_PER_AU, time));
    };

    const targets: Target[] = [];
    for (let i = 0; i < SOLAR_BODIES.length; i++) {
      const def = SOLAR_BODIES[i];
      const base = SOLAR_BASES[i];
      const s = solarBodyState(def, time, observer, earth, obsAu);
      const t: Target = { ...base, distanceKm: s.distKm, rateKms: rateOf(base.id, s.distKm), altDeg: s.alt, azDeg: s.az, helio: s.helio ?? undefined };
      if (Number.isFinite(s.speedKms)) {
        t.speedKms = s.speedKms;
        t.speedRef = def.body === A.Body.Moon ? "Earth" : "the Sun";
      }
      if (def.body === A.Body.Moon) {
        // Geometric geocentric Moon, for its place in Earth's system and its heliocentric position.
        const geo = A.GeoMoon(time);
        t.system = "Earth";
        t.rel = toEcliptic(geo);
        t.helio = helioEcliptic(earth, { x: geo.x * KM_PER_AU, y: geo.y * KM_PER_AU, z: geo.z * KM_PER_AU });
      }
      targets.push(t);
    }

    for (let i = 0; i < bodyTables.length; i++) {
      const t = bodyTables[i];
      const base = hzBases[i];
      const id = base.id;
      const kind = t.kind as BodyKind;
      const g: State6 | null = interpolate(t, now, MAX_OUTSIDE_MS[kind]);
      if (!g) {
        const out = outsideMs(t, now);
        const end = t.t0 !== undefined && t.stepSec && t.rows ? t.t0 + t.stepSec * 1000 * (t.rows.length - 1) : undefined;
        targets.push({
          ...base,
          distanceKm: NaN,
          note:
            t.status === "error"
              ? `Unavailable from Horizons: ${t.error ?? "unknown error"}`
              : Number.isFinite(out) && end !== undefined
                ? `Position out of date (NASA Horizons table ended ${fmtDate(end)} UTC); refreshing…`
                : "Loading from NASA Horizons…",
        });
        continue;
      }
      const topo = { x: g.x - obs.x, y: g.y - obs.y, z: g.z - obs.z };
      const d = Math.hypot(topo.x, topo.y, topo.z);
      const { alt, az } = topocentricAltAz(time, observer, rot, topo);
      // Speed: heliocentric (the table is geocentric, so add Earth's own orbital velocity), or for a moon,
      // relative to its planet when the planet's table is available.
      const out: Target = {
        ...base,
        distanceKm: d,
        rateKms: rateOf(id, d),
        altDeg: alt,
        azDeg: az,
        speedKms: Math.hypot(g.vx + vEarth.x, g.vy + vEarth.y, g.vz + vEarth.z),
        speedRef: "the Sun",
        helio: helioEcliptic(earth, g),
        note: t.note,
      };
      if (kind === "moon") {
        if (t.parent) {
          out.system = t.parent;
          out.rel = relTo(t.parent, g, true);
          const pg = geoOf(t.parent);
          if (pg?.exact && pg.vel) {
            out.speedKms = Math.hypot(g.vx - pg.vel.x, g.vy - pg.vel.y, g.vz - pg.vel.z);
            out.speedRef = t.parent;
          }
        }
      } else if (outsideMs(t, now) <= FRESH_MS) {
        // A spacecraft or asteroid close to a planet belongs to that planet's system while it is there.
        for (const p of PLANET_SYSTEMS) {
          const pg = geoOf(p.name);
          if (!pg) continue;
          const dist = Math.hypot(g.x - pg.v.x, g.y - pg.v.y, g.z - pg.v.z);
          if (dist < p.hillKm * SYSTEM_REACH) {
            out.system = p.name;
            out.rel = relTo(p.name, g, false);
            // Inside a planet's sphere of influence the meaningful speed is relative to that planet (JWST 0.5 km/s
            // around L2, not Earth's 30 km/s around the Sun; a flyby's encounter speed).
            if (pg.vel) {
              out.speedKms = Math.hypot(g.vx - pg.vel.x, g.vy - pg.vel.y, g.vz - pg.vel.z);
              out.speedRef = p.name;
            }
            break;
          }
        }
      }
      targets.push(out);
    }
    return { targets, earthHelio };
  }, [now, origin.lat, origin.lon, origin.alt, bodyTables, planetTables, hzBases]);
}
