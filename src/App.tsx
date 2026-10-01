import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import * as A from "astronomy-engine";
import type { Category, SortState, Target } from "./types";
import { CATEGORIES, CATEGORY_BY_ID } from "./types";
import { ALL_ON, DEFAULT_LAYOUT, usePrefs, type ColumnId, type GlobePrefs, type LayoutPrefs, type PaneId, type SidePane, type SkyPrefs, type SolarPrefs, type ThemePref } from "./hooks/usePrefs";
import { useClock } from "./hooks/useClock";
import { useStaticData } from "./hooks/useStaticData";
import { LANDMARK_TARGETS, useEarthTargets } from "./hooks/useEarthTargets";
import { useHorizons } from "./hooks/useHorizons";
import { useOrbits } from "./hooks/useOrbits";
import { usePoi } from "./hooks/usePoi";
import { useSpaceTargets } from "./hooks/useSpaceTargets";
import { useSatellites } from "./hooks/useSatellites";
import { useAircraft } from "./hooks/useAircraft";
import { SHIP_RADIUS_KM, useVehicles } from "./hooks/useVehicles";
import { useCustomPlaces } from "./hooks/useCustomPlaces";
import { useDescription } from "./hooks/useDescription";
import { norm } from "./lib/search";
import { haversineKm } from "./lib/geo";
import { makeSky } from "./lib/sky";
import { comparatorFor, lazyIndex, mergeRows, sortByKey, sortStatic } from "./lib/merge";
import { orbitFacts } from "./lib/orbitFacts";
import { footprint as footprintOf, type PassSet } from "./lib/passes";
import { EARTH_PERIOD_DAYS, SOLAR_BODIES, makeObserver, makeTime, orbitSamples } from "./lib/astro";
import OriginPanel, { type SearchEntry } from "./components/OriginPanel";
import Filters from "./components/Filters";
import DistanceTable from "./components/DistanceTable";
import MapView from "./components/MapView";
import SkyView from "./components/SkyView";
import DetailPanel from "./components/DetailPanel";
import Pane from "./components/Pane";
import Splitter from "./components/Splitter";
import LayoutMenu from "./components/LayoutMenu";
import ColumnsMenu from "./components/ColumnsMenu";
import CustomPlacesPanel from "./components/CustomPlacesPanel";
import Welcome from "./components/Welcome";
import type { SolarItem } from "./components/SolarSystem3D";

const GlobeView = lazy(() => import("./components/GlobeView"));
const SolarSystem3D = lazy(() => import("./components/SolarSystem3D"));

const ISS_ID = "sat-25544";
const EMPTY: Target[] = [];
const MAP_SAT_LIMIT = 800;
const DYNAMIC_ID = /^(sat|hz|sol|air|ship|train)-/;

/** Resolved dark/light from the preference plus the system setting; also stamps <html data-theme>. */
function useTheme(pref: ThemePref): boolean {
  const [sysDark, setSysDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSysDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = pref === "auto" ? sysDark : pref === "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  return dark;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Returns the previous array when the ids are unchanged, so effects downstream do not re-run every tick. */
function useStableRows(rows: Target[]): Target[] {
  const ref = useRef(rows);
  const prev = ref.current;
  let same = prev.length === rows.length;
  if (same) for (let i = 0; i < rows.length; i++) if (prev[i].id !== rows[i].id) { same = false; break; }
  if (!same) ref.current = rows;
  return ref.current;
}

type Counts = Record<Category, number>;

/** Returns the previous counts object while every number is unchanged, so memoised children skip the per-second render. */
function useStableCounts(counts: Counts): Counts {
  const ref = useRef(counts);
  const prev = ref.current;
  if (prev !== counts && CATEGORIES.some((c) => prev[c.id] !== counts[c.id])) ref.current = counts;
  return ref.current;
}

function countOf(list: Target[]): Counts {
  const c = Object.fromEntries(CATEGORIES.map((k) => [k.id, 0])) as Counts;
  for (const t of list) c[t.category]++;
  return c;
}

export default function App() {
  const [prefs, setPrefs] = usePrefs();
  const { origin, unit, cats, satSet, pinOnClick, mapMode, basemap, theme, layout, columns, onboarded, globe: globePrefs, solar: solarPrefs, sky: skyPrefs } = prefs;
  const [live, setLive] = useState(true);
  const now = useClock(1000, live);
  const dark = useTheme(theme);
  const wide = useMediaQuery("(min-width: 1101px)");
  const { data: staticData, loading: loadingSets, error: staticError } = useStaticData();
  const custom = useCustomPlaces();
  const horizons = useHorizons();
  const { orbits } = useOrbits();
  const { pois, state: poiState } = usePoi(origin, cats.poi);
  const { byDistance: earth, all: earthAll } = useEarthTargets(origin, staticData, custom.places, pois);
  const fixed = staticData?.fixed ?? EMPTY;
  const space = useSpaceTargets(now, origin, horizons.tables);
  const sats = useSatellites(now, origin, satSet);
  const air = useAircraft(now, origin, cats.aircraft);
  const veh = useVehicles(now, origin, cats.ship, cats.train);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "distance", dir: "asc" });
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("select"));
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pickHint, setPickHint] = useState(false);

  // ---- filtering ----
  // Typing stays responsive: the 320k-row filter runs on the deferred value, not on every keystroke.
  const q = norm(useDeferredValue(search).trim());
  const allOn = useMemo(() => CATEGORIES.every((c) => cats[c.id]), [cats]);
  const filterList = useCallback(
    (list: Target[]): Target[] => (allOn && !q ? list : list.filter((t) => cats[t.category] && (!q || (t.key ?? norm(t.name)).includes(q)))),
    [allOn, q, cats],
  );
  const earthFiltered = useMemo(() => filterList(earth), [earth, filterList]);
  const fixedFiltered = useMemo(() => filterList(fixed), [fixed, filterList]);
  const satRows = useMemo(() => filterList(sats.targets), [sats.targets, filterList]);
  const airRows = useMemo(() => filterList(air.targets), [air.targets, filterList]);
  const vehicles = useMemo(() => (veh.ships.length || veh.trains.length ? veh.ships.concat(veh.trains) : EMPTY), [veh.ships, veh.trains]);
  const vehRows = useMemo(() => filterList(vehicles), [vehicles, filterList]);
  const dynamic = useMemo(() => [...space.targets, ...sats.targets, ...air.targets, ...vehicles], [space.targets, sats.targets, air.targets, vehicles]);

  // ---- table rows: a virtual merge of the static tier (sorted when the filter/sort changes) and the dynamic tier (sorted per tick) ----
  const cmp = useMemo(() => comparatorFor(sort), [sort]);
  // Name order does not depend on the origin, so it is computed from the catalogue-order list and survives origin changes.
  const nameSorted = useMemo(() => (sort.key === "name" ? sortByKey(filterList(earthAll).concat(filterList(fixed))) : null), [sort.key, earthAll, fixed, filterList]);
  const staticSorted = useMemo(() => {
    if (nameSorted) return sort.dir === "asc" ? nameSorted : nameSorted.slice().reverse();
    return sortStatic([earthFiltered, fixedFiltered], sort, cmp);
  }, [nameSorted, earthFiltered, fixedFiltered, sort, cmp]);
  const staticLookup = useMemo(() => lazyIndex(staticSorted), [staticSorted]);
  const dynamicSorted = useMemo(() => filterList(dynamic).sort(cmp), [dynamic, filterList, cmp]);
  const rows = useMemo(() => mergeRows(staticSorted, dynamicSorted, cmp, staticLookup), [staticSorted, dynamicSorted, cmp, staticLookup]);

  const earthCounts = useMemo(() => countOf(earth), [earth]);
  const fixedCounts = useMemo(() => countOf(fixed), [fixed]);
  const dynamicCounts = useStableCounts(useMemo(() => countOf(dynamic), [dynamic]));
  const counts = useMemo(() => {
    const c = { ...dynamicCounts };
    for (const k of CATEGORIES) c[k.id] += earthCounts[k.id] + fixedCounts[k.id];
    return c;
  }, [dynamicCounts, earthCounts, fixedCounts]);
  const total = earth.length + fixed.length + dynamic.length;

  // ---- selection ----
  const selectedStatic = useMemo(
    () => (selectedId && !DYNAMIC_ID.test(selectedId) ? (earth.find((t) => t.id === selectedId) ?? fixed.find((t) => t.id === selectedId) ?? null) : null),
    [selectedId, earth, fixed],
  );
  const selectedDynamic = useMemo(() => (selectedId ? (dynamic.find((t) => t.id === selectedId) ?? null) : null), [selectedId, dynamic]);
  const selected = selectedDynamic ?? selectedStatic;
  const description = useDescription(selected);
  const selectedOrbit = selected?.id.startsWith("hz-") ? orbits.get(selected.id.slice(3)) : undefined;
  const extraFacts = useMemo(() => orbitFacts(selectedOrbit), [selectedOrbit]);

  // Escape closes the detail panel (a full-screen pane handles Escape itself).
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".pane.fullscreen")) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const sky = useMemo(() => makeSky(makeTime(now), makeObserver(origin)), [now, origin]);

  // ---- origin helpers ----
  // The suggestion index is a list of references into the existing targets; nothing is copied.
  const searchIndex = useMemo<SearchEntry[]>(() => {
    const cities: Target[] = [];
    const towns: Target[] = [];
    const airports: Target[] = [];
    if (staticData) {
      for (const t of staticData.earth) {
        if (t.category === "city" || t.category === "capital") cities.push(t);
        else if (t.category === "town") towns.push(t);
        else if (t.category === "airport" && (t.kind === "large_airport" || t.kind === "medium_airport")) airports.push(t);
      }
    }
    const mine: SearchEntry[] = custom.places.map((p) => ({ name: p.name, subtitle: "My place", category: "custom", lat: p.lat, lon: p.lon, key: norm(p.name) }));
    return [...cities, ...LANDMARK_TARGETS, ...mine, ...towns, ...airports];
  }, [staticData, custom.places]);

  const nearestName = useCallback(
    (lat: number, lon: number): string => {
      const coords = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
      if (!staticData) return coords;
      let best: Target | null = null;
      let bd = Infinity;
      for (const t of staticData.earth) {
        if (t.category === "airport" || t.lat === undefined || t.lon === undefined) continue;
        const d = haversineKm(lat, lon, t.lat, t.lon);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      if (!best) return coords;
      const place = `${best.name}, ${(best.subtitle ?? "").replace(/^Capital of /, "")}`;
      return bd < 2 ? place : `${Math.round(bd)} km from ${place}`;
    },
    [staticData],
  );

  const setOrigin = useCallback(
    (lat: number, lon: number, name?: string) => {
      setPrefs({ origin: { lat, lon, name: name ?? nearestName(lat, lon) } });
      setPickHint(false);
    },
    [setPrefs, nearestName],
  );

  // ---- stable callbacks for memoised children ----
  const onSolo = useCallback(
    (c: Category) =>
      setPrefs((p) => {
        const alreadySolo = CATEGORIES.every((k) => p.cats[k.id] === (k.id === c));
        return { cats: alreadySolo ? ALL_ON : (Object.fromEntries(CATEGORIES.map((k) => [k.id, k.id === c])) as Record<Category, boolean>) };
      }),
    [setPrefs],
  );
  const onToggle = useCallback((c: Category) => setPrefs((p) => ({ cats: { ...p.cats, [c]: !p.cats[c] } })), [setPrefs]);
  const onAll = useCallback(() => setPrefs({ cats: ALL_ON }), [setPrefs]);
  const onUnit = useCallback((u: typeof unit) => setPrefs({ unit: u }), [setPrefs]);
  const onSatSet = useCallback((id: string) => setPrefs({ satSet: id }), [setPrefs]);
  const onTheme = useCallback((t: ThemePref) => setPrefs({ theme: t }), [setPrefs]);
  const onBasemap = useCallback((id: string) => setPrefs({ basemap: id }), [setPrefs]);
  const onPinToggle = useCallback((v: boolean) => setPrefs({ pinOnClick: v }), [setPrefs]);
  const setLayout = useCallback((patch: Partial<LayoutPrefs>) => setPrefs((p) => ({ layout: { ...p.layout, ...patch } })), [setPrefs]);
  const setCollapsed = useCallback((id: PaneId, v: boolean) => setPrefs((p) => ({ layout: { ...p.layout, collapsed: { ...p.layout.collapsed, [id]: v } } })), [setPrefs]);
  const setColumns = useCallback((c: Record<ColumnId, boolean>) => setPrefs({ columns: c }), [setPrefs]);
  const setGlobePrefs = useCallback((patch: Partial<GlobePrefs>) => setPrefs((p) => ({ globe: { ...p.globe, ...patch } })), [setPrefs]);
  const setSolarPrefs = useCallback((patch: Partial<SolarPrefs>) => setPrefs((p) => ({ solar: { ...p.solar, ...patch } })), [setPrefs]);
  const setSkyPrefs = useCallback((patch: Partial<SkyPrefs>) => setPrefs((p) => ({ sky: { ...p.sky, ...patch } })), [setPrefs]);
  /** Splitter between two side panes: convert the reported fraction into their relative weights. */
  const setSideSplit = useCallback(
    (a: SidePane, b: SidePane, f: number | null) =>
      setPrefs((p) => {
        const w = { ...p.layout.weights };
        if (f === null) {
          w[a] = 1;
          w[b] = 1;
        } else {
          const total = w[a] + w[b];
          w[a] = Math.max(0.2, f * total);
          w[b] = Math.max(0.2, (1 - f) * total);
        }
        return { layout: { ...p.layout, weights: w } };
      }),
    [setPrefs],
  );

  // ---- rows for the map and the globe ----
  // Nearest Earth places, capped so landmarks and points of interest are not drowned out by towns.
  const earthRows = useStableRows(
    useMemo(() => {
      const out: Target[] = [];
      let small = 0;
      for (const t of earthFiltered) {
        if (t.lat === undefined || CATEGORY_BY_ID[t.category].realm !== "earth") continue;
        if (t.category === "city" || t.category === "town" || t.category === "airport") {
          if (small >= 400) continue;
          small++;
        }
        out.push(t);
        if (out.length >= 1200) break;
      }
      return out;
    }, [earthFiltered]),
  );
  const mapSats = useMemo(() => (satRows.length > MAP_SAT_LIMIT ? satRows.slice(0, MAP_SAT_LIMIT) : satRows), [satRows]);

  // Ground track and visibility footprint for the selected satellite, or the ISS by default. Track refreshed once a minute.
  const trackTargetId = selected?.category === "satellite" ? selected.id : sats.targets.some((t) => t.id === ISS_ID) ? ISS_ID : null;
  const trackTarget = trackTargetId ? sats.targets.find((t) => t.id === trackTargetId) : undefined;
  const trackMinute = Math.floor(now / 60_000);
  const [track, setTrack] = useState<{ id: string; points: [number, number, number][] } | null>(null);
  useEffect(() => {
    if (!trackTargetId) {
      setTrack(null);
      return;
    }
    let cancelled = false;
    sats
      .trackOf(trackTargetId, Date.now())
      .then((points) => {
        if (!cancelled) setTrack({ id: trackTargetId, points });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackTargetId, trackMinute, sats.state.count]);
  // The footprint moves with the satellite; recomputed when it has moved about a quarter of a degree.
  const fpKey = trackTarget?.subLat !== undefined && trackTarget.subLon !== undefined ? `${Math.round(trackTarget.subLat * 4)}|${Math.round(trackTarget.subLon * 4)}|${Math.round((trackTarget.heightKm ?? 0) / 25)}` : "";
  const footprint = useMemo(
    () => (trackTarget?.subLat !== undefined && trackTarget.subLon !== undefined ? footprintOf(trackTarget.subLat, trackTarget.subLon, trackTarget.heightKm ?? 400) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fpKey],
  );

  // Pass predictions for the selected satellite over the current origin, refreshed every ten minutes.
  const [passes, setPasses] = useState<PassSet | null>(null);
  const [passesLoading, setPassesLoading] = useState(false);
  const selSatId = selected?.category === "satellite" ? selected.id : null;
  const passTick = Math.floor(now / 600_000);
  useEffect(() => {
    if (!selSatId) {
      setPasses(null);
      return;
    }
    let cancelled = false;
    setPassesLoading(true);
    const at = Date.now();
    sats
      .passesOf(selSatId, at)
      .then((ps) => {
        if (cancelled) return;
        setPasses({ id: selSatId, origin: `${origin.lat.toFixed(2)}°, ${origin.lon.toFixed(2)}°`, at, hours: 24, passes: ps });
        setPassesLoading(false);
      })
      .catch(() => {
        if (!cancelled) setPassesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selSatId, passTick, origin.lat, origin.lon, sats.state.count]);

  // ---- solar-system view data ----
  const hourKey = Math.floor(now / 3600e3);
  const planetOrbits = useMemo(() => {
    const time = makeTime(now);
    const m = new Map<string, ReturnType<typeof orbitSamples>>();
    for (const def of SOLAR_BODIES) if (def.kind === "Planet" || def.kind === "Dwarf planet") m.set(def.name, orbitSamples(def.body, def.periodDays, time, 180));
    m.set("Earth", orbitSamples(A.Body.Earth, EARTH_PERIOD_DAYS, time, 180));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourKey]);
  const solarItems = useMemo<SolarItem[]>(() => {
    const items: SolarItem[] = [
      { id: "earth", name: "Earth", pos: space.earthHelio, kind: "Planet", category: "solar", distanceKm: 0, orbit: planetOrbits.get("Earth"), radiusKm: 6371 },
    ];
    for (const t of space.targets) {
      if (!t.helio) continue;
      const def = SOLAR_BODIES.find((d) => d.name === t.name);
      items.push({
        id: t.id,
        name: t.name,
        pos: t.helio,
        kind: t.kind ?? "",
        category: t.category,
        distanceKm: t.distanceKm,
        orbit: planetOrbits.get(t.name),
        hzId: t.id.startsWith("hz-") ? t.id.slice(3) : undefined,
        radiusKm: def?.radiusKm,
        system: t.system,
        rel: t.rel,
      });
    }
    return items;
  }, [space, planetOrbits]);

  const hzBodies = horizons.tables.filter((t) => t.kind !== "planet"); // planet centres are references, not bodies
  const horizonsReady = hzBodies.filter((t) => t.status === "ok").length;
  const trackPoints = track && track.id === trackTargetId ? track.points : null;
  const trackPairs = useMemo(() => (trackPoints ? trackPoints.map((p): [number, number] => [p[0], p[1]]) : null), [trackPoints]);
  const loading = loadingSets.length > 0;

  // ---- layout ----
  const { collapsed, order, weights } = layout;
  const sideClosed = order.every((id) => collapsed[id]);
  const mainStyle = wide
    ? ({
        ["--cols" as string]: collapsed.table
          ? `44px 0px minmax(0, 1fr)`
          : sideClosed
            ? `minmax(0, 1fr) 0px 240px`
            : `minmax(0, ${layout.split}fr) 8px minmax(360px, ${1 - layout.split}fr)`,
      } as React.CSSProperties)
    : undefined;
  const openSide = order.filter((id) => !collapsed[id]);
  // Open panes keep the stylesheet's min-height (the side column scrolls when the window is short).
  const sideStyle = (id: SidePane): React.CSSProperties => (collapsed[id] ? { flex: "0 0 auto" } : { flex: `${openSide.length === 1 ? 1 : weights[id]} 1 0%` });

  const panes: Record<SidePane, React.ReactNode> = {
    map: (
      <Pane
        key="map"
        title={mapMode === "2d" ? "Map" : "Globe"}
        className="map-pane"
        collapsed={collapsed.map}
        onCollapse={(v) => setCollapsed("map", v)}
        style={sideStyle("map")}
        actions={
          <div className="segmented" role="group" aria-label="Map mode">
            <button type="button" className={mapMode === "2d" ? "on" : ""} aria-pressed={mapMode === "2d"} onClick={() => setPrefs({ mapMode: "2d" })}>
              2D map
            </button>
            <button type="button" className={mapMode === "3d" ? "on" : ""} aria-pressed={mapMode === "3d"} onClick={() => setPrefs({ mapMode: "3d" })}>
              3D globe
            </button>
          </div>
        }
      >
        {mapMode === "2d" ? (
          <MapView
            origin={origin}
            onOriginChange={setOrigin}
            pinOnClick={pinOnClick}
            earthRows={earthRows}
            satRows={mapSats}
            airRows={airRows}
            vehRows={vehRows}
            selected={selected}
            hoverId={hoverId}
            track={trackPairs}
            footprint={footprint}
            unit={unit}
            basemap={basemap}
            dark={dark}
            onBasemap={onBasemap}
            onSelect={setSelectedId}
            onHover={setHoverId}
          />
        ) : (
          <Suspense fallback={<div className="loading">Loading the globe…</div>}>
            <GlobeView
              origin={origin}
              earthRows={earthRows}
              sats={satRows}
              aircraft={airRows}
              vehicles={vehRows}
              selected={selected}
              hoverId={hoverId}
              track={trackPoints}
              footprint={footprint}
              unit={unit}
              dark={dark}
              pinOnClick={pinOnClick}
              prefs={globePrefs}
              onPrefs={setGlobePrefs}
              onSelect={setSelectedId}
              onHover={setHoverId}
              onOriginChange={setOrigin}
            />
          </Suspense>
        )}
      </Pane>
    ),
    sky: (
      <Pane key="sky" title="Sky" className="sky-pane" collapsed={collapsed.sky} onCollapse={(v) => setCollapsed("sky", v)} style={sideStyle("sky")}>
        <SkyView
          now={now}
          origin={origin}
          fixed={fixed}
          bodies={space.targets}
          sats={sats.targets}
          aircraft={air.targets}
          selected={selected}
          hoverId={hoverId}
          unit={unit}
          dark={dark}
          prefs={skyPrefs}
          onPrefs={setSkyPrefs}
          onSelect={setSelectedId}
          onHover={setHoverId}
        />
      </Pane>
    ),
    solar: (
      <Pane key="solar" title="Solar system" className="solar-pane" collapsed={collapsed.solar} onCollapse={(v) => setCollapsed("solar", v)} style={sideStyle("solar")}>
        <Suspense fallback={<div className="loading">Loading the solar system…</div>}>
          <SolarSystem3D
            items={solarItems}
            sats={satRows}
            orbits={orbits}
            selectedId={selectedId}
            hoverId={hoverId}
            unit={unit}
            now={now}
            prefs={solarPrefs}
            onPrefs={setSolarPrefs}
            onSelect={setSelectedId}
            onHover={setHoverId}
          />
        </Suspense>
      </Pane>
    ),
  };
  const sideChildren: React.ReactNode[] = [];
  order.forEach((id, i) => {
    sideChildren.push(panes[id]);
    const next = order[i + 1];
    if (next && !collapsed[id] && !collapsed[next]) {
      sideChildren.push(
        <Splitter key={`split-${id}-${next}`} direction="row" onChange={(f) => setSideSplit(id, next, f)} onReset={() => setSideSplit(id, next, null)} min={0.15} max={0.85} label={`Resize the ${id} and ${next} panels`} />,
      );
    }
  });

  const vehicleStatus = (label: string, st: typeof veh.shipState, radius?: string) =>
    st.status === "ready"
      ? ` · ${st.count} ${label}${radius ? ` within ${radius}` : ""}${st.note ? ` (${st.note})` : ""}`
      : st.status === "unconfigured"
        ? ` · ${label}: ${st.note}`
        : st.status === "error"
          ? ` · ${label} unavailable (${st.error})`
          : st.status === "loading"
            ? ` · loading ${label}…`
            : "";

  return (
    <div className="app">
      {loading && <div className="progress" role="progressbar" aria-label="Loading datasets" />}
      {!onboarded && (
        <Welcome
          index={searchIndex}
          ready={!!staticData}
          onChoose={(lat, lon, name) => {
            setOrigin(lat, lon, name);
            setPrefs({ onboarded: true });
          }}
          onPickOnMap={() => {
            setPrefs({ onboarded: true, pinOnClick: true, mapMode: "2d", layout: { ...layout, collapsed: { ...layout.collapsed, map: false } } });
            setPickHint(true);
          }}
          onDismiss={() => setPrefs({ onboarded: true })}
        />
      )}
      <header className="top">
        <div className="brand">
          <h1>Yonder</h1>
          <span className="tagline">how far is everything from here</span>
        </div>
        <OriginPanel origin={origin} index={searchIndex} onChange={setOrigin} pinOnClick={pinOnClick} onPinToggle={onPinToggle} />
        <CustomPlacesPanel places={custom.places} onAdd={custom.add} onRemove={custom.remove} status={custom.status} error={custom.error} origin={origin} />
        <LayoutMenu layout={layout} onChange={setLayout} onCollapse={setCollapsed} />
      </header>
      <Filters
        cats={cats}
        counts={counts}
        onSolo={onSolo}
        onToggle={onToggle}
        onAll={onAll}
        search={search}
        onSearch={setSearch}
        unit={unit}
        onUnit={onUnit}
        satSet={satSet}
        satSets={sats.sets}
        onSatSet={onSatSet}
        satState={sats.state}
        shown={rows.length}
        total={total}
        loading={loadingSets}
        live={live}
        onLive={setLive}
        theme={theme}
        onTheme={onTheme}
      />
      {staticError && <div className="banner error">City data failed to load: {staticError}</div>}
      {horizons.error && <div className="banner warn">NASA Horizons data unavailable: {horizons.error}. Is the server running?</div>}
      {pickHint && (
        <div className="banner pick-hint">
          Click anywhere on the map to set your origin, or drag the red pin.{" "}
          <button type="button" className="icon-btn" onClick={() => setPickHint(false)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      <main className={`main${selected ? " with-detail" : ""}`} style={mainStyle}>
        <Pane title="Distances" className="table-pane" collapsed={collapsed.table} onCollapse={(v) => setCollapsed("table", v)} vertical actions={<ColumnsMenu columns={columns} onChange={setColumns} />}>
          <DistanceTable
            rows={rows}
            unit={unit}
            origin={origin}
            sky={sky}
            selectedId={selectedId}
            hoverId={hoverId}
            onSelect={setSelectedId}
            onHover={setHoverId}
            sort={sort}
            onSort={setSort}
            columns={columns}
          />
        </Pane>
        {wide && !collapsed.table && !sideClosed ? (
          <Splitter direction="col" onChange={(f) => setLayout({ split: f })} onReset={() => setLayout({ split: DEFAULT_LAYOUT.split })} min={0.25} max={0.8} label="Resize the table" />
        ) : (
          <div className="splitter-gap" />
        )}
        <aside className="side">
          {selected && (
            <DetailPanel
              target={selected}
              origin={origin}
              unit={unit}
              sky={sky}
              description={description}
              extraFacts={extraFacts}
              now={now}
              passes={passes}
              passesLoading={passesLoading}
              onClose={() => setSelectedId(null)}
              onSetOrigin={setOrigin}
            />
          )}
          {sideChildren}
        </aside>
      </main>
      <footer className="foot">
        <span>
          {new Date(now).toLocaleTimeString()}
          {!live && " · paused"}
          {` · Horizons bodies ${horizonsReady}/${hzBodies.length || "…"}`}
          {cats.poi && poiState.status === "loading" && " · finding places nearby…"}
          {cats.poi && poiState.status === "ready" && ` · ${poiState.count} places within ${poiState.radiusKm ?? 22} km`}
          {cats.poi && poiState.status === "error" && ` · nearby places unavailable (${poiState.error})`}
          {cats.aircraft && air.state.status === "ready" && ` · ${air.state.count} aircraft within 460 km (${air.state.source})`}
          {cats.aircraft && air.state.status === "error" && ` · aircraft unavailable (${air.state.error})`}
          {cats.ship && vehicleStatus("ships", veh.shipState, `${SHIP_RADIUS_KM} km`)}
          {cats.train && vehicleStatus("trains", veh.trainState)}
        </span>
        <span className="muted">
          GeoNames (CC BY 4.0) · OurAirports · OpenStreetMap · CelesTrak · NASA/JPL Horizons & CNEOS · NASA Exoplanet Archive · HYG star catalog · OpenNGC · adsb.fi / adsb.lol ·
          AISStream · Digitraffic · Amtraker · Wikipedia · astronomy-engine · planet textures by Solar System Scope (CC BY 4.0)
        </span>
      </footer>
    </div>
  );
}
