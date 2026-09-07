// Live train positions from the open feeds that need no API key: Finland's Digitraffic (VR) and
// Amtrak via the community Amtraker API. Each provider is polled on demand, no faster than its
// TTL, and the last good answer is served while the upstream is down. There is no worldwide
// train feed; more providers can be added to PROVIDERS as they appear.
import { haversine, initialBearing } from "./geoutil";

export interface Train {
  id: string;
  name: string;
  operator: string;
  country: string;
  route: string;
  dest: string;
  lat: number;
  lon: number;
  speedKmh: number | null;
  heading: number | null;
  ts: number; // ms since epoch of the position
}

export interface TrainsResponse {
  fetchedAt: number;
  radiusKm: number;
  count: number;
  providers: { id: string; label: string; count: number; fetchedAt: number; error?: string }[];
  trains: Train[];
}

interface Provider {
  id: string;
  label: string;
  ttlMs: number;
  fetch(): Promise<Train[]>;
}

const UA = { "User-Agent": "Yonder/0.3 (live distance dashboard)" };

interface FiRow {
  trainNumber?: number;
  departureDate?: string;
  timestamp?: string;
  speed?: number;
  location?: { coordinates?: [number, number] };
}

interface AmtrakRow {
  trainID?: string;
  trainNum?: string;
  routeName?: string;
  lat?: number;
  lon?: number;
  heading?: string;
  velocity?: number;
  trainState?: string;
  destName?: string;
  lastValTS?: string;
  updatedAt?: string;
}

const COMPASS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

// Finland's feed has no heading; derive one from the previous fix when the train has moved.
const lastFix = new Map<string, { lat: number; lon: number; heading: number | null }>();
function headingFrom(id: string, lat: number, lon: number): number | null {
  const prev = lastFix.get(id);
  let heading = prev?.heading ?? null;
  if (prev && haversine(prev.lat, prev.lon, lat, lon) > 0.05) heading = initialBearing(prev.lat, prev.lon, lat, lon);
  lastFix.set(id, { lat, lon, heading });
  return heading;
}

const PROVIDERS: Provider[] = [
  {
    id: "fi",
    label: "Finland (VR, Digitraffic)",
    ttlMs: 30e3,
    async fetch() {
      const res = await fetch("https://rata.digitraffic.fi/api/v1/train-locations/latest/", { headers: { ...UA, "Digitraffic-User": "Yonder/0.3", "Accept-Encoding": "gzip" }, signal: AbortSignal.timeout(20e3) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as FiRow[];
      const out: Train[] = [];
      for (const r of rows) {
        const c = r.location?.coordinates;
        if (!c || typeof r.trainNumber !== "number") continue;
        const id = `fi-${r.departureDate ?? "x"}-${r.trainNumber}`;
        out.push({
          id,
          name: `Train ${r.trainNumber}`,
          operator: "VR",
          country: "Finland",
          route: "",
          dest: "",
          lat: c[1],
          lon: c[0],
          speedKmh: typeof r.speed === "number" ? r.speed : null,
          heading: headingFrom(id, c[1], c[0]),
          ts: r.timestamp ? Date.parse(r.timestamp) : Date.now(),
        });
      }
      return out;
    },
  },
  {
    id: "us",
    label: "Amtrak (Amtraker)",
    ttlMs: 60e3,
    async fetch() {
      const res = await fetch("https://api-v3.amtraker.com/v3/trains", { headers: UA, signal: AbortSignal.timeout(20e3) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Record<string, AmtrakRow[]>;
      const out: Train[] = [];
      for (const list of Object.values(json)) {
        for (const r of list) {
          if (typeof r.lat !== "number" || typeof r.lon !== "number" || r.trainState !== "Active") continue;
          const ts = r.lastValTS ? Date.parse(r.lastValTS) : r.updatedAt ? Date.parse(r.updatedAt) : NaN;
          out.push({
            id: `us-${r.trainID ?? r.trainNum ?? Math.random().toString(36).slice(2)}`,
            name: `Amtrak ${r.trainNum ?? ""} ${r.routeName ?? ""}`.trim(),
            operator: "Amtrak",
            country: "United States",
            route: r.routeName ?? "",
            dest: r.destName ?? "",
            lat: r.lat,
            lon: r.lon,
            speedKmh: typeof r.velocity === "number" ? r.velocity * 1.609344 : null,
            heading: r.heading && r.heading in COMPASS ? COMPASS[r.heading] : null,
            ts: Number.isFinite(ts) ? ts : Date.now(),
          });
        }
      }
      return out;
    },
  },
];

interface Cached {
  fetchedAt: number;
  trains: Train[];
  error?: string;
}
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<void>>();

async function refresh(p: Provider): Promise<void> {
  const c = cache.get(p.id);
  if (c && Date.now() - c.fetchedAt < p.ttlMs) return;
  const running = inflight.get(p.id);
  if (running) return running;
  const task = p
    .fetch()
    .then((trains) => {
      cache.set(p.id, { fetchedAt: Date.now(), trains });
    })
    .catch((err: Error) => {
      // Keep the stale list but remember the failure; retry no sooner than the TTL.
      cache.set(p.id, { fetchedAt: Date.now(), trains: c?.trains ?? [], error: err.message });
    })
    .finally(() => inflight.delete(p.id));
  inflight.set(p.id, task);
  return task;
}

/** Trains within `radiusKm` of a point (a large radius returns every tracked train worldwide). */
export async function getTrains(lat: number, lon: number, radiusKm: number): Promise<TrainsResponse> {
  await Promise.all(PROVIDERS.map(refresh));
  const trains: Train[] = [];
  const providers = PROVIDERS.map((p) => {
    const c = cache.get(p.id);
    let n = 0;
    for (const t of c?.trains ?? []) {
      if (haversine(lat, lon, t.lat, t.lon) <= radiusKm) {
        trains.push(t);
        n++;
      }
    }
    return { id: p.id, label: p.label, count: n, fetchedAt: c?.fetchedAt ?? 0, error: c?.error };
  });
  return { fetchedAt: Date.now(), radiusKm, count: trains.length, providers, trains };
}
