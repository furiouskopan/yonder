import { useCallback, useEffect, useState } from "react";
import type { Category, Origin } from "../types";
import { CATEGORIES } from "../types";
import type { Unit } from "../lib/units";

export type ThemePref = "auto" | "light" | "dark";
export type PaneId = "table" | "map" | "solar" | "sky";
export type SidePane = Exclude<PaneId, "table">;
export type ColumnId = "rank" | "type" | "light" | "direction" | "approach" | "details";
export type SolarKind = "planet" | "moon" | "dwarf" | "tno" | "centaur" | "asteroid" | "comet" | "interstellar" | "neo" | "probe";

export interface LayoutPrefs {
  split: number; // fraction of the main area given to the table column
  order: SidePane[]; // side panes, top to bottom
  weights: Record<SidePane, number>; // relative heights of the side panes
  collapsed: Record<PaneId, boolean>;
}

export interface GlobePrefs {
  sats: boolean;
  aircraft: boolean;
  vehicles: boolean; // ships and trains
  places: boolean;
  track: boolean;
  footprint: boolean; // visibility circle of the tracked satellite
  labels: boolean;
  autoRotate: boolean;
  texture: "auto" | "night" | "day";
  pointSize: number; // multiplier
}

export interface SolarPrefs {
  scale: "log" | "linear";
  orbits: boolean; // planet orbits
  smallOrbits: boolean; // orbits of asteroids, comets and other small bodies (the selected one always shows)
  trails: boolean;
  moons: boolean;
  atmospheres: boolean;
  labels: boolean;
  skybox: boolean;
  kinds: Record<SolarKind, boolean>;
}

export interface SkyPrefs {
  stars: boolean;
  deep: boolean; // galaxies, clusters, nebulae
  sats: boolean;
  aircraft: boolean;
  labels: boolean;
  grid: boolean;
  magLimit: number; // faintest star drawn
  flip: boolean; // mirror east/west (map view instead of looking up)
}

export interface Prefs {
  v: number;
  onboarded: boolean;
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
  sky: SkyPrefs;
}

const KEY = "yonder:prefs";
/** Bump when the defaults change in a way existing users should get once (they keep their origin and layout). */
export const PREFS_VERSION = 2;

export const DEFAULT_ORIGIN: Origin = { lat: 51.4769, lon: -0.0005, name: "Royal Observatory, Greenwich" };
const LEGACY_ORIGIN: Origin = { lat: 41.9981, lon: 21.4254, name: "Skopje, North Macedonia" };

export const ALL_ON = Object.fromEntries(CATEGORIES.map((c) => [c.id, true])) as Record<Category, boolean>;
/** A calm first view: big places, the notable satellites and the sky. Towns, nearby places, live vehicles and exoplanets are a click away. */
const CATS_ON_BY_DEFAULT: Category[] = ["city", "capital", "landmark", "custom", "satellite", "solar", "probe", "star"];
export const DEFAULT_CATS = Object.fromEntries(CATEGORIES.map((c) => [c.id, CATS_ON_BY_DEFAULT.includes(c.id)])) as Record<Category, boolean>;

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
  { id: "moon", label: "Moons" },
  { id: "dwarf", label: "Dwarf planets" },
  { id: "asteroid", label: "Asteroids" },
  { id: "tno", label: "Trans-Neptunian objects" },
  { id: "centaur", label: "Centaurs" },
  { id: "comet", label: "Comets" },
  { id: "interstellar", label: "Interstellar visitors" },
  { id: "neo", label: "Near-Earth flybys" },
  { id: "probe", label: "Spacecraft" },
];

export const SIDE_PANES: { id: SidePane; label: string }[] = [
  { id: "map", label: "Map / globe" },
  { id: "sky", label: "Sky" },
  { id: "solar", label: "Solar system" },
];

export const DEFAULT_LAYOUT: LayoutPrefs = {
  split: 0.58,
  order: ["map", "sky", "solar"],
  weights: { map: 1, sky: 1, solar: 1 },
  collapsed: { table: false, map: false, solar: false, sky: true },
};
export const DEFAULT_GLOBE: GlobePrefs = { sats: true, aircraft: true, vehicles: true, places: true, track: true, footprint: true, labels: true, autoRotate: false, texture: "auto", pointSize: 1 };
const SOLAR_KINDS_ON_BY_DEFAULT: SolarKind[] = ["planet", "moon", "dwarf", "comet", "interstellar", "probe"];
export const DEFAULT_SOLAR: SolarPrefs = {
  scale: "log",
  orbits: true,
  smallOrbits: false,
  trails: false,
  moons: true,
  atmospheres: true,
  labels: true,
  skybox: true,
  kinds: Object.fromEntries(SOLAR_KINDS.map((k) => [k.id, SOLAR_KINDS_ON_BY_DEFAULT.includes(k.id)])) as Record<SolarKind, boolean>,
};
export const DEFAULT_SKY: SkyPrefs = { stars: true, deep: true, sats: true, aircraft: true, labels: true, grid: true, magLimit: 5, flip: false };
const ALL_COLUMNS = Object.fromEntries(COLUMNS.map((c) => [c.id, true])) as Record<ColumnId, boolean>;

const DEFAULTS: Prefs = {
  v: PREFS_VERSION,
  onboarded: false,
  origin: DEFAULT_ORIGIN,
  theme: "auto",
  unit: "auto",
  cats: DEFAULT_CATS,
  satSet: "curated",
  pinOnClick: true,
  mapMode: "2d",
  basemap: "auto",
  layout: DEFAULT_LAYOUT,
  columns: ALL_COLUMNS,
  globe: DEFAULT_GLOBE,
  solar: DEFAULT_SOLAR,
  sky: DEFAULT_SKY,
};

/** Optional URL parameters: ?lat=&lon=&name=  ?map=2d|3d  ?only=<category>  ?sats=<set>  ?theme=light|dark */
function fromUrl(): Partial<Prefs> {
  const p = new URLSearchParams(window.location.search);
  const out: Partial<Prefs> = {};
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  if (p.has("lat") && p.has("lon") && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    out.origin = { lat, lon, name: p.get("name") ?? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` };
    out.onboarded = true; // a shared link already says where to measure from
  }
  const map = p.get("map");
  if (map === "2d" || map === "3d") out.mapMode = map;
  const only = p.get("only");
  if (only && CATEGORIES.some((c) => c.id === only)) out.cats = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.id === only])) as Record<Category, boolean>;
  const sats = p.get("sats");
  if (sats) out.satSet = sats;
  const theme = p.get("theme");
  if (theme === "light" || theme === "dark") out.theme = theme;
  // ?open=sky,solar expands those side panels for the session (?open=all opens every one).
  const open = p.get("open");
  if (open) {
    const ids = open === "all" ? SIDE_PANES.map((s) => s.id) : (open.split(",").filter((id) => SIDE_PANES.some((s) => s.id === id)) as SidePane[]);
    if (ids.length) out.layout = { ...DEFAULT_LAYOUT, collapsed: { ...DEFAULT_LAYOUT.collapsed, ...Object.fromEntries(ids.map((id) => [id, false])) } };
  }
  return out;
}

const merge = <T extends object>(base: T, over: Partial<T> | undefined): T => ({ ...base, ...(over ?? {}) });
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

interface LegacyLayout {
  sideSplit?: number;
  solarFirst?: boolean;
}

function loadLayout(stored: (Partial<LayoutPrefs> & LegacyLayout) | undefined): LayoutPrefs {
  const layout = merge(DEFAULT_LAYOUT, stored);
  layout.collapsed = merge(DEFAULT_LAYOUT.collapsed, stored?.collapsed);
  layout.weights = merge(DEFAULT_LAYOUT.weights, stored?.weights);
  layout.split = clamp(layout.split, 0.2, 0.85, DEFAULT_LAYOUT.split);
  for (const k of SIDE_PANES) layout.weights[k.id] = clamp(layout.weights[k.id], 0.2, 5, 1);
  // Every side pane appears exactly once; unknown or missing entries fall back to the default order.
  const seen = new Set<SidePane>();
  const order: SidePane[] = [];
  for (const id of Array.isArray(stored?.order) ? stored.order : []) if (SIDE_PANES.some((p) => p.id === id) && !seen.has(id)) { seen.add(id); order.push(id); }
  for (const p of DEFAULT_LAYOUT.order) if (!seen.has(p)) order.push(p);
  if (!stored?.order && stored?.solarFirst) order.splice(order.indexOf("solar"), 1), order.unshift("solar");
  layout.order = order;
  delete (layout as LegacyLayout).sideSplit;
  delete (layout as LegacyLayout).solarFirst;
  return layout;
}

function load(): Prefs {
  let stored: Partial<Prefs> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Prefs>;
  } catch {
    /* ignore */
  }
  // Older preference sets predate the calmer defaults: reset what they cover once, keep the rest.
  if (stored.v !== PREFS_VERSION) {
    const o = stored.origin;
    const legacyOrigin = !o || (Math.abs(o.lat - LEGACY_ORIGIN.lat) < 1e-3 && Math.abs(o.lon - LEGACY_ORIGIN.lon) < 1e-3);
    stored = { ...stored, cats: undefined, solar: undefined, sky: undefined, onboarded: false, origin: legacyOrigin ? undefined : o };
  }
  const url = fromUrl();
  if (url.layout) url.layout = { ...loadLayout(stored.layout), collapsed: { ...loadLayout(stored.layout).collapsed, ...url.layout.collapsed } };
  const globe = merge(DEFAULT_GLOBE, stored.globe);
  globe.pointSize = clamp(globe.pointSize, 0.4, 3, 1);
  const solar = merge(DEFAULT_SOLAR, stored.solar);
  solar.kinds = merge(DEFAULT_SOLAR.kinds, stored.solar?.kinds);
  const sky = merge(DEFAULT_SKY, stored.sky);
  sky.magLimit = clamp(sky.magLimit, 2, 6.5, DEFAULT_SKY.magLimit);
  return {
    ...DEFAULTS,
    ...stored,
    ...url,
    v: PREFS_VERSION,
    origin: url.origin ?? stored.origin ?? DEFAULT_ORIGIN,
    cats: { ...DEFAULT_CATS, ...(stored.cats ?? {}), ...(url.cats ?? {}) },
    layout: url.layout ?? loadLayout(stored.layout),
    columns: merge(ALL_COLUMNS, stored.columns),
    globe,
    solar,
    sky,
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
