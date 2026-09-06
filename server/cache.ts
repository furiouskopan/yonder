import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const CACHE_DIR = path.join(DATA_DIR, "cache");

export interface Cached<T> {
  savedAt: number;
  data: T;
}

export function readCache<T>(name: string): Cached<T> | null {
  try {
    const file = path.join(CACHE_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as Cached<T>;
  } catch {
    return null;
  }
}

export function writeCache<T>(name: string, data: T): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${name}.json`);
  const tmp = `${file}.tmp`;
  const payload: Cached<T> = { savedAt: Date.now(), data };
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
