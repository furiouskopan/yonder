import { useCallback, useEffect, useState } from "react";
import type { Category, Origin } from "../types";
import { CATEGORIES } from "../types";
import type { Unit } from "../lib/units";

export type ThemePref = "auto" | "light" | "dark";
export type PaneId = "table" | "map" | "solar";
export type ColumnId = "rank" | "type" | "light" | "direction" | "approach" | "details";
export type SolarKind = "planet" | "dwarf" | "tno" | "centaur" | "asteroid" | "comet" | "interstellar" | "neo" | "probe";

export interface LayoutPrefs {
  split: number; // fraction of the main area given to the table column
  sideSplit: number; // fraction of the side column given to the first pane
  collapsed: Record<PaneId, boolean>;
  solarFirst: boolean; // solar system above the map
}

export interface GlobePrefs {
  sats: boolean;
  aircraft: boolean;
  places: boolean;
  track: boolean;
  labels: boolean;
  autoRotate: boolean;
  texture: "auto" | "night" | "day";
  pointSize: number; // multiplier
}

export interface SolarPrefs {
  scale: "log" | "linear";
  orbits: boolean;
  trails: boolean;
  labels: boolean;
  skybox: boolean;
  kinds: Record<SolarKind, boolean>;
}

export interface Prefs {
  origin: Origin;
  theme: ThemePref;
  unit: Unit;
  cats: Record<Category, boolean>;
  satSet: string;
  pinOnClick: boolean;
  mapMode: "2d" | "3d";
  basemap: string;
  layout: LayoutPrefs;
  columns: Record<ColumnId, boolean>;
  globe: GlobePrefs;
  solar: SolarPrefs;
}

const KEY = "yonder:prefs";

export const DEFAULT_ORIGIN: Origin = { lat: 41.9981, lon: 21.4254, name: "Skopje, North Macedonia" };

export const ALL_ON = Object.fromEntries(CATEGORIES.map((c) => [c.id, true])) as Record<Category, boolean>;

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "rank", label: "#" },
  { id: "type", label: "Type" },
  { id: "light", label: "Light time" },
  { id: "direction", label: "Direction" },
  { id: "approach", label: "Approach" },
  { id: "details", label: "Details" },
];

export const SOLAR_KINDS: { id: SolarKind; label: string }[] = [
  { id: "planet", label: "Planets" },
  { id: "dwarf", label: "Dwarf planets" },
  { id: "asteroid", label: "Asteroids" },
  { id: "tno", label: "Trans-Neptunian objects" },
  { id: "centaur", label: "Centaurs" },
  { id: "comet", label: "Comets" },
  { id: "interstellar", label: "Interstellar visitors" },
  { id: "neo", label: "Near-Earth flybys" },
  { id: "probe", label: "Spacecraft" },
];

export const DEFAULT_LAYOUT: LayoutPrefs = { split: 0.6, sideSplit: 0.5, collapsed: { table: false, map: false, solar: false }, solarFirst: false };
export const DEFAULT_GLOBE: GlobePrefs = { sats: true, aircraft: true, places: true, track: true, labels: true, autoRotate: false, texture: "auto", pointSize: 1 };
export const DEFAULT_SOLAR: SolarPrefs = {
  scale: "log",
  orbits: true,
  trails: true,
  labels: true,
  skybox: true,
  kinds: Object.fromEntries(SOLAR_KINDS.map((k) => [k.id, true])) as Record<SolarKind, boolean>,
};
const ALL_COLUMNS = Object.fromEntries(COLUMNS.map((c) => [c.id, true])) as Record<ColumnId, boolean>;

const DEFAULTS: Prefs = {
  origin: DEFAULT_ORIGIN,
  theme: "auto",
  unit: "auto",
  cats: ALL_ON,
  satSet: "curated",
  pinOnClick: true,
  mapMode: "2d",
  basemap: "auto",
  layout: DEFAULT_LAYOUT,
  columns: ALL_COLUMNS,
  globe: DEFAULT_GLOBE,
  solar: DEFAULT_SOLAR,
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

const merge = <T extends object>(base: T, over: Partial<T> | undefined): T => ({ ...base, ...(over ?? {}) });
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

function load(): Prefs {
  let stored: Partial<Prefs> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Prefs>;
  } catch {
    /* ignore */
  }
  const url = fromUrl();
  const layout = merge(DEFAULT_LAYOUT, stored.layout);
  layout.collapsed = merge(DEFAULT_LAYOUT.collapsed, stored.layout?.collapsed);
  layout.split = clamp(layout.split, 0.2, 0.85, DEFAULT_LAYOUT.split);
  layout.sideSplit = clamp(layout.sideSplit, 0.15, 0.85, DEFAULT_LAYOUT.sideSplit);
  const globe = merge(DEFAULT_GLOBE, stored.globe);
  globe.pointSize = clamp(globe.pointSize, 0.4, 3, 1);
  const solar = merge(DEFAULT_SOLAR, stored.solar);
  solar.kinds = merge(DEFAULT_SOLAR.kinds, stored.solar?.kinds);
  return {
    ...DEFAULTS,
    ...stored,
    ...url,
    cats: { ...DEFAULTS.cats, ...(stored.cats ?? {}), ...(url.cats ?? {}) },
    layout,
    columns: merge(ALL_COLUMNS, stored.columns),
    globe,
    solar,
  };
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
