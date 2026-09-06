// Points of interest around the origin from OpenStreetMap via the Overpass API.
// Results are cached per ~2 km cell for a week because Overpass queries are slow.
import { readCache, writeCache } from "./cache";

export interface Poi {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  wiki?: string; // "lang:Title" from the wikipedia tag
  wikidata?: string;
  ele?: number;
  website?: string;
}

export interface PoiResponse {
  cell: string;
  center: { lat: number; lon: number };
  radiusKm: number;
  fetchedAt: number;
  count: number;
  pois: Poi[];
  source: string;
}

const MIRRORS = [
  "https://z.overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const RADIUS_M = 22_000;
const TTL_MS = 7 * 24 * 3600e3;
const inflight = new Map<string, Promise<PoiResponse>>();

const KIND_LABELS: Record<string, string> = {
  museum: "Museum", attraction: "Attraction", viewpoint: "Viewpoint", zoo: "Zoo", theme_park: "Theme park", aquarium: "Aquarium",
  gallery: "Gallery", artwork: "Artwork", castle: "Castle", monument: "Monument", memorial: "Memorial", ruins: "Ruins",
  archaeological_site: "Archaeological site", fort: "Fort", church: "Historic church", monastery: "Monastery", city_gate: "City gate",
  tower: "Tower", park: "Park", stadium: "Stadium", nature_reserve: "Nature reserve", golf_course: "Golf course",
  water_park: "Water park", garden: "Garden", peak: "Peak", volcano: "Volcano", cave_entrance: "Cave", waterfall: "Waterfall",
  spring: "Spring", hot_spring: "Hot spring", beach: "Beach", glacier: "Glacier", lake: "Lake", reservoir: "Reservoir",
  university: "University", college: "College", hospital: "Hospital", theatre: "Theatre", library: "Library", townhall: "Town hall",
  marketplace: "Market", cinema: "Cinema", planetarium: "Planetarium", station: "Station", lighthouse: "Lighthouse",
  observatory: "Observatory", dam: "Dam", bridge: "Bridge", communications_tower: "Communications tower", water_tower: "Water tower",
  windmill: "Windmill", mall: "Shopping mall", cathedral: "Cathedral", mosque: "Mosque", synagogue: "Synagogue", temple: "Temple",
};

function cellOf(lat: number, lon: number): { key: string; lat: number; lon: number } {
  const clat = Math.round(lat * 50) / 50;
  const clon = Math.round(lon * 50) / 50;
  return { key: `${clat.toFixed(2)}_${clon.toFixed(2)}`, lat: clat, lon: clon };
}

function buildQuery(lat: number, lon: number): string {
  const around = `(around:${RADIUS_M},${lat},${lon})`;
  const block = (filters: string[], limit: number) =>
    `(${filters.map((f) => `nwr${f}["name"]${around};`).join("")});out center ${limit};`;
  return [
    "[out:json][timeout:60];",
    block(['["tourism"~"^(museum|attraction|viewpoint|zoo|theme_park|aquarium|gallery|artwork)$"]'], 400),
    block(['["historic"~"^(castle|monument|memorial|ruins|archaeological_site|fort|church|monastery|city_gate|tower)$"]'], 400),
    block(['["leisure"~"^(park|stadium|nature_reserve|golf_course|water_park|garden)$"]'], 300),
    block(['["natural"~"^(peak|volcano|cave_entrance|waterfall|spring|hot_spring|beach|glacier)$"]'], 400),
    block(['["natural"="water"]["water"~"^(lake|reservoir)$"]'], 200),
    block(['["amenity"~"^(university|college|hospital|theatre|library|townhall|marketplace|cinema|planetarium)$"]'], 300),
    block(['["railway"="station"]', '["public_transport"="station"]'], 200),
    block(['["man_made"~"^(tower|lighthouse|observatory|dam|bridge|communications_tower|water_tower|windmill)$"]'], 200),
    block(['["shop"="mall"]', '["amenity"="place_of_worship"]["building"~"^(cathedral|mosque|monastery|synagogue|temple)$"]'], 200),
  ].join("\n");
}

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function kindOf(t: Record<string, string>): string {
  const raw =
    t.tourism ?? t.historic ?? t.leisure ?? (t.natural === "water" ? t.water : t.natural) ?? t.amenity ?? t.railway ?? t.public_transport ?? t.man_made ?? t.shop ?? "";
  if (t.amenity === "place_of_worship" && t.building) return KIND_LABELS[t.building] ?? "Place of worship";
  return KIND_LABELS[raw] ?? (raw ? raw.replace(/_/g, " ") : "Place");
}

export function parseElements(elements: OsmElement[]): Poi[] {
  const out: Poi[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    const t = e.tags ?? {};
    const name = t["name:en"] ?? t.name;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!name || lat === undefined || lon === undefined) continue;
    const dedupe = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const ele = Number(t.ele);
    out.push({
      id: `${e.type}/${e.id}`,
      name,
      kind: kindOf(t),
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      ...(t.wikipedia ? { wiki: t.wikipedia } : {}),
      ...(t.wikidata ? { wikidata: t.wikidata } : {}),
      ...(Number.isFinite(ele) ? { ele } : {}),
      ...(t.website ? { website: t.website } : {}),
    });
  }
  return out;
}

export async function getPois(lat: number, lon: number): Promise<PoiResponse> {
  const cell = cellOf(lat, lon);
  const key = `poi-${cell.key}`;
  const cached = readCache<PoiResponse>(key);
  if (cached && Date.now() - cached.savedAt < TTL_MS) return cached.data;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const query = buildQuery(cell.lat, cell.lon);
    const errors: string[] = [];
    for (const mirror of MIRRORS) {
      try {
        const res = await fetch(mirror, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Yonder/0.2 (live distance dashboard)" },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { elements?: OsmElement[] };
        const pois = parseElements(json.elements ?? []);
        const out: PoiResponse = { cell: cell.key, center: { lat: cell.lat, lon: cell.lon }, radiusKm: RADIUS_M / 1000, fetchedAt: Date.now(), count: pois.length, pois, source: mirror };
        writeCache(key, out);
        console.log(`[poi] ${cell.key}: ${pois.length} places from ${new URL(mirror).host}`);
        return out;
      } catch (err) {
        errors.push(`${new URL(mirror).host}: ${(err as Error).message}`);
      }
    }
    if (cached) return cached.data;
    throw new Error(errors.join("; "));
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}
