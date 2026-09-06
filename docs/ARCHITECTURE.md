# Yonder architecture

Yonder is two processes: a Vite-built React client and a small Express server on the same
machine. The server exists because several upstream APIs forbid browser cross-origin requests and
because the caches should survive page reloads. The client does all of the maths.

```
 browser                                          node (server/)
 ┌──────────────────────────────────────────┐     ┌────────────────────────────────┐
 │ App.tsx                                  │     │ index.ts   Express routes      │
 │  ├ useStaticData   /data/*.json ─────────┼──▶  │ static dist/ + public/data     │
 │  ├ useEarthTargets (cities … pois)       │     │                                │
 │  ├ useSpaceTargets (Sun, Moon, planets,  │     │ celestrak.ts  TLE groups ──▶ CelesTrak
 │  │                  Horizons bodies) ◀───┼──── │ satcat.ts     catalog     ──▶ CelesTrak
 │  ├ useSatellites ──▶ sat.worker.ts       │     │ horizons.ts   vectors     ──▶ JPL Horizons
 │  │      (SGP4, Float32Array back)   ◀────┼──── │ orbits.ts     elements    ──▶ JPL Horizons
 │  ├ useAircraft  (dead-reckoned)     ◀────┼──── │ aircraft.ts   ADS-B       ──▶ adsb.fi / adsb.lol
 │  ├ usePoi                            ◀────┼──── │ poi.ts        Overpass    ──▶ OpenStreetMap
 │  ├ useDescription                    ◀────┼──── │ describe.ts   summaries   ──▶ Wikipedia
 │  └ useCustomPlaces                   ◀───▶┼──── │ customPlaces.ts           ──▶ data/custom-places.json
 │                                          │     │ cache.ts   data/cache/*.json   │
 │  filter → merge → DistanceTable          │     └────────────────────────────────┘
 │  earthRows / satRows / airRows → MapView │
 │                                GlobeView │
 │  solarItems → SolarSystem3D              │
 └──────────────────────────────────────────┘
```

## The Target

Everything the app can show is a `Target` (`src/types.ts`): id, name, category, `distanceKm`
and whichever optional fields apply (lat/lon for Earth things, alt/az look angles for things in
the sky, RA/Dec for fixed stars, a heliocentric vector for the Solar System view, a Wikipedia
hint, extra `facts` for the detail panel). Categories are grouped into realms: `earth`, `air`,
`space`. Every view consumes the same `Target` list, so a new data source only has to produce
targets.

Targets fall into three tiers by how often they change:

| Tier | Sources | Rebuilt when |
| --- | --- | --- |
| Fixed | stars, deep-sky objects, exoplanets, Solar System regions | dataset loads (distance never changes) |
| Earth static | cities, capitals, towns, airports, landmarks, POIs, custom places, computed points | origin moves, a dataset or the POI/custom list changes |
| Dynamic | Sun/Moon/planets, Horizons bodies, satellites, aircraft | every second (`useClock`) |

The static tiers are each sorted by distance once; the dynamic tier is small and sorted per tick.
`App.tsx` merges the three sorted lists for the table rather than sorting everything each second.

## Client data flow

1. **Clock.** `useClock(1000)` produces `now` aligned to the second. Every per-second memo depends
   on `now`; nothing else polls timers.
2. **Preferences.** `usePrefs` holds origin, units, category filters, satellite set, map mode,
   basemap. Persisted to `localStorage`, overridable by URL parameters.
3. **Static datasets.** `useStaticData` fetches `public/data/*.json` (cities and countries first,
   then towns, airports, exoplanets, stars as they arrive) and converts positional rows into
   objects. Search keys are normalised here, once.
4. **Earth targets.** `useEarthTargets` assigns each Earth place its great-circle distance from
   the origin and sorts nearest-first. The hand-curated `LANDMARKS`, the Overpass POIs around the
   origin (`usePoi`, debounced, re-fetched when the origin moves ~2 km) and the user's custom
   places join the same list, plus three computed points (antipode, centre of the Earth,
   Kármán line).
5. **Fixed targets.** `lib/stars.ts` builds the star, exoplanet and deep-sky targets. Curated
   deep-sky entries take precedence over HYG catalog stars with the same name.
6. **Solar System.** `useSpaceTargets` computes Sun, Moon and planets locally with
   `astronomy-engine` and interpolates every Horizons body (probes, moons, dwarf planets,
   asteroids, comets, this month's near-Earth flybys) from its 48-hour vector table using cubic
   Hermite interpolation (`lib/horizons.ts`). Look angles come from the same topocentric vector.
   The approach rate is the finite difference of distance between ticks.
7. **Satellites.** `useSatellites` fetches a TLE set from the server, posts it to
   `sat.worker.ts`, and every tick asks the worker to propagate all of them. The worker returns a
   `Float32Array` of seven values per satellite (range, az, el, sub-lat, sub-lon, height, speed);
   the hook turns finite rows into `Target`s. Ground tracks for the selected satellite are also
   computed by the worker on demand.
8. **Aircraft.** `useAircraft` polls `/api/aircraft` every 10 s and dead-reckons each aircraft
   forward from its last report using ground speed, track and vertical rate.
9. **Filter and merge.** A `pass(t)` predicate (category toggles plus the free-text filter over
   `Target.key`) is applied to each tier. The tiers are merged by the active sort into the row
   list for the table. Separately, the map and globe get up to 1,200 nearby Earth rows (capped at
   400 cities/towns/airports so landmarks stay visible), all visible satellites and all aircraft.
10. **Selection and hover.** `selectedId` and `hoverId` live in `App` and are shared by the table,
    map, globe and Solar System view, so hovering a marker highlights the row and vice versa.
    `useDescription` fetches the Wikipedia summary for the selected target through the server.

## Views

- **DistanceTable** — virtualised list with fixed 44 px rows; only the rows in the viewport
  (plus overscan) are mounted. Row is `memo`ised.
- **MapView** — Leaflet. Creates the map once; later effects diff marker sets by id so satellite
  and aircraft markers are moved, not recreated. Popups fetch a Wikipedia blurb lazily.
- **GlobeView** — globe.gl (three.js). Satellites, Earth places and aircraft are three
  `THREE.Points` layers whose position/colour buffers are rewritten each tick. Picking uses a
  raycaster against those layers. Lazy-loaded; only mounted in 3D mode.
- **SolarSystem3D** — plain three.js with OrbitControls and CSS2D labels. Planets are meshes,
  everything else is one `Points` cloud. Orbit shapes come from `/api/orbits`: conic paths from
  osculating elements for small bodies, sampled trajectories for spacecraft, and locally
  sampled orbits for the planets. Two scales: logarithmic (default) and linear.

## Server

`server/index.ts` mounts the API and, when `dist/index.html` exists, serves the built client with
long-lived caching for hashed assets and `no-cache` for everything else. Each module owns one
upstream:

| Module | Route | Cache | Refresh |
| --- | --- | --- | --- |
| `celestrak.ts` | `/api/satellites/sets`, `/api/satellites/:set` | `data/cache/celestrak-<group>.json` | 6 h; stale copy served on failure |
| `satcat.ts` | (used by celestrak) | `satcat.json` | 7 d |
| `horizons.ts` | `/api/horizons` | `horizons-<id>.json`, `horizons-moons.json`, `cneos-cad.json` | 48 h tables refreshed when <12 h remain; lists 12 h; 3-wide pool |
| `orbits.ts` | `/api/orbits` | `orbit-<id>.json` | 30 d (7 d for flybys); 2-wide pool |
| `poi.ts` | `/api/poi?lat&lon` | `poi-<cell>.json` | 7 d per 0.02° cell |
| `aircraft.ts` | `/api/aircraft?lat&lon&nm` | in memory | 8 s |
| `describe.ts` | `/api/describe?q&fallback` | `describe.json` (flushed every 60 s) | never expires |
| `customPlaces.ts` | `GET/PUT /api/custom-places` | `data/custom-places.json` | on write |

Horizons requests are serialised through `runPool` with small sleeps because the service rate-limits
aggressively. `getHorizonsTables()` triggers a background refresh and returns whatever is cached
right now, so the client sees bodies fill in progressively and polls every 20 s until `pending`
is zero.

## Coordinate frames

- Surface distances: haversine on a sphere of radius 6371.0088 km (`lib/geo.ts`).
- Aircraft and look angles: WGS84 geodetic to ECEF, then ENU (`lookAngles`).
- Satellites: SGP4 in TEME via satellite.js, converted to ECF and geodetic in the worker.
- Solar System: Horizons vectors are Earth-centred ICRF in km, which is what `astronomy-engine`
  uses for its equatorial J2000 frame; the observer vector is subtracted to get topocentric range
  and look angles. Heliocentric positions for the 3D view are rotated to ecliptic J2000 (AU).
- Fixed stars: RA/Dec J2000 to alt/az through `makeSky` (rotation matrix built once per tick).

## Data build

`scripts/build_data.py` downloads GeoNames (cities500, cities15000, countryInfo), OurAirports,
the NASA Exoplanet Archive composite table and the HYG star catalog into `data/raw/`, then writes
compact positional-row JSON to `public/data/`. Cities are sorted by population, airports by
size class, exoplanets by distance, stars by magnitude. The client relies on those orders for
search ranking.
