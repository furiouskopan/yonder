import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as A from "astronomy-engine";
import type { Category, SortState, Target } from "./types";
import { CATEGORIES, CATEGORY_BY_ID } from "./types";
import { ALL_ON, usePrefs } from "./hooks/usePrefs";
import { useClock } from "./hooks/useClock";
import { useStaticData, type PlaceRow } from "./hooks/useStaticData";
import { useEarthTargets } from "./hooks/useEarthTargets";
import { useHorizons } from "./hooks/useHorizons";
import { useOrbits } from "./hooks/useOrbits";
import { usePoi } from "./hooks/usePoi";
import { useSpaceTargets } from "./hooks/useSpaceTargets";
import { useSatellites } from "./hooks/useSatellites";
import { useAircraft } from "./hooks/useAircraft";
import { useCustomPlaces } from "./hooks/useCustomPlaces";
import { useDescription } from "./hooks/useDescription";
import { buildFixedTargets } from "./lib/stars";
import { norm } from "./lib/search";
import { haversineKm } from "./lib/geo";
import { makeSky } from "./lib/sky";
import { EARTH_PERIOD_DAYS, SOLAR_BODIES, makeObserver, makeTime, orbitSamples } from "./lib/astro";
import { LANDMARKS } from "./data/landmarks";
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

const byDistance = (a: Target, b: Target): number => {
  const x = a.distanceKm;
  const y = b.distanceKm;
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
  if (Number.isNaN(y)) return -1;
  return x - y;
};

/** Merge lists that are each sorted by distance (NaN last) into one sorted list. */
function mergeByDistance(lists: Target[][]): Target[] {
  const total = lists.reduce((s, l) => s + l.length, 0);
  const out: Target[] = new Array<Target>(total);
  const idx = lists.map(() => 0);
  for (let k = 0; k < total; k++) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < lists.length; i++) {
      const l = lists[i];
      if (idx[i] >= l.length) continue;
      const d = l[idx[i]].distanceKm;
      const dd = Number.isNaN(d) ? Infinity : d;
      if (best < 0 || dd < bestD) {
        best = i;
        bestD = dd;
      }
    }
    out[k] = lists[best][idx[best]++];
  }
  return out;
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
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

export default function App() {
  const [prefs, setPrefs] = usePrefs();
  const { origin, unit, cats, satSet, pinOnClick, mapMode, basemap } = prefs;
  const now = useClock(1000);
  const dark = useDarkMode();
  const { data: staticData, loading: loadingSets, error: staticError } = useStaticData();
  const custom = useCustomPlaces();
  const horizons = useHorizons();
  const { orbits } = useOrbits();
  const { pois, state: poiState } = usePoi(origin, cats.poi);
  const earth = useEarthTargets(origin, staticData, custom.places, pois);
  const space = useSpaceTargets(now, origin, horizons.tables);
  const sats = useSatellites(now, origin, satSet);
  const air = useAircraft(now, origin, cats.aircraft);
  const fixed = useMemo(() => buildFixedTargets(staticData).sort(byDistance), [staticData]);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "distance", dir: "asc" });
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("select"));
  const [hoverId, setHoverId] = useState<string | null>(null);

  // ---- filtering and merging (static lists are filtered only when the filter changes) ----
  const q = norm(search.trim());
  const pass = useCallback((t: Target) => cats[t.category] && (!q || (t.key ?? norm(t.name)).includes(q)), [cats, q]);
  const dynamic = useMemo(() => [...space.targets, ...sats.targets, ...air.targets], [space.targets, sats.targets, air.targets]);
  const earthFiltered = useMemo(() => earth.filter(pass), [earth, pass]);
  const fixedFiltered = useMemo(() => fixed.filter(pass), [fixed, pass]);
  const dynamicFiltered = useMemo(() => dynamic.filter(pass).sort(byDistance), [dynamic, pass]);
  const visible = useMemo(() => {
    if (sort.key === "name") {
      const dir = sort.dir === "asc" ? 1 : -1;
      return [...earthFiltered, ...dynamicFiltered, ...fixedFiltered].sort((a, b) => dir * a.name.localeCompare(b.name));
    }
    const merged = mergeByDistance([earthFiltered, dynamicFiltered, fixedFiltered]);
    if (sort.dir === "asc") return merged;
    const finite = merged.filter((t) => !Number.isNaN(t.distanceKm)).reverse();
    return [...finite, ...merged.filter((t) => Number.isNaN(t.distanceKm))];
  }, [earthFiltered, dynamicFiltered, fixedFiltered, sort]);

  const countOf = (list: Target[]) => {
    const c = Object.fromEntries(CATEGORIES.map((k) => [k.id, 0])) as Record<Category, number>;
    for (const t of list) c[t.category]++;
    return c;
  };
  const earthCounts = useMemo(() => countOf(earth), [earth]);
  const fixedCounts = useMemo(() => countOf(fixed), [fixed]);
  const counts = useMemo(() => {
    const c = countOf(dynamic);
    for (const k of CATEGORIES) c[k.id] += earthCounts[k.id] + fixedCounts[k.id];
    return c;
  }, [dynamic, earthCounts, fixedCounts]);
  const total = earth.length + fixed.length + dynamic.length;

  // ---- selection ----
  const selectedStatic = useMemo(
    () => (selectedId && !/^(sat|hz|sol|air)-/.test(selectedId) ? (earth.find((t) => t.id === selectedId) ?? fixed.find((t) => t.id === selectedId) ?? null) : null),
    [selectedId, earth, fixed],
  );
  const selectedDynamic = useMemo(() => (selectedId ? (dynamic.find((t) => t.id === selectedId) ?? null) : null), [selectedId, dynamic]);
  const selected = selectedDynamic ?? selectedStatic;
  const description = useDescription(selected);

  const sky = useMemo(() => makeSky(makeTime(now), makeObserver(origin)), [now, origin]);

  // ---- origin helpers ----
  const searchIndex = useMemo<SearchEntry[]>(() => {
    const idx: SearchEntry[] = [];
    if (staticData) {
      for (const c of staticData.cities) idx.push({ name: c.name, sub: staticData.countryNames[c.cc] ?? c.cc, lat: c.lat, lon: c.lon, key: norm(c.name) });
    }
    for (const l of LANDMARKS) idx.push({ name: l.name, sub: l.kind, lat: l.lat, lon: l.lon, key: norm(l.name) });
    for (const p of custom.places) idx.push({ name: p.name, sub: "My place", lat: p.lat, lon: p.lon, key: norm(p.name) });
    if (staticData) {
      for (const c of staticData.towns) idx.push({ name: c.name, sub: staticData.countryNames[c.cc] ?? c.cc, lat: c.lat, lon: c.lon, key: norm(c.name) });
      for (const a of staticData.airports) if (a.type === "large_airport" || a.type === "medium_airport") idx.push({ name: a.name, sub: [a.iata, a.municipality].filter(Boolean).join(" · "), lat: a.lat, lon: a.lon, key: norm(a.name) });
    }
    return idx;
  }, [staticData, custom.places]);

  const nearestName = useCallback(
    (lat: number, lon: number): string => {
      const coords = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
      if (!staticData) return coords;
      let best: PlaceRow | null = null;
      let bd = Infinity;
      for (const list of [staticData.cities, staticData.towns]) {
        for (const c of list) {
          const d = haversineKm(lat, lon, c.lat, c.lon);
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
      }
      if (!best) return coords;
      const country = staticData.countryNames[best.cc] ?? best.cc;
      return bd < 2 ? `${best.name}, ${country}` : `${Math.round(bd)} km from ${best.name}, ${country}`;
    },
    [staticData],
  );

  const setOrigin = useCallback(
    (lat: number, lon: number, name?: string) => {
      setPrefs({ origin: { lat, lon, name: name ?? nearestName(lat, lon) } });
    },
    [setPrefs, nearestName],
  );

  // ---- category chips ----
  const onSolo = (c: Category) => {
    const alreadySolo = CATEGORIES.every((k) => cats[k.id] === (k.id === c));
    setPrefs({ cats: alreadySolo ? ALL_ON : (Object.fromEntries(CATEGORIES.map((k) => [k.id, k.id === c])) as Record<Category, boolean>) });
  };

  // ---- rows for the map and the globe ----
  const earthRows = useStableRows(
    useMemo(() => {
      const out: Target[] = [];
      let small = 0;
      for (const t of visible) {
        if (t.lat === undefined || CATEGORY_BY_ID[t.category].realm !== "earth") continue;
        if (t.category === "city" || t.category === "town" || t.category === "airport") {
          if (small >= 400) continue;
          small++;
        }
        out.push(t);
        if (out.length >= 1200) break;
      }
      return out;
    }, [visible]),
  );
  const satRows = useMemo(() => visible.filter((t) => t.category === "satellite"), [visible]);
  const airRows = useMemo(() => visible.filter((t) => t.category === "aircraft"), [visible]);

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

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>Yonder</h1>
          <span className="tagline">how far is everything from here</span>
        </div>
        <OriginPanel origin={origin} index={searchIndex} onChange={setOrigin} pinOnClick={pinOnClick} onPinToggle={(v) => setPrefs({ pinOnClick: v })} />
        <CustomPlacesPanel places={custom.places} onAdd={custom.add} onRemove={custom.remove} status={custom.status} error={custom.error} origin={origin} />
      </header>
      <Filters
        cats={cats}
        counts={counts}
        onSolo={onSolo}
        onToggle={(c) => setPrefs({ cats: { ...cats, [c]: !cats[c] } })}
        onAll={() => setPrefs({ cats: ALL_ON })}
        search={search}
        onSearch={setSearch}
        unit={unit}
        onUnit={(u) => setPrefs({ unit: u })}
        satSet={satSet}
        satSets={sats.sets}
        onSatSet={(id) => setPrefs({ satSet: id })}
        satState={sats.state}
        shown={visible.length}
        total={total}
        loading={loadingSets}
      />
      {staticError && <div className="banner error">City data failed to load: {staticError}</div>}
      {horizons.error && <div className="banner warn">NASA Horizons data unavailable: {horizons.error}. Is the server running?</div>}
      <main className={`main${selected ? " with-detail" : ""}`}>
        <Pane title="Distances" className="table-pane">
          <DistanceTable
            rows={visible}
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
              <div className="segmented">
                <button type="button" className={mapMode === "2d" ? "on" : ""} onClick={() => setPrefs({ mapMode: "2d" })}>
                  2D map
                </button>
                <button type="button" className={mapMode === "3d" ? "on" : ""} onClick={() => setPrefs({ mapMode: "3d" })}>
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
                satRows={satRows.slice(0, 800)}
                airRows={airRows}
                selected={selected}
                hoverId={hoverId}
                track={track && track.id === trackTargetId ? track.points : null}
                unit={unit}
                basemap={basemap}
                dark={dark}
                onBasemap={(id) => setPrefs({ basemap: id })}
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
          {new Date(now).toLocaleTimeString()} · Horizons bodies {horizonsReady}/{horizons.tables.length || "…"}
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
