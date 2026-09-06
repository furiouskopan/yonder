// Live aircraft positions (ADS-B) from community aggregators, with a short cache so the
// browser can poll every few seconds without hammering the upstream API.

export interface Aircraft {
  hex: string;
  flight: string;
  reg: string;
  type: string;
  desc: string;
  lat: number;
  lon: number;
  altFt: number | null; // barometric altitude, 0 on the ground
  gsKts: number | null;
  track: number | null;
  vrate: number | null; // ft/min
  squawk: string;
  onGround: boolean;
  category: string;
  ageSec: number; // seconds since the position was received
}

export interface AircraftResponse {
  fetchedAt: number;
  source: string;
  radiusNm: number;
  count: number;
  aircraft: Aircraft[];
}

interface RawAc {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  mag_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  category?: string;
  seen_pos?: number;
}

const SOURCES: { name: string; url: (lat: number, lon: number, nm: number) => string }[] = [
  { name: "adsb.fi", url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: "adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
];
const TTL_MS = 8_000;
const cache = new Map<string, AircraftResponse>();
const inflight = new Map<string, Promise<AircraftResponse>>();

function normalize(raw: RawAc[]): Aircraft[] {
  const out: Aircraft[] = [];
  for (const a of raw) {
    if (typeof a.lat !== "number" || typeof a.lon !== "number" || !a.hex) continue;
    const onGround = a.alt_baro === "ground";
    const altFt = onGround ? 0 : typeof a.alt_baro === "number" ? a.alt_baro : typeof a.alt_geom === "number" ? a.alt_geom : null;
    out.push({
      hex: a.hex,
      flight: (a.flight ?? "").trim(),
      reg: a.r ?? "",
      type: a.t ?? "",
      desc: a.desc ?? "",
      lat: a.lat,
      lon: a.lon,
      altFt,
      gsKts: typeof a.gs === "number" ? a.gs : null,
      track: typeof a.track === "number" ? a.track : typeof a.true_heading === "number" ? a.true_heading : typeof a.mag_heading === "number" ? a.mag_heading : null,
      vrate: typeof a.baro_rate === "number" ? a.baro_rate : typeof a.geom_rate === "number" ? a.geom_rate : null,
      squawk: a.squawk ?? "",
      onGround,
      category: a.category ?? "",
      ageSec: typeof a.seen_pos === "number" ? a.seen_pos : 0,
    });
  }
  return out;
}

export async function getAircraft(lat: number, lon: number, radiusNm = 250): Promise<AircraftResponse> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${radiusNm}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const errors: string[] = [];
    for (const src of SOURCES) {
      try {
        const res = await fetch(src.url(lat, lon, radiusNm), { headers: { "User-Agent": "Yonder/0.2 (live distance dashboard)" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { ac?: RawAc[]; aircraft?: RawAc[] };
        const aircraft = normalize(json.ac ?? json.aircraft ?? []);
        const out: AircraftResponse = { fetchedAt: Date.now(), source: src.name, radiusNm, count: aircraft.length, aircraft };
        cache.set(key, out);
        return out;
      } catch (err) {
        errors.push(`${src.name}: ${(err as Error).message}`);
      }
    }
    if (cached) return cached;
    throw new Error(errors.join("; "));
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}
