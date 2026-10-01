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
 │  ├ useVehicles  (ships, trains)     ◀────┼──── │ ships.ts      AIS socket  ──▶ AISStream.io (key)
 │  │                                       │     │ trains.ts     positions   ──▶ Digitraffic, Amtraker
 │  ├ usePoi                            ◀────┼──── │ poi.ts        Overpass    ──▶ OpenStreetMap
 │  ├ useDescription                    ◀────┼──── │ describe.ts   summaries   ──▶ Wikipedia
 │  └ useCustomPlaces                   ◀───▶┼──── │ customPlaces.ts           ──▶ data/custom-places.json
 │                                          │     │ cache.ts   data/cache/*.json   │
 │  filter → merge → DistanceTable          │     └────────────────────────────────┘
 │  earthRows / satRows / airRows /        │
 │            vehRows / footprint → MapView │
 │                                GlobeView │
 │  fixed + bodies + sats + air → SkyView   │
 │  solarItems (planets, moons…) → SolarSystem3D
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
| Fixed | stars, deep-sky objects (curated + OpenNGC), exoplanets, Solar System regions | dataset loads (distance never changes) |
| Earth static | cities, capitals, towns, airports, landmarks, POIs, custom places, computed points | origin moves, a dataset or the POI/custom list changes |
| Dynamic | Sun/Moon/planets, Horizons bodies, satellites, aircraft, ships, trains | every second (`useClock`) |

The static tiers are sorted once per origin/filter/sort change; the dynamic tier is small and
sorted per tick. `App.tsx` never materialises the union: `lib/merge.ts` records where each dynamic
row falls inside the static list and answers `rows.at(i)` with two binary searches, so the
once-a-second work is proportional to the dynamic tier only.

Static Earth targets are shared objects. `useStaticData` creates them once; `useEarthTargets`
writes `distanceKm` into them in place when the origin moves and returns a new array of the same
objects sorted nearest-first (a packed numeric sort over a `Float64Array`, not a comparator sort
over objects). Name order does not depend on the origin and is cached separately. Nothing else
may mutate a `Target`.

## Client data flow

1. **Clock.** `useClock(1000)` produces `now` aligned to the second. Every per-second memo depends
   on `now`; nothing else polls timers.
2. **Preferences.** `usePrefs` holds origin, units, category filters, satellite set, map mode,
   basemap, the panel layout and the per-view options. Persisted to `localStorage`, overridable by
   URL parameters. `PREFS_VERSION` resets the defaults-related parts (categories, solar/sky
   options, the onboarding flag) once when the stored version is older; the origin and layout
   survive. `onboarded: false` shows the welcome dialog until the user picks an origin.
3. **Static datasets.** `useStaticData` fetches `public/data/*.json` (cities and countries first,
   then towns, airports, exoplanets, stars as they arrive) and converts positional rows straight
   into `Target`s in 12k-row slices between frames, so the page stays responsive while 300k rows
   are processed. Search keys are normalised here, once. Places store a numeric population and no
   Wikipedia hint; `lib/target.ts` (`noteOf`) and `describeQuery` derive the display strings on
   demand instead of holding 600k formatted strings in memory. The same objects double as the
   origin-search index (`App.searchIndex` is an array of references, not copies).
4. **Earth targets.** `useEarthTargets` assigns each Earth place its great-circle distance from
   the origin in place and returns them sorted nearest-first. The hand-curated `LANDMARKS`, the
   Overpass POIs around the origin (`usePoi`, debounced, re-fetched when the origin moves ~2 km)
   and the user's custom places join the same list, plus three computed points (antipode, centre
   of the Earth, Kármán line).
5. **Fixed targets.** `lib/stars.ts` builds the star, exoplanet and deep-sky targets straight from
   the positional rows. Curated deep-sky entries take precedence over HYG catalog stars with the
   same name and over OpenNGC rows with the same Messier number or common name. Stars carry a
   numeric `mag` so the sky view can size them without parsing facts.
6. **Solar System.** `useSpaceTargets` computes Sun, Moon and planets locally with
   `astronomy-engine` and interpolates every Horizons body (probes, moons, dwarf planets,
   asteroids, comets, this month's near-Earth flybys) from its 48-hour vector table using cubic
   Hermite interpolation (`lib/horizons.ts`). Look angles come from the same topocentric vector.
   The approach rate is the finite difference of distance between ticks. Outside its table a body
   is extrapolated linearly only for a limited time (`MAX_OUTSIDE_MS`: an hour for moons, six for
   close-approach asteroids, three days for the rest); beyond that it shows as out of date rather
   than at an invented position. That matters after a restart with an old cache, when the server
   serves expired tables while it refreshes them.
7. **Satellites.** `useSatellites` fetches a TLE set from the server, posts it to
   `sat.worker.ts`, and every tick asks the worker to propagate all of them. The worker returns a
   `Float32Array` of seven values per satellite (range, az, el, sub-lat, sub-lon, height, speed);
   the hook spreads the numbers over a per-satellite base object (name, class, SATCAT facts) that
   was built once when the set loaded. Ground tracks and pass predictions (`passesOf`: every
   above-horizon interval in the next 24 h at 15 s steps, with rise/peak/set azimuths) for the
   selected satellite are also computed by the worker on demand; `App` refreshes the passes every
   ten minutes and `lib/passes.ts` formats them and computes the visibility footprint circle.
8. **Aircraft, ships, trains.** `useAircraft` polls `/api/aircraft` every 10 s and dead-reckons
   each aircraft forward from its last report using ground speed, track and vertical rate.
   `useVehicles` does the same for ships (`/api/ships`, 15 s, speed and course over ground) and
   trains (`/api/trains`, 30 s); both are fetched only while their category chip is on. Surface
   vehicles use the great-circle distance like places do.
9. **Filter and merge.** The category toggles plus the free-text filter (deferred with
   `useDeferredValue`, matched against `Target.key`) are applied to each tier; when every category
   is on and the text is empty the original arrays are passed through untouched. The static tier is
   sorted for the active sort (a merge of the two distance-ordered lists, or a cached key sort for
   the name column), the dynamic tier is sorted per tick, and `mergeRows` exposes the union to the
   table as a `RowSource`. Separately, the map and globe get up to 1,200 nearby Earth rows straight
   from the distance-ordered Earth list (capped at 400 cities/towns/airports so landmarks stay
   visible), the visible satellites (the 2D map draws at most 800) and all aircraft.
10. **Selection and hover.** `selectedId` and `hoverId` live in `App` and are shared by the table,
    map, globe, sky and Solar System views, so hovering a marker highlights the row and vice versa.
    `useDescription` fetches the Wikipedia summary for the selected target through the server.
11. **Planet systems.** `useSpaceTargets` gives every moon a `system` (its planet) and a `rel`
    vector: its geometric offset from the planet centre in ecliptic J2000 AU. The planet centre comes
    from the server's Horizons table for that planet (kind `planet`, ids 199…999, never shown as
    targets), so moon and planet share frame, time scale and corrections exactly. Moons wait for
    that table: astronomy-engine's outer-planet positions are off by tens to hundreds of thousands of
    km (Charon came out 150,000 km from Pluto). Spacecraft near a planet may use the astronomy-engine
    geometric difference meanwhile. Never use `A.GeoVector` for this: its light-time and aberration
    corrections moved planets by 26,000 km (Mars) to 500,000 km (Pluto) relative to their moons'
    geometric positions, putting Phobos 60° and Charon 168° away from their true directions. Spacecraft and asteroids join a planet's system while they are
    within two Hill radii of it (Sun-Earth L1/L2 observatories, Mars orbiters, Juno, flybys within
    about 8 lunar distances). Earth's Moon uses `A.GeoMoon` (geometric) and keeps kind `Moon`.

## Views

- **DistanceTable** — virtualised list with fixed 44 px rows over a `RowSource`; only the rows in
  the viewport (plus overscan) are mounted. Row is `memo`ised and receives the per-second sky
  function only when it needs it (stars, exoplanets), so Earth rows do not re-render every tick.
  Rows are keyboard-focusable; Enter or Space selects.
- **MapView** — Leaflet with the canvas renderer (all circle markers on one canvas). Creates the
  map once; later effects diff marker sets by id so satellite and aircraft markers are moved, not
  recreated, and restyled only when they cross the horizon. Tooltips are functions evaluated when
  shown, reading the latest target from a per-id map. Popups fetch a Wikipedia blurb lazily.
- **SkyView** — a 2D canvas planetarium. `lib/sky.ts` `SkyFrame` does the alt/az maths with plain
  spherical trigonometry (no precession or refraction, fine for a chart) so thousands of stars
  cost a few milliseconds per tick; the exact `makeSky` path is still used for single objects.
  Star positions, sizes and colours are precomputed into typed arrays when the catalogue or the
  magnitude limit changes. Everything drawn is also pushed into a hit list for hover and click.
  Solar-system bodies, satellites and aircraft reuse the look angles the rest of the app computes.
- **GlobeView** — globe.gl (three.js). Satellites, Earth places, aircraft, surface vehicles, the
  tracked satellite's orbit (heights from the worker) and its visibility footprint are six
  `THREE.Points` layers drawn by one small `ShaderMaterial` (round, soft, per-point size, clamped
  pixel size, `#include <colorspace_fragment>` so its linear colours reach the sRGB canvas
  correctly) whose buffers are rewritten in place each tick. The buffers are allocated with spare
  capacity and only grow (disposing the geometry first) with `setDrawRange` marking the live count.
  The id → index map is rebuilt only when the id list changes, coordinates are computed inline
  (globe radius 100) and the bounding sphere is fixed. globe.gl's own data layers are used only for
  things that change when the origin moves (origin point and label): its path and ring layers
  rebuild their objects, and recompile their shaders, on every data change. Its pointer interaction
  is off, because it raycasts the whole globe every 50 ms whether or not the pointer moves; hover,
  picking (occluded by the globe) and click-to-move-origin (ray-sphere intersection and
  `toGeoCoords`) are handled here. The selection is a dot at the target's height plus a ring
  pulsing on the ground, animated in `onBeforeRender`.
  A toolbar toggles layers, auto-rotation, the day/night texture and dot size (`prefs.globe`); a
  `webglcontextlost` listener shows a rebuild button instead of a black canvas. Rendering pauses
  while the tab is hidden. Lazy-loaded; only mounted in 3D mode.
- **SolarSystem3D** — plain three.js with OrbitControls and CSS2D labels. Planets (and the Sun and
  the Moon) are textured, lit spheres oriented and spun with the IAU rotation model
  (`A.RotationAxis`: pole RA/Dec and prime-meridian angle, turned into an ecliptic-frame quaternion
  by `orient()`), so Earth shows the right face to the Sun and the Moon keeps its near side to
  Earth; Saturn's rings sit in its equatorial plane. Worlds with air get an additive halo (the back
  faces of a 1.12x shell: brightest just outside the limb, fading outward, dimmer on the night side;
  the shader ends with `colorspace_fragment`). Earth's night texture is an emissive map masked to the
  night side in `onBeforeCompile`. A constant-size marker point at each planet keeps it visible
  when its sphere is tiny (True scale, or far away). In True scale bodies are drawn at 0.12 of
  their Compressed size so the Sun and the inner planets no longer overlap.
  Each planet has a local system drawn as an inset (`insetRadii`): true distance out to 2.3 planet
  radii (rings, low orbits, Phobos), then 1.2 display radii per decade, so LEO hugs the surface,
  GEO sits at 2.85, the Moon at 4 and Sun-Earth L2 at 4.7 Earth radii, in their real directions.
  One system is shown at a time: the selected body's when the camera is within 16 display radii of
  it, otherwise the nearest (Saturn and Neptune line up on the compressed scale in 2026, so
  "nearest" alone picked the wrong one). It shows the moons (one `InstancedMesh` per planet; Earth's
  Moon its own textured sphere) and, for Earth, the tracked artificial satellites as a point cloud
  (computed only while shown). Spacecraft and flybys inside a system, and any body whose main-scale
  position would fall inside a planet's sphere (in the log scale Earth's sphere covers ±0.1 AU
  radially, Jupiter's more than an AU), are drawn in that planet's inset and stay visible from
  afar; their heliocentric lines are hidden. Bodies inside the Sun's sphere (Parker near perihelion)
  get the same treatment around the Sun. All materials, including the hidden systems', are compiled
  right after a rebuild so nothing compiles mid-zoom. Small-body orbit lines and spacecraft trails
  live in their own group and effect, so new orbit data rebuilds only them; they are visible for
  the hovered or selected body unless the option is on. `pick()` filters by visibility (three.js
  raycasts invisible objects too) and scales its tolerance with the camera distance. The pixel ratio
  is fixed: switching it during interaction resizes the canvas and stalled every zoom gesture.
  Follow moves the camera by the selected body's per-tick displacement and switches off when the
  selection changes. The selection ring is a camera-facing quad whose shader draws a ring about
  2 px wide, never smaller than 10 px across. The Milky Way is a back-face sphere. The scene is
  (re)built only when the set of bodies, the kind filters or the scale changes; the per-second
  update writes positions and orientations into the existing objects through per-body handles
  (`positionAll`), which also runs at the end of every rebuild so nothing is ever drawn at the
  origin. `?debug` exposes the scene as `window.__solar` for headless checks. Orbit shapes come from `/api/orbits`:
  conic paths from osculating elements for small bodies, sampled trajectories for spacecraft, and
  locally sampled orbits for the planets (resampled hourly). Orbit lines are pickable: hovering
  one names its body and brightens it, clicking selects. `prefs.solar` holds the kind filters,
  orbit/trail/label/background toggles and the scale (logarithmic or linear).

## Preferences and theme

`usePrefs` persists origin, units, category toggles, satellite set, map mode, basemap, theme
(`auto` | `light` | `dark`), the panel layout (column split, side split, collapsed panels, pane
order), the visible table columns and the globe and solar-system view options in `localStorage`. `index.html` applies the saved theme to
`<html data-theme>` before the bundle loads so there is no flash; `App.useTheme` keeps it in sync
with the system setting while on `auto`. The clock can be paused from the toolbar, which freezes
every per-second computation.

## Server

`server/index.ts` mounts the API and, when `dist/index.html` exists, serves the built client with
long-lived caching for hashed assets and `no-cache` for everything else. Each module owns one
upstream:

| Module | Route | Cache | Refresh |
| --- | --- | --- | --- |
| `celestrak.ts` | `/api/satellites/sets`, `/api/satellites/:set` | `data/cache/celestrak-<group>.json` | 6 h; stale copy served on failure |
| `satcat.ts` | (used by celestrak) | `satcat.json` | 7 d |
| `horizons.ts` | `/api/horizons` | `horizons-<id>.json`, `horizons-moons.json`, `cneos-cad.json` | 48 h tables refreshed when <12 h remain; lists 12 h; 2-wide pool; planet centres, flybys and moons refresh first |
| `orbits.ts` | `/api/orbits` | `orbit-<id>.json` | 30 d (7 d for flybys); one at a time, never while tables refresh |
| `poi.ts` | `/api/poi?lat&lon` | `poi-<cell>.json` | 7 d per 0.02° cell |
| `aircraft.ts` | `/api/aircraft?lat&lon&nm` | in memory | 8 s |
| `ships.ts` | `/api/ships?lat&lon&km` | in memory (last position per MMSI, 25 min) | AISStream WebSocket kept open while polled; box of ±3° around the origin; `{configured:false}` without a key |
| `trains.ts` | `/api/trains?lat&lon&km` | in memory per provider | Digitraffic 30 s, Amtraker 60 s; stale list kept on failure |
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

## Performance baseline

Measured in headless Chromium (Playwright, software GL) on the default satellite set, 2D map,
after all datasets loaded, 15 s steady state:

| | before | after |
| --- | --- | --- |
| JS heap used | 259 MB | 95 MB |
| Main-thread script time | 538 ms per second | 17 ms per second |
| Long tasks (>50 ms) in 15 s | 49 | 1 |
| Blocking time while datasets load | 5.2 s (worst 818 ms) | 0.8 s (worst 213 ms) |

With every active satellite (~16k) and the 3D globe the new build spends ~150 ms of script per
second, most of it building the per-tick satellite targets and rewriting the globe buffers.

## Data build

`scripts/build_data.py` downloads GeoNames (cities500, cities15000, countryInfo), OurAirports,
the NASA Exoplanet Archive composite table, the HYG star catalog and OpenNGC into `data/raw/`,
then writes compact positional-row JSON to `public/data/`. Deep-sky distances: a curated table for
the Messier objects and ~70 famous NGC/IC objects, light-travel distance from redshift (flat
ΛCDM, H0 = 70) for galaxies with z > 0.002, and nothing else (objects without a distance are
left out). Cities are sorted by population, airports by
size class, exoplanets by distance, stars by magnitude. The client relies on those orders for
search ranking.
