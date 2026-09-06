// Positions of spacecraft, moons, dwarf planets, asteroids, comets and close-approaching
// asteroids from NASA/JPL Horizons. For each body we keep a 48-hour table of Earth-centred
// position/velocity vectors at one-hour steps (ICRF frame, km and km/s). The browser
// interpolates between rows, so a table only needs refreshing once a day. Tables are cached
// on disk so the app also works offline after a first run.
import { readCache, writeCache, sleep } from "./cache";

export type BodyKind = "probe" | "dwarf" | "asteroid" | "tno" | "centaur" | "comet" | "interstellar" | "moon" | "neo";

export interface HorizonsBody {
  id: string; // Horizons COMMAND value
  name: string;
  kind: BodyKind;
  note?: string;
  parent?: string;
  facts?: [string, string][];
}

export interface BodyTable extends HorizonsBody {
  status: "ok" | "error" | "pending";
  error?: string;
  fetchedAt?: number;
  t0?: number; // ms since epoch (UTC) of the first row
  stepSec?: number;
  rows?: number[][]; // [x, y, z, vx, vy, vz]
}

export const KM_PER_AU = 149_597_870.7;
const UA = { "User-Agent": "Yonder/0.2 (live distance dashboard)" };

// Verified against Horizons on 2026-09-06.
export const STATIC_BODIES: HorizonsBody[] = [
  // Deep-space probes and observatories
  { id: "-31", name: "Voyager 1", kind: "probe", note: "Launched 1977 · in interstellar space" },
  { id: "-32", name: "Voyager 2", kind: "probe", note: "Launched 1977 · in interstellar space" },
  { id: "-23", name: "Pioneer 10", kind: "probe", note: "Launched 1972 · contact lost 2003" },
  { id: "-24", name: "Pioneer 11", kind: "probe", note: "Launched 1973 · contact lost 1995" },
  { id: "-98", name: "New Horizons", kind: "probe", note: "Launched 2006 · crossing the Kuiper belt" },
  { id: "-170", name: "James Webb Space Telescope", kind: "probe", note: "Orbiting Sun–Earth L2" },
  { id: "-96", name: "Parker Solar Probe", kind: "probe", note: "Diving through the Sun's corona" },
  { id: "-61", name: "Juno", kind: "probe", note: "Orbiting Jupiter" },
  { id: "-49", name: "Lucy", kind: "probe", note: "En route to Jupiter's Trojan asteroids" },
  { id: "-255", name: "Psyche", kind: "probe", note: "En route to asteroid 16 Psyche" },
  { id: "-159", name: "Europa Clipper", kind: "probe", note: "En route to Jupiter" },
  { id: "-28", name: "JUICE", kind: "probe", note: "En route to Jupiter's icy moons" },
  { id: "-121", name: "BepiColombo", kind: "probe", note: "En route to Mercury" },
  { id: "-144", name: "Solar Orbiter", kind: "probe", note: "ESA/NASA solar mission" },
  { id: "-234", name: "STEREO-A", kind: "probe", note: "Solar observatory in a heliocentric orbit" },
  { id: "-37", name: "Hayabusa2", kind: "probe", note: "Extended mission to asteroid 1998 KY26" },
  { id: "-64", name: "OSIRIS-APEX", kind: "probe", note: "En route to asteroid Apophis" },
  { id: "-74", name: "Mars Reconnaissance Orbiter", kind: "probe", note: "Orbiting Mars" },
  { id: "-41", name: "Mars Express", kind: "probe", note: "Orbiting Mars" },
  { id: "-53", name: "2001 Mars Odyssey", kind: "probe", note: "Orbiting Mars" },
  { id: "-76", name: "Curiosity rover", kind: "probe", note: "On the surface of Mars, Gale crater" },
  { id: "-21", name: "SOHO", kind: "probe", note: "Solar observatory at Sun–Earth L1" },
  { id: "-92", name: "ACE", kind: "probe", note: "Solar-wind monitor at Sun–Earth L1" },
  { id: "-78", name: "DSCOVR", kind: "probe", note: "Earth-watching camera at Sun–Earth L1" },
  { id: "-8", name: "Wind", kind: "probe", note: "Solar-wind probe near Sun–Earth L1" },
  { id: "-227", name: "Kepler", kind: "probe", note: "Retired 2018 · drifting in a heliocentric orbit" },
  { id: "-95", name: "TESS", kind: "probe", note: "Exoplanet hunter in a high Earth orbit" },
  { id: "-143205", name: "Tesla Roadster (Starman)", kind: "probe", note: "Falcon Heavy test payload, 2018" },
  // Dwarf planets and trans-Neptunian objects
  { id: "1;", name: "Ceres", kind: "dwarf", note: "Largest object in the asteroid belt" },
  { id: "136199;", name: "Eris", kind: "dwarf", note: "Most massive known dwarf planet" },
  { id: "136472;", name: "Makemake", kind: "dwarf" },
  { id: "136108;", name: "Haumea", kind: "dwarf" },
  { id: "90377;", name: "Sedna", kind: "dwarf", note: "Detached object with an 11,000-year orbit" },
  { id: "225088;", name: "Gonggong", kind: "dwarf" },
  { id: "50000;", name: "Quaoar", kind: "dwarf" },
  { id: "90482;", name: "Orcus", kind: "dwarf" },
  { id: "120347;", name: "Salacia", kind: "tno" },
  { id: "20000;", name: "Varuna", kind: "tno" },
  { id: "28978;", name: "Ixion", kind: "tno" },
  { id: "307261;", name: "2002 MS4", kind: "tno" },
  { id: "174567;", name: "Varda", kind: "tno" },
  { id: "15760;", name: "Albion", kind: "tno", note: "First Kuiper belt object found after Pluto" },
  { id: "486958;", name: "Arrokoth", kind: "tno", note: "Visited by New Horizons in 2019" },
  // Centaurs
  { id: "2060;", name: "Chiron", kind: "centaur" },
  { id: "5145;", name: "Pholus", kind: "centaur" },
  { id: "10199;", name: "Chariklo", kind: "centaur", note: "Has rings" },
  { id: "8405;", name: "Asbolus", kind: "centaur" },
  // Large main-belt asteroids and famous small bodies
  { id: "2;", name: "Pallas", kind: "asteroid" },
  { id: "4;", name: "Vesta", kind: "asteroid", note: "Visited by Dawn, 2011–2012" },
  { id: "10;", name: "Hygiea", kind: "asteroid" },
  { id: "704;", name: "Interamnia", kind: "asteroid" },
  { id: "52;", name: "Europa (asteroid)", kind: "asteroid" },
  { id: "511;", name: "Davida", kind: "asteroid" },
  { id: "87;", name: "Sylvia", kind: "asteroid" },
  { id: "65;", name: "Cybele", kind: "asteroid" },
  { id: "15;", name: "Eunomia", kind: "asteroid" },
  { id: "3;", name: "Juno (asteroid)", kind: "asteroid" },
  { id: "31;", name: "Euphrosyne", kind: "asteroid" },
  { id: "624;", name: "Hektor", kind: "asteroid", note: "Largest Jupiter Trojan" },
  { id: "88;", name: "Thisbe", kind: "asteroid" },
  { id: "324;", name: "Bamberga", kind: "asteroid" },
  { id: "451;", name: "Patientia", kind: "asteroid" },
  { id: "532;", name: "Herculina", kind: "asteroid" },
  { id: "48;", name: "Doris", kind: "asteroid" },
  { id: "375;", name: "Ursula", kind: "asteroid" },
  { id: "107;", name: "Camilla", kind: "asteroid" },
  { id: "45;", name: "Eugenia", kind: "asteroid" },
  { id: "7;", name: "Iris", kind: "asteroid" },
  { id: "29;", name: "Amphitrite", kind: "asteroid" },
  { id: "423;", name: "Diotima", kind: "asteroid" },
  { id: "19;", name: "Fortuna", kind: "asteroid" },
  { id: "13;", name: "Egeria", kind: "asteroid" },
  { id: "24;", name: "Themis", kind: "asteroid" },
  { id: "94;", name: "Aurora", kind: "asteroid" },
  { id: "702;", name: "Alauda", kind: "asteroid" },
  { id: "6;", name: "Hebe", kind: "asteroid" },
  { id: "372;", name: "Palma", kind: "asteroid" },
  { id: "128;", name: "Nemesis", kind: "asteroid" },
  { id: "120;", name: "Lachesis", kind: "asteroid" },
  { id: "16;", name: "Psyche (asteroid)", kind: "asteroid", note: "Metal-rich target of the Psyche mission" },
  { id: "41;", name: "Daphne", kind: "asteroid" },
  { id: "130;", name: "Elektra", kind: "asteroid" },
  { id: "22;", name: "Kalliope", kind: "asteroid" },
  { id: "259;", name: "Aletheia", kind: "asteroid" },
  { id: "9;", name: "Metis (asteroid)", kind: "asteroid" },
  { id: "154;", name: "Bertha", kind: "asteroid" },
  { id: "121;", name: "Hermione", kind: "asteroid" },
  { id: "334;", name: "Chicago", kind: "asteroid" },
  { id: "165;", name: "Loreley", kind: "asteroid" },
  { id: "153;", name: "Hilda", kind: "asteroid" },
  { id: "747;", name: "Winchester", kind: "asteroid" },
  { id: "386;", name: "Siegena", kind: "asteroid" },
  { id: "790;", name: "Pretoria", kind: "asteroid" },
  { id: "241;", name: "Germania", kind: "asteroid" },
  { id: "194;", name: "Prokne", kind: "asteroid" },
  { id: "173;", name: "Ino", kind: "asteroid" },
  { id: "8;", name: "Flora", kind: "asteroid" },
  { id: "11;", name: "Parthenope", kind: "asteroid" },
  { id: "12;", name: "Victoria", kind: "asteroid" },
  { id: "14;", name: "Irene", kind: "asteroid" },
  { id: "18;", name: "Melpomene", kind: "asteroid" },
  { id: "20;", name: "Massalia", kind: "asteroid" },
  { id: "21;", name: "Lutetia", kind: "asteroid", note: "Flown by Rosetta in 2010" },
  { id: "253;", name: "Mathilde", kind: "asteroid", note: "Flown by NEAR Shoemaker in 1997" },
  { id: "243;", name: "Ida", kind: "asteroid", note: "Has its own moon, Dactyl" },
  { id: "951;", name: "Gaspra", kind: "asteroid", note: "First asteroid visited by a spacecraft" },
  { id: "2867;", name: "Šteins", kind: "asteroid" },
  { id: "4179;", name: "Toutatis", kind: "asteroid" },
  { id: "433;", name: "Eros", kind: "asteroid", note: "First asteroid orbited by a spacecraft" },
  { id: "99942;", name: "Apophis", kind: "asteroid", note: "Passes closer than geostationary orbit in 2029" },
  { id: "101955;", name: "Bennu", kind: "asteroid", note: "Sampled by OSIRIS-REx" },
  { id: "25143;", name: "Itokawa", kind: "asteroid", note: "Sampled by Hayabusa" },
  { id: "162173;", name: "Ryugu", kind: "asteroid", note: "Sampled by Hayabusa2" },
  { id: "65803;", name: "Didymos", kind: "asteroid", note: "Target of the DART impact test" },
  { id: "3122;", name: "Florence", kind: "asteroid" },
  { id: "1036;", name: "Ganymed (asteroid)", kind: "asteroid", note: "Largest near-Earth asteroid" },
  { id: "1866;", name: "Sisyphus", kind: "asteroid" },
  // Comets and interstellar visitors
  { id: "DES=1P;CAP;", name: "Halley's Comet (1P)", kind: "comet", note: "Next perihelion 2061" },
  { id: "DES=2P;CAP;", name: "Comet Encke (2P)", kind: "comet" },
  { id: "DES=67P;CAP;", name: "Churyumov–Gerasimenko (67P)", kind: "comet", note: "Rosetta's comet" },
  { id: "DES=81P;CAP;", name: "Wild 2 (81P)", kind: "comet", note: "Sampled by Stardust" },
  { id: "DES=9P;CAP;", name: "Tempel 1 (9P)", kind: "comet", note: "Hit by Deep Impact in 2005" },
  { id: "DES=103P;CAP;", name: "Hartley 2 (103P)", kind: "comet" },
  { id: "DES=46P;CAP;", name: "Wirtanen (46P)", kind: "comet" },
  { id: "DES=12P;CAP;", name: "Pons–Brooks (12P)", kind: "comet" },
  { id: "DES=29P;CAP;", name: "Schwassmann–Wachmann 1 (29P)", kind: "comet" },
  { id: "DES=19P;CAP;", name: "Borrelly (19P)", kind: "comet" },
  { id: "DES=21P;CAP;", name: "Giacobini–Zinner (21P)", kind: "comet" },
  { id: "DES=109P;CAP;", name: "Swift–Tuttle (109P)", kind: "comet", note: "Parent of the Perseid meteors" },
  { id: "DES=55P;CAP;", name: "Tempel–Tuttle (55P)", kind: "comet", note: "Parent of the Leonid meteors" },
  { id: "DES=96P;CAP;", name: "Machholz (96P)", kind: "comet" },
  { id: "DES=C/1995 O1;CAP;", name: "Hale–Bopp (C/1995 O1)", kind: "comet", note: "The great comet of 1997" },
  { id: "DES=C/2020 F3;CAP;", name: "NEOWISE (C/2020 F3)", kind: "comet" },
  { id: "DES=C/2023 A3;CAP;", name: "Tsuchinshan–ATLAS (C/2023 A3)", kind: "comet" },
  { id: "DES=A/2017 U1;", name: "ʻOumuamua (1I)", kind: "interstellar", note: "First known interstellar object" },
  { id: "DES=2I;", name: "Borisov (2I)", kind: "interstellar", note: "First interstellar comet" },
  { id: "DES=C/2025 N1;", name: "3I/ATLAS", kind: "interstellar", note: "Third interstellar object, found 2025" },
];

const MOON_PARENTS: Record<number, string> = { 4: "Mars", 5: "Jupiter", 6: "Saturn", 7: "Uranus", 8: "Neptune", 9: "Pluto" };
const MOON_NOTES: Record<string, string> = {
  "503": "Largest moon in the Solar System",
  "606": "Only moon with a thick atmosphere",
  "602": "Erupts water into space",
  "501": "Most volcanically active world",
  "801": "Orbits backwards; probably a captured dwarf planet",
};

const STEP_H = 1;
const SPAN_H = 48;
const LEAD_H = 12;
const RETRY_MS = 30 * 60e3;
const LISTS_TTL_MS = 12 * 3600e3;
const CONCURRENCY = 2; // Horizons answers 503 when hit with more parallel requests
const TDB_MINUS_UTC_MS = 69_184; // TT − UTC in 2026 (37 s of leap seconds + 32.184 s)

const tables = new Map<string, BodyTable>();
const nextTry = new Map<string, number>();
let moons: HorizonsBody[] = [];
let neos: HorizonsBody[] = [];
let listsLoadedAt = 0;
let refreshing: Promise<void> | null = null;

export const keyOf = (id: string): string => `horizons-${id.replace(/[^A-Za-z0-9-]+/g, "_")}`;

export function allBodies(): HorizonsBody[] {
  return [...STATIC_BODIES, ...moons, ...neos];
}

export function fmtUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function firstLines(text: string, n = 2): string {
  return text.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, n).join(" | ").slice(0, 300);
}

export async function horizonsQuery(params: Record<string, string>): Promise<string> {
  const qs = Object.entries({ format: "json", ...params })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${qs}`, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result?: string; error?: string };
  return json.result ?? json.error ?? "";
}

export function extractCsvRows(text: string): string[][] {
  const soe = text.indexOf("$$SOE");
  const eoe = text.indexOf("$$EOE");
  if (soe < 0 || eoe < 0) throw new Error(firstLines(text) || "no ephemeris returned");
  return text
    .slice(soe + 5, eoe)
    .split("\n")
    .map((l) => l.split(",").map((s) => s.trim()))
    .filter((p) => p.length > 2 && Number.isFinite(Number(p[0])));
}

export const jdToMs = (jd: number): number => (jd - 2440587.5) * 86400e3 - TDB_MINUS_UTC_MS;

function windowStart(now: number): number {
  const hour = 3600e3;
  return Math.floor(now / hour) * hour - LEAD_H * hour;
}

function needsRefresh(t: BodyTable | undefined, now: number): boolean {
  if (!t || t.status !== "ok" || !t.rows || !t.t0 || !t.stepSec) return true;
  const end = t.t0 + t.stepSec * 1000 * (t.rows.length - 1);
  return now < t.t0 + 3600e3 || now > end - 12 * 3600e3;
}

async function fetchVectors(b: HorizonsBody, now: number): Promise<BodyTable> {
  const start = windowStart(now);
  const stop = start + SPAN_H * 3600e3;
  const text = await horizonsQuery({
    COMMAND: `'${b.id}'`,
    OBJ_DATA: "NO",
    MAKE_EPHEM: "YES",
    EPHEM_TYPE: "VECTORS",
    CENTER: "'500@399'", // Earth's centre
    REF_PLANE: "FRAME", // ICRF equatorial, the frame astronomy-engine uses
    VEC_TABLE: "2",
    CSV_FORMAT: "YES",
    OUT_UNITS: "KM-S",
    START_TIME: `'${fmtUtc(start)}'`,
    STOP_TIME: `'${fmtUtc(stop)}'`,
    STEP_SIZE: `'${STEP_H}h'`,
  });
  const rows: number[][] = [];
  const jds: number[] = [];
  for (const p of extractCsvRows(text)) {
    if (p.length < 8) continue;
    const vals = p.slice(2, 8).map(Number);
    if (vals.some((v) => !Number.isFinite(v))) continue;
    jds.push(Number(p[0]));
    rows.push(vals.map((v, i) => (i < 3 ? Math.round(v * 1000) / 1000 : Math.round(v * 1e6) / 1e6)));
  }
  if (rows.length < 2) throw new Error("too few rows in ephemeris");
  return { ...b, status: "ok", fetchedAt: now, t0: jdToMs(jds[0]), stepSec: Math.round((jds[1] - jds[0]) * 86400), rows };
}

export async function fetchBody(b: HorizonsBody, now = Date.now()): Promise<BodyTable> {
  try {
    return await fetchVectors(b, now);
  } catch (err) {
    // Comets: the current-apparition selector sometimes fails for objects with a single orbit record.
    if (b.id.includes("CAP;")) return fetchVectors({ ...b, id: b.id.replace("CAP;", "") }, now).then((t) => ({ ...t, id: b.id }));
    throw err;
  }
}

async function loadMoons(): Promise<HorizonsBody[]> {
  const cached = readCache<HorizonsBody[]>("horizons-moons");
  if (cached && Date.now() - cached.savedAt < 30 * 24 * 3600e3) return cached.data;
  try {
    const text = await horizonsQuery({ COMMAND: "'MB'" });
    const out: HorizonsBody[] = [];
    for (const line of text.split("\n")) {
      const m = /^\s+(\d{3})\s{2,}(\S.*?)(?:\s{2,}|\s*$)/.exec(line);
      if (!m) continue;
      const id = Number(m[1]);
      if (id < 401 || id % 100 === 99) continue; // skip planets and non-moon entries
      const parent = MOON_PARENTS[Math.floor(id / 100)];
      if (!parent) continue;
      out.push({ id: String(id), name: m[2].trim(), kind: "moon", parent, note: MOON_NOTES[String(id)] });
    }
    if (out.length < 20) throw new Error("moon list looks wrong");
    writeCache("horizons-moons", out);
    console.log(`[horizons] ${out.length} moons listed`);
    return out;
  } catch (err) {
    console.warn(`[horizons] moon list unavailable: ${(err as Error).message}`);
    return cached?.data ?? [];
  }
}

async function loadNeos(): Promise<HorizonsBody[]> {
  const cached = readCache<HorizonsBody[]>("cneos-cad");
  if (cached && Date.now() - cached.savedAt < 24 * 3600e3) return cached.data;
  try {
    const now = Date.now();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const url = `https://ssd-api.jpl.nasa.gov/cad.api?dist-max=0.1&date-min=${day(now - 7 * 86400e3)}&date-max=${day(now + 30 * 86400e3)}&sort=dist&fullname=true`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { fields?: string[]; data?: string[][] };
    const f = json.fields ?? [];
    const col = (name: string) => f.indexOf(name);
    const iDes = col("des"), iCd = col("cd"), iDist = col("dist"), iV = col("v_rel"), iH = col("h"), iFull = col("fullname");
    const out: HorizonsBody[] = [];
    for (const row of (json.data ?? []).slice(0, 40)) {
      const des = row[iDes];
      const distAu = Number(row[iDist]);
      const vRel = Number(row[iV]);
      const h = Number(row[iH]);
      const fullname = (row[iFull] ?? "").trim() || des;
      // Absolute magnitude H gives a rough size (albedo 0.14).
      const sizeM = Number.isFinite(h) ? Math.round(1329 / Math.sqrt(0.14) * Math.pow(10, -h / 5) * 1000) : null;
      out.push({
        id: /^\d+$/.test(des) ? `${des};` : `DES=${des};`,
        name: fullname,
        kind: "neo",
        note: `Closest approach ${row[iCd]} UTC at ${(distAu * 389.17).toFixed(1)} lunar distances`,
        facts: [
          ["Closest approach", `${row[iCd]} UTC`],
          ["Miss distance", `${(distAu * KM_PER_AU).toLocaleString(undefined, { maximumFractionDigits: 0 })} km (${(distAu * 389.17).toFixed(2)} lunar distances)`],
          ["Relative speed", `${vRel.toFixed(2)} km/s`],
          ...(sizeM ? [["Estimated size", sizeM >= 1000 ? `${(sizeM / 1000).toFixed(1)} km` : `${sizeM} m`] as [string, string]] : []),
        ],
      });
    }
    writeCache("cneos-cad", out);
    console.log(`[horizons] ${out.length} close approaches listed`);
    return out;
  } catch (err) {
    console.warn(`[horizons] close-approach list unavailable: ${(err as Error).message}`);
    return cached?.data ?? [];
  }
}

export async function refreshLists(force = false): Promise<void> {
  if (!force && Date.now() - listsLoadedAt < LISTS_TTL_MS) return;
  listsLoadedAt = Date.now();
  const [m, n] = await Promise.all([loadMoons(), loadNeos()]);
  moons = m;
  neos = n;
  for (const b of allBodies()) {
    if (!tables.has(b.id)) {
      const cached = readCache<BodyTable>(keyOf(b.id));
      tables.set(b.id, cached?.data?.status === "ok" ? { ...cached.data, ...b, status: "ok" } : { ...b, status: "pending" });
    }
  }
}

export async function runPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

export const isRefreshing = (): boolean => refreshing !== null;

export function ensureRefresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await refreshLists();
    const now = Date.now();
    const stale = allBodies().filter((b) => needsRefresh(tables.get(b.id), now) && (nextTry.get(b.id) ?? 0) <= now);
    if (stale.length === 0) return;
    console.log(`[horizons] refreshing ${stale.length} of ${allBodies().length} bodies`);
    await runPool(stale, CONCURRENCY, async (b) => {
      try {
        const t = await fetchBody(b);
        tables.set(b.id, t);
        writeCache(keyOf(b.id), t);
        nextTry.delete(b.id);
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`[horizons] ${b.name}: ${msg}`);
        const prev = tables.get(b.id);
        if (!prev || prev.status !== "ok") tables.set(b.id, { ...b, status: "error", error: msg });
        nextTry.set(b.id, Date.now() + RETRY_MS);
      }
      await sleep(150);
    });
    console.log("[horizons] refresh done");
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface HorizonsResponse {
  generatedAt: number;
  pending: number;
  refreshing: boolean;
  bodies: BodyTable[];
}

export function getHorizonsTables(): HorizonsResponse {
  void ensureRefresh();
  const bodies = allBodies().map((b) => tables.get(b.id) ?? { ...b, status: "pending" as const });
  return { generatedAt: Date.now(), pending: bodies.filter((b) => b.status === "pending").length, refreshing: refreshing !== null, bodies };
}
