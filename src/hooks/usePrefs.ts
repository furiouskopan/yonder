import { useCallback, useEffect, useState } from "react";
import type { Category, Origin } from "../types";
import { CATEGORIES } from "../types";
import type { Unit } from "../lib/units";

export type ThemePref = "auto" | "light" | "dark";

export interface Prefs {
  origin: Origin;
  theme: ThemePref;
  unit: Unit;
  cats: Record<Category, boolean>;
  satSet: string;
  pinOnClick: boolean;
  mapMode: "2d" | "3d";
  basemap: string;
}

const KEY = "yonder:prefs";

export const DEFAULT_ORIGIN: Origin = { lat: 41.9981, lon: 21.4254, name: "Skopje, North Macedonia" };

export const ALL_ON = Object.fromEntries(CATEGORIES.map((c) => [c.id, true])) as Record<Category, boolean>;

const DEFAULTS: Prefs = {
  origin: DEFAULT_ORIGIN,
  theme: "auto",
  unit: "auto",
  cats: ALL_ON,
  satSet: "curated",
  pinOnClick: true,
  mapMode: "2d",
  basemap: "auto",
};

/** Optional URL parameters: ?lat=&lon=&name=  ?map=2d|3d  ?only=<category>  ?sats=<set>  ?theme=light|dark */
function fromUrl(): Partial<Prefs> {
  const p = new URLSearchParams(window.location.search);
  const out: Partial<Prefs> = {};
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  if (p.has("lat") && p.has("lon") && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.origin = { lat, lon, name: p.get("name") ?? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` };
  }
  const map = p.get("map");
  if (map === "2d" || map === "3d") out.mapMode = map;
  const only = p.get("only");
  if (only && CATEGORIES.some((c) => c.id === only)) out.cats = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.id === only])) as Record<Category, boolean>;
  const sats = p.get("sats");
  if (sats) out.satSet = sats;
  const theme = p.get("theme");
  if (theme === "light" || theme === "dark") out.theme = theme;
  return out;
}

function load(): Prefs {
  let stored: Partial<Prefs> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Prefs>;
  } catch {
    /* ignore */
  }
  const url = fromUrl();
  return { ...DEFAULTS, ...stored, ...url, cats: { ...DEFAULTS.cats, ...(stored.cats ?? {}), ...(url.cats ?? {}) } };
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage unavailable */
    }
  }, [prefs]);
  const update = useCallback((patch: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)) => setPrefs((p) => ({ ...p, ...(typeof patch === "function" ? patch(p) : patch) })), []);
  return [prefs, update] as const;
}
