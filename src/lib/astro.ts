// Sun, Moon and planets are computed locally with astronomy-engine (no network needed).
// Heliocentric positions are expressed in the ecliptic J2000 frame, the same frame the
// Horizons orbit data uses, so everything lines up in the solar-system view.
import * as A from "astronomy-engine";
import { KM_PER_AU } from "./units";
import type { Origin, Vec3 } from "../types";

export interface SolarBodyDef {
  body: A.Body;
  name: string;
  kind: string;
  note?: string;
  periodDays: number;
  radiusKm: number;
  wiki?: string;
}

export const SOLAR_BODIES: SolarBodyDef[] = [
  { body: A.Body.Moon, name: "Moon", kind: "Moon", note: "Earth's natural satellite", periodDays: 27.32, radiusKm: 1737, wiki: "Moon" },
  { body: A.Body.Sun, name: "Sun", kind: "Star", note: "Our star", periodDays: 0, radiusKm: 695700, wiki: "Sun" },
  { body: A.Body.Mercury, name: "Mercury", kind: "Planet", periodDays: 87.97, radiusKm: 2440, wiki: "Mercury (planet)" },
  { body: A.Body.Venus, name: "Venus", kind: "Planet", periodDays: 224.7, radiusKm: 6052, wiki: "Venus" },
  { body: A.Body.Mars, name: "Mars", kind: "Planet", periodDays: 686.98, radiusKm: 3390, wiki: "Mars" },
  { body: A.Body.Jupiter, name: "Jupiter", kind: "Planet", periodDays: 4332.6, radiusKm: 69911, wiki: "Jupiter" },
  { body: A.Body.Saturn, name: "Saturn", kind: "Planet", periodDays: 10759, radiusKm: 58232, wiki: "Saturn" },
  { body: A.Body.Uranus, name: "Uranus", kind: "Planet", periodDays: 30687, radiusKm: 25362, wiki: "Uranus" },
  { body: A.Body.Neptune, name: "Neptune", kind: "Planet", periodDays: 60190, radiusKm: 24622, wiki: "Neptune" },
  { body: A.Body.Pluto, name: "Pluto", kind: "Dwarf planet", periodDays: 90560, radiusKm: 1188, wiki: "Pluto" },
];

export const EARTH_PERIOD_DAYS = 365.256;
export const EARTH_RADIUS_KM_ASTRO = 6371;

const ROT_EQJ_ECL = A.Rotation_EQJ_ECL();

/** Build an AstroTime from a Date or a millisecond timestamp.
 *  (astronomy-engine treats a bare number as *days since J2000*, so never pass ms directly.) */
export const makeTime = (date: Date | number): A.AstroTime => A.MakeTime(typeof date === "number" ? new Date(date) : date);

export function makeObserver(o: Origin): A.Observer {
  return new A.Observer(o.lat, o.lon, o.alt ?? 0);
}

/** The observer's position relative to Earth's centre in the ICRF/J2000 equatorial frame, km. */
export function observerVectorKm(time: A.AstroTime, observer: A.Observer): Vec3 {
  const v = A.ObserverVector(time, observer, false);
  return { x: v.x * KM_PER_AU, y: v.y * KM_PER_AU, z: v.z * KM_PER_AU };
}

export function toEcliptic(v: A.Vector): Vec3 {
  const r = A.RotateVector(ROT_EQJ_ECL, v);
  return { x: r.x, y: r.y, z: r.z };
}

export function helioEclipticOf(body: A.Body, time: A.AstroTime): Vec3 {
  return toEcliptic(A.HelioVector(body, time));
}

export interface SolarState {
  distKm: number; // geometric distance from the observer at this instant
  alt: number; // apparent direction (light time and aberration): where to look
  az: number;
  helio: Vec3 | null; // heliocentric ecliptic J2000, AU (null for the Moon)
  speedKms: number; // relative to the Sun; the Moon's relative to Earth; NaN for the Sun
}

export const AU_PER_DAY_TO_KMS = KM_PER_AU / 86400;

/**
 * Distance is geometric, "where it is now", the same convention as the Horizons bodies (their tables are
 * geometric too). The apparent distance from A.Equator(..., aberration) mixes light time and aberration and
 * is neither: it put Mars 25,000 km off the geometric value.
 */
export function solarBodyState(def: SolarBodyDef, time: A.AstroTime, observer: A.Observer, earth: A.Vector, obsAu: Vec3): SolarState {
  const eq = A.Equator(def.body, time, observer, true, true);
  const hz = A.Horizon(time, observer, eq.ra, eq.dec, "normal");
  let gx: number, gy: number, gz: number, speedKms: number;
  let helio: Vec3 | null = null;
  if (def.body === A.Body.Moon) {
    const m = A.GeoMoonState(time);
    gx = m.x;
    gy = m.y;
    gz = m.z;
    speedKms = Math.hypot(m.vx, m.vy, m.vz) * AU_PER_DAY_TO_KMS;
  } else {
    const s = A.HelioState(def.body, time);
    gx = s.x - earth.x;
    gy = s.y - earth.y;
    gz = s.z - earth.z;
    speedKms = def.body === A.Body.Sun ? NaN : Math.hypot(s.vx, s.vy, s.vz) * AU_PER_DAY_TO_KMS;
    helio = toEcliptic(new A.Vector(s.x, s.y, s.z, time));
  }
  const distKm = Math.hypot(gx - obsAu.x, gy - obsAu.y, gz - obsAu.z) * KM_PER_AU;
  return { distKm, alt: hz.altitude, az: hz.azimuth, helio, speedKms };
}

/** Altitude and azimuth of a body from its topocentric ICRF vector (km). */
export function topocentricAltAz(time: A.AstroTime, observer: A.Observer, rot: A.RotationMatrix, topoKm: Vec3): { alt: number; az: number } {
  const vec = new A.Vector(topoKm.x / KM_PER_AU, topoKm.y / KM_PER_AU, topoKm.z / KM_PER_AU, time);
  const eq = A.EquatorFromVector(A.RotateVector(rot, vec));
  const hz = A.Horizon(time, observer, eq.ra, eq.dec, "normal");
  return { alt: hz.altitude, az: hz.azimuth };
}

export function rotationEqjToEqd(time: A.AstroTime): A.RotationMatrix {
  return A.Rotation_EQJ_EQD(time);
}

export function earthHelioEqj(time: A.AstroTime): A.Vector {
  return A.HelioVector(A.Body.Earth, time);
}

/** Heliocentric ecliptic position (AU) from Earth's heliocentric vector plus a geocentric ICRF vector in km. */
export function helioEcliptic(earthHelio: A.Vector, geoKm: Vec3): Vec3 {
  const v = new A.Vector(earthHelio.x + geoKm.x / KM_PER_AU, earthHelio.y + geoKm.y / KM_PER_AU, earthHelio.z + geoKm.z / KM_PER_AU, earthHelio.t);
  return toEcliptic(v);
}

/** Sample a body's heliocentric orbit (ecliptic J2000, AU) over one period centred on `time`. */
export function orbitSamples(body: A.Body, periodDays: number, time: A.AstroTime, n = 180): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(helioEclipticOf(body, time.AddDays(-periodDays / 2 + (periodDays * i) / n)));
  }
  return out;
}
