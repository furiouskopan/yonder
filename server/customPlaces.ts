// The user's own places live in data/custom-places.json so they can also be edited by hand.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./cache";

export interface CustomPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  note?: string;
}

const FILE = path.join(DATA_DIR, "custom-places.json");

export function sanitizePlaces(list: unknown): CustomPlace[] {
  if (!Array.isArray(list)) throw new Error("places must be an array");
  if (list.length > 10_000) throw new Error("too many places (max 10,000)");
  return list.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    const lat = Number(o.lat);
    const lon = Number(o.lon);
    if (!name) throw new Error(`place #${i + 1}: name is required`);
    if (!(lat >= -90 && lat <= 90)) throw new Error(`place "${name}": latitude must be between -90 and 90`);
    if (!(lon >= -180 && lon <= 180)) throw new Error(`place "${name}": longitude must be between -180 and 180`);
    const id = String(o.id ?? "").trim() || `p${Date.now().toString(36)}${i}`;
    const note = o.note ? String(o.note).slice(0, 500) : undefined;
    return { id, name: name.slice(0, 200), lat, lon, ...(note ? { note } : {}) };
  });
}

export function readCustomPlaces(): CustomPlace[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { places?: unknown })?.places;
    return sanitizePlaces(list ?? []);
  } catch (err) {
    console.warn(`[places] could not read ${FILE}: ${(err as Error).message}`);
    return [];
  }
}

export function writeCustomPlaces(list: unknown): CustomPlace[] {
  const places = sanitizePlaces(list);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ places }, null, 2)}\n`);
  fs.renameSync(tmp, FILE);
  return places;
}
