// Satellite orbital elements (TLEs) from CelesTrak, cached on disk and enriched with SATCAT facts.
// CelesTrak asks clients not to re-download a group more than once every two hours,
// so each group is kept for six hours and the stale copy is served if a fetch fails.
import { readCache, writeCache, sleep } from "./cache";
import { getSatcat, satcatFacts, type SatcatFacts } from "./satcat";

export interface SatRecord {
  name: string;
  l1: string;
  l2: string;
  norad: number;
  intl: string;
  group: string;
}

export type SatClass =
  | "station"
  | "navigation"
  | "communications"
  | "earth-observation"
  | "science"
  | "megaconstellation"
  | "military"
  | "cubesat"
  | "rocket-body"
  | "debris"
  | "other";

export interface SatOut extends SatRecord {
  cls: SatClass;
  facts?: SatcatFacts;
}

export interface SatSet {
  id: string;
  label: string;
  groups: string[];
  approx: number;
  description: string;
}

export const SAT_SETS: SatSet[] = [
  { id: "curated", label: "Notable & bright", groups: ["stations", "visual", "science"], approx: 220, description: "Space stations, the brightest naked-eye satellites and science missions such as Hubble." },
  { id: "stations", label: "Space stations", groups: ["stations"], approx: 15, description: "The ISS, Tiangong and their attached modules." },
  { id: "navigation", label: "Navigation", groups: ["gps-ops", "glo-ops", "galileo", "beidou", "sbas"], approx: 150, description: "GPS, GLONASS, Galileo, BeiDou and augmentation satellites." },
  { id: "communications", label: "Communications", groups: ["geo", "intelsat", "ses", "iridium-NEXT", "orbcomm", "globalstar", "amateur", "other-comm", "gorizont", "raduga", "molniya"], approx: 1200, description: "Geostationary and low-orbit communications satellites." },
  { id: "earth-observation", label: "Weather & Earth observation", groups: ["weather", "noaa", "goes", "resource", "sarsat", "dmc", "argos", "planet", "spire"], approx: 500, description: "Meteorological, imaging and Earth-resource satellites." },
  { id: "science", label: "Science", groups: ["science", "geodetic", "engineering", "education"], approx: 200, description: "Space and Earth science, geodesy, engineering and education missions." },
  { id: "megaconstellations", label: "Starlink, OneWeb & Kuiper", groups: ["starlink", "oneweb", "kuiper"], approx: 9000, description: "Internet megaconstellations. Heavy." },
  { id: "military", label: "Military", groups: ["military"], approx: 100, description: "Satellites CelesTrak lists as military." },
  { id: "cubesats", label: "CubeSats", groups: ["cubesat"], approx: 500, description: "Small research satellites." },
  { id: "last-30-days", label: "Launched in the last 30 days", groups: ["last-30-days"], approx: 200, description: "Everything that reached orbit recently." },
  { id: "active", label: "Every active satellite", groups: ["active"], approx: 13000, description: "The full active catalog. Heavy: orbit math for every object runs in a background worker." },
  { id: "debris", label: "Debris clouds", groups: ["cosmos-2251-debris", "iridium-33-debris", "fengyun-1c-debris", "cosmos-1408-debris"], approx: 3500, description: "Tracked fragments from the four largest break-up events." },
];

const GROUP_CLASS: Record<string, SatClass> = {
  stations: "station", "gps-ops": "navigation", "glo-ops": "navigation", galileo: "navigation", beidou: "navigation", sbas: "navigation",
  geo: "communications", intelsat: "communications", ses: "communications", "iridium-NEXT": "communications", orbcomm: "communications",
  globalstar: "communications", amateur: "communications", "other-comm": "communications", gorizont: "communications", raduga: "communications", molniya: "communications",
  weather: "earth-observation", noaa: "earth-observation", goes: "earth-observation", resource: "earth-observation", sarsat: "earth-observation",
  dmc: "earth-observation", argos: "earth-observation", planet: "earth-observation", spire: "earth-observation",
  science: "science", geodetic: "science", engineering: "science", education: "science",
  starlink: "megaconstellation", oneweb: "megaconstellation", kuiper: "megaconstellation",
  military: "military", cubesat: "cubesat",
  "cosmos-2251-debris": "debris", "iridium-33-debris": "debris", "fengyun-1c-debris": "debris", "cosmos-1408-debris": "debris",
};

const NAME_RULES: [RegExp, SatClass][] = [
  [/^(ISS|CSS|TIANGONG|TIANHE|WENTIAN|MENGTIAN|PROGRESS|SOYUZ|CYGNUS|DRAGON|CREW DRAGON|SHENZHOU|TIANZHOU|HTV)/i, "station"],
  [/^(STARLINK|ONEWEB|KUIPER)/i, "megaconstellation"],
  [/^(GPS|NAVSTAR|GALILEO|BEIDOU|GSAT0|COSMOS .*GLONASS|GLONASS|IRNSS|NVS|QZS)/i, "navigation"],
  [/^(IRIDIUM|ORBCOMM|GLOBALSTAR|INTELSAT|SES-|EUTELSAT|INMARSAT|TDRS|SKYNET|THURAYA|VIASAT|ECHOSTAR|DIRECTV|SIRIUS|XM-|O3B|TELSTAR|ASTRA|HOTBIRD|ARABSAT|NILESAT|TURKSAT|YAMAL|EXPRESS|GORIZONT|RADUGA|MOLNIYA|MERIDIAN|GARPUN|LUCH|AMAZONAS|HISPASAT|KOREASAT|CHINASAT|ZHONGXING|APSTAR|ASIASAT|MEASAT|THAICOM|JCSAT|SUPERBIRD|OPTUS|NSS-|GALAXY|ANIK|CIEL|BSAT)/i, "communications"],
  [/^(NOAA|GOES|METOP|METEOSAT|MSG|FENGYUN|FY-|HIMAWARI|SENTINEL|LANDSAT|TERRA|AQUA|AURA|SUOMI|JPSS|DMSP|FLOCK|SKYSAT|PLANET|LEMUR|WORLDVIEW|GEOEYE|SPOT|PLEIADES|RADARSAT|COSMO|TERRASAR|TANDEM|ALOS|GAOFEN|YAOGAN|JILIN|RESURS|KANOPUS|CARTOSAT|RESOURCESAT|OCEANSAT|ICEYE|CAPELLA|SWOT|GRACE|ICESAT|CALIPSO|CLOUDSAT|SMAP|GPM|EOS)/i, "earth-observation"],
  [/^(HST|HUBBLE|CHANDRA|XMM|FERMI|SWIFT|NUSTAR|TESS|GAIA|KEPLER|IXPE|SOHO|ACE|WIND|DSCOVR|CLUSTER|MMS|THEMIS|SDO|IRIS|AIM|TIMED|LAGEOS|STARLETTE|STELLA|AJISAI|ETALON|JASON|TOPEX|SPEKTR|XRISM|EUCLID|CHEOPS|PROBA)/i, "science"],
  [/(DEB|DEBRIS|FRAGMENT)/i, "debris"],
  [/(R\/B|ROCKET BODY|PLATFORM|AKM|SL-\d+)/i, "rocket-body"],
];

const TTL_MS = 6 * 3600e3;
const inflight = new Map<string, Promise<SatRecord[]>>();

export function parseTle(text: string, group: string): SatRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const out: SatRecord[] = [];
  for (let i = 0; i + 2 < lines.length; ) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (l1.startsWith("1 ") && l2.startsWith("2 ") && l1.length >= 69 && l2.length >= 69) {
      out.push({ name: name.trim(), l1, l2, norad: parseInt(l1.slice(2, 7), 10), intl: l1.slice(9, 17).trim(), group });
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

async function fetchGroup(group: string): Promise<SatRecord[]> {
  const key = `celestrak-${group}`;
  const cached = readCache<SatRecord[]>(key);
  if (cached && Date.now() - cached.savedAt < TTL_MS) return cached.data;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
      const res = await fetch(url, { headers: { "User-Agent": "Yonder/0.2 (live distance dashboard)" }, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`CelesTrak ${group}: HTTP ${res.status}`);
      const sats = parseTle(await res.text(), group);
      if (sats.length === 0) throw new Error(`CelesTrak ${group}: no orbital elements in response`);
      writeCache(key, sats);
      console.log(`[celestrak] ${group}: ${sats.length} satellites`);
      return sats;
    } catch (err) {
      if (cached) {
        console.warn(`[celestrak] using stale cache for ${group}: ${(err as Error).message}`);
        return cached.data;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

export function classify(sat: SatRecord, satcatType?: string): SatClass {
  if (satcatType === "DEB") return "debris";
  if (satcatType === "R/B") return "rocket-body";
  const byGroup = GROUP_CLASS[sat.group];
  if (byGroup) return byGroup;
  for (const [re, cls] of NAME_RULES) if (re.test(sat.name)) return cls;
  return "other";
}

export interface SatSetResponse {
  set: string;
  fetchedAt: number;
  count: number;
  errors: string[];
  sats: SatOut[];
}

export async function getSatelliteSet(setId: string): Promise<SatSetResponse> {
  const set = SAT_SETS.find((s) => s.id === setId);
  if (!set) throw new Error(`Unknown satellite set: ${setId}`);
  const byNorad = new Map<number, SatRecord>();
  const errors: string[] = [];
  let fetchedAt = Date.now();
  for (const group of set.groups) {
    try {
      const sats = await fetchGroup(group);
      const cached = readCache<SatRecord[]>(`celestrak-${group}`);
      if (cached) fetchedAt = Math.min(fetchedAt, cached.savedAt);
      for (const s of sats) if (!byNorad.has(s.norad)) byNorad.set(s.norad, s);
    } catch (err) {
      errors.push((err as Error).message);
    }
    await sleep(100);
  }
  if (byNorad.size === 0) throw new Error(errors.join("; ") || "no satellite data");

  let satcat: Awaited<ReturnType<typeof getSatcat>> | null = null;
  try {
    satcat = await getSatcat();
  } catch (err) {
    errors.push(`SATCAT unavailable: ${(err as Error).message}`);
  }
  const sats: SatOut[] = [...byNorad.values()].map((s) => {
    const rec = satcat?.get(s.norad);
    return { ...s, cls: classify(s, rec?.type), facts: rec ? satcatFacts(rec) : undefined };
  });
  return { set: set.id, fetchedAt, count: sats.length, errors, sats };
}
