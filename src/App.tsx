import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import * as A from "astronomy-engine";
import type { Category, SortState, Target } from "./types";
import { CATEGORIES, CATEGORY_BY_ID } from "./types";
import { ALL_ON, usePrefs, type ThemePref } from "./hooks/usePrefs";
import { useClock } from "./hooks/useClock";
import { useStaticData } from "./hooks/useStaticData";
import { LANDMARK_TARGETS, useEarthTargets } from "./hooks/useEarthTargets";
import { useHorizons } from "./hooks/useHorizons";
import { useOrbits } from "./hooks/useOrbits";
import { usePoi } from "./hooks/usePoi";
import { useSpaceTargets } from "./hooks/useSpaceTargets";
import { useSatellites } from "./hooks/useSatellites";
import { useAircraft } from "./hooks/useAircraft";
import { useCustomPlaces } from "./hooks/useCustomPlaces";
import { useDescription } from "./hooks/useDescription";
import { norm } from "./lib/search";
import { haversineKm } from "./lib/geo";
import { makeSky } from "./lib/sky";
import { comparatorFor, lazyIndex, mergeRows, sortByKey, sortStatic } from "./lib/merge";
import { EARTH_PERIOD_DAYS, SOLAR_BODIES, makeObserver, makeTime, orbitSamples } from "./lib/astro";
import OriginPanel, { type SearchEntry } from "./components/OriginPanel";
import Filters from "./components/Filters";
import DistanceTable from "./components/DistanceTable";
import MapView from "./components/MapView";
import DetailPanel from "./components/DetailPanel";
import Pane from "./components/Pane";
import CustomPlacesPanel from "./components/CustomPlacesPanel";
import type { SolarItem } from "./components/SolarSystem3D";

const GlobeView = lazy(() => import("./components/GlobeView"));
const SolarSystem3D = lazy(() => import("./components/SolarSystem3D"));

const ISS_ID = "sat-25544";
const EMPTY: Target[] = [];
const MAP_SAT_LIMIT = 800;

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
  const { origin, unit, cats, satSet, pinOnClick, mapMode, basemap, theme } = prefs;
  const [live, setLive] = useState(true);
  const now = useClock(1000, live);
  const dark = useTheme(theme);
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

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "distance", dir: "asc" });
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("select"));
  const [hoverId, setHoverId] = useState<string | null>(null);

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
  const dynamic = useMemo(() => [...space.targets, ...sats.targets, ...air.targets], [space.targets, sats.targets, air.targets]);

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
    () => (selectedId && !/^(sat|hz|sol|air)-/.test(selectedId) ? (earth.find((t) => t.id === selectedId) ?? fixed.find((t) => t.id === selectedId) ?? null) : null),
    [selectedId, earth, fixed],
  );
  const selectedDynamic = useMemo(() => (selectedId ? (dynamic.find((t) => t.id === selectedId) ?? null) : null), [selectedId, dynamic]);
  const selected = selectedDynamic ?? selectedStatic;
  const description = useDescription(selected);

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

  // Ground track for the selected satellite, or the ISS by default. Refreshed once a minute.
  const trackTargetId = selected?.category === "satellite" ? selected.id : sats.targets.some((t) => t.id === ISS_ID) ? ISS_ID : null;
  const trackTarget = trackTargetId ? sats.targets.find((t) => t.id === trackTargetId) : undefined;
  const trackMinute = Math.floor(now / 60_000);
  const [track, setTrack] = useState<{ id: string; points: [number, number][] } | null>(null);
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
      if (!t.helio || t.name === "Sun" || t.kind === "moon") continue;
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
      });
    }
    return items;
  }, [space, planetOrbits]);

  const horizonsReady = horizons.tables.filter((t) => t.status === "ok").length;
  const trackHeightKm = trackTarget?.heightKm ?? 420;
  const loading = loadingSets.length > 0;

  return (
    <div className="app">
      {loading && <div className="progress" role="progressbar" aria-label="Loading datasets" />}
      <header className="top">
        <div className="brand">
          <h1>Yonder</h1>
          <span className="tagline">how far is everything from here</span>
        </div>
        <OriginPanel origin={origin} index={searchIndex} onChange={setOrigin} pinOnClick={pinOnClick} onPinToggle={onPinToggle} />
        <CustomPlacesPanel places={custom.places} onAdd={custom.add} onRemove={custom.remove} status={custom.status} error={custom.error} origin={origin} />
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
      <main className={`main${selected ? " with-detail" : ""}`}>
        <Pane title="Distances" className="table-pane">
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
          />
        </Pane>
        <aside className="side">
          {selected && (
            <DetailPanel target={selected} origin={origin} unit={unit} sky={sky} description={description} onClose={() => setSelectedId(null)} onSetOrigin={setOrigin} />
          )}
          <Pane
            title={mapMode === "2d" ? "Map" : "Globe"}
            className="map-pane"
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
                selected={selected}
                hoverId={hoverId}
                track={track && track.id === trackTargetId ? track.points : null}
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
                  selected={selected}
                  hoverId={hoverId}
                  track={track && track.id === trackTargetId ? track.points : null}
                  trackHeightKm={trackHeightKm}
                  unit={unit}
                  dark={dark}
                  pinOnClick={pinOnClick}
                  onSelect={setSelectedId}
                  onHover={setHoverId}
                  onOriginChange={setOrigin}
                />
              </Suspense>
            )}
          </Pane>
          <Pane title="Solar system" className="solar-pane">
            <Suspense fallback={<div className="loading">Loading the solar system…</div>}>
              <SolarSystem3D items={solarItems} orbits={orbits} selectedId={selectedId} hoverId={hoverId} unit={unit} onSelect={setSelectedId} onHover={setHoverId} />
            </Suspense>
          </Pane>
        </aside>
      </main>
      <footer className="foot">
        <span>
          {new Date(now).toLocaleTimeString()}
          {!live && " · paused"}
          {` · Horizons bodies ${horizonsReady}/${horizons.tables.length || "…"}`}
          {cats.poi && poiState.status === "loading" && " · finding places nearby…"}
          {cats.poi && poiState.status === "ready" && ` · ${poiState.count} places within ${poiState.radiusKm ?? 22} km`}
          {cats.poi && poiState.status === "error" && ` · nearby places unavailable (${poiState.error})`}
          {cats.aircraft && air.state.status === "ready" && ` · ${air.state.count} aircraft within 460 km (${air.state.source})`}
          {cats.aircraft && air.state.status === "error" && ` · aircraft unavailable (${air.state.error})`}
        </span>
        <span className="muted">
          GeoNames (CC BY 4.0) · OurAirports · OpenStreetMap · CelesTrak · NASA/JPL Horizons & CNEOS · NASA Exoplanet Archive · HYG star catalog · adsb.fi / adsb.lol ·
          Wikipedia · astronomy-engine
        </span>
      </footer>
    </div>
  );
}
