# Yonder — notes for Claude Code

Yonder is a local web app that shows the live distance from a chosen origin on Earth to roughly
330,000 things: cities, towns, airports, landmarks, nearby OpenStreetMap places, aircraft, ships,
trains, satellites, Solar System bodies and their moons, spacecraft, exoplanets, stars and deep-sky
objects. Everything that moves updates once a second. It is a single-user desktop tool, not a
hosted service (it is sometimes shared through an ngrok tunnel).

Read `docs/ARCHITECTURE.md` before changing how data flows through the client.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | API server on :3000 (tsx watch) + Vite dev server on :5173 with HMR |
| `npm run build` | Type-check the client, then `vite build` into `dist/` |
| `npm start` | Serve `dist/` and the API on :3000 (`PORT=4000 npm start` to change) |
| `npm run typecheck` | Type-check client (`tsconfig.json`) and server (`tsconfig.server.json`) |
| `npm run data` | Rebuild the bundled datasets in `public/data/` (Python 3, downloads ~200 MB once) |
| `node scripts/check-math.mjs` | Sanity-check satellite and astronomy maths against live references |

There is no test suite and no linter configured. `npm run typecheck` is the gate: run it after
every change to `src/` or `server/`. Both configs use `strict`, `noUnusedLocals` and
`noUnusedParameters`, so unused imports fail the build.

`start.cmd` is the double-click launcher for the user: installs, builds if needed, starts the server
and opens the browser.

## Layout

```
src/                 React 19 + TypeScript client (Vite)
  App.tsx            Composition root: wires hooks together, filters and merges targets
  types.ts           Target, Category, CATEGORIES — the shared vocabulary
  hooks/             One hook per data source (useSatellites, useAircraft, useHorizons, ...)
  lib/               Pure maths and formatting (geo, astro, units, horizons interpolation)
  components/        UI; MapView (Leaflet), GlobeView (globe.gl), SkyView (canvas), SolarSystem3D (three.js)
  workers/           sat.worker.ts — SGP4 propagation off the main thread
  data/              Hand-curated lists: landmarks, deep-sky objects, Solar System regions
server/              Express 5 API: proxies and caches external services, stores custom places
scripts/             build_data.py (datasets), check-math.mjs
public/data/         Offline bundles built by build_data.py (committed, ~17 MB)
public/textures/     Globe textures; planets/ holds the Solar System Scope planet maps (CC BY 4.0)
data/cache/          Runtime cache written by the server (git-ignored)
data/raw/            Downloads used by build_data.py (git-ignored)
data/custom-places.json   The user's own places, editable by hand
```

## Conventions

- Distances are kilometres everywhere internally; `lib/units.ts` formats for display.
  `Target.distanceKm` is `NaN` while unknown and sorts last.
- Every row shown anywhere is a `Target` (`src/types.ts`). Ids are prefixed by source:
  `city-`, `town-`, `apt-`, `lm-`, `poi-`, `custom-`, `air-`, `ship-`, `train-`, `sat-<norad>`, `sol-`,
  `hz-<horizons id>`, `exo-`, `hyg-`, `dso-`, `ngc-`, `region-`. Several places pattern-match on
  these prefixes (`App.DYNAMIC_ID` lists the per-tick ones).
- Search text is pre-normalised into `Target.key` with `norm()` (`lib/search.ts`): lower-case,
  accents stripped. Never call `norm()` inside a per-tick loop; compute it once when data loads.
- Angles are degrees at the type boundary; radians only inside maths helpers.
- Heliocentric positions are ecliptic J2000 in AU; Earth-centred vectors are ICRF in km.
  Horizons data is requested in exactly those frames so nothing needs re-rotating.
- `astronomy-engine`: always build times with `makeTime()` from `lib/astro.ts`. `A.MakeTime(number)`
  treats a bare number as days since J2000, not milliseconds.
- Components that own an imperative library (Leaflet, globe.gl, three.js) create it once in a
  mount effect and update it in later effects. Keep React state out of the per-frame path; stash
  the latest props in a ref (`propsRef`) for event handlers.
- Server modules each own one external service and one on-disk cache (`server/cache.ts`).
  Serve a stale cache rather than fail when the upstream is down.
- Formatting: 2-space indent, double quotes, trailing commas, long lines are fine (the code is
  formatted to ~180 columns). Match the surrounding file.

## Performance rules

The client holds ~320k targets in memory and re-renders once a second. Keep these invariants:

- Static targets (cities, towns, airports, stars, exoplanets) are built once when their dataset
  loads. Only distances are recomputed when the origin moves; the objects are not rebuilt.
- Anything that runs every second must be O(dynamic targets), not O(all targets). Dynamic sets are
  satellites, aircraft and Solar System bodies (a few hundred to ~13k). Do not filter, sort, copy
  or scan the full static list inside a per-tick memo.
- Satellite propagation runs in `sat.worker.ts` and returns a transferable `Float32Array`. The
  main thread only builds display objects from it.
- The distance table is virtualised (`DistanceTable.tsx`, fixed 44 px rows). It receives a row
  accessor, not a materialised array of every visible row.
- The 3D scenes rebuild geometry only when the set of objects changes; per-second updates write
  into existing buffers. Point layers in `GlobeView` allocate with spare capacity and use
  `setDrawRange`; when they must grow, dispose the geometry first. Replacing attributes without
  disposing leaked GPU memory on every count change and eventually lost the WebGL context.
- Never feed per-tick data to globe.gl data layers (`pathsData`, `ringsData`, `pointsData`...): they
  rebuild their objects on every change and three.js recompiles the shaders of the new materials
  (an effect that depended on a satellite's height compiled four programs a second). Draw anything
  that moves with the app's own point layers. Keep globe.gl's pointer interaction off.
- Never change the renderer's pixel ratio or size during interaction: it reallocates the canvas
  (100+ ms stalls per zoom gesture were measured when the solar view did it to save fill rate).
- A `ShaderMaterial` writing colours must end with `#include <colorspace_fragment>`; `THREE.Color`
  values are linear and come out far too dark otherwise.
- The server's `refreshing` flags must only be true while fetches actually run (`staleBodies` /
  `staleOrbits` decide synchronously): when they were always true, every open tab re-downloaded
  1.4 MB every 20 s and rebuilt the solar scene every 45 s. `/api/horizons` and `/api/orbits` carry
  a version ETag with `no-cache`, so browsers revalidate with a 304; `useHorizons`/`useOrbits` keep
  the previous array/Map when nothing changed (a new `orbits` Map rebuilds the orbit lines).
- Speeds carry `Target.speedRef`: heliocentric for interplanetary bodies, relative to the planet for
  moons and for anything inside a planet's sphere of influence (JWST 0.5 km/s, not Earth's 30).
  Distances are geometric (where the body is now) for every body; directions are apparent.
- Avoid `Intl.NumberFormat` construction in render paths; the formatters in `lib/units.ts` are
  cached.
- Do not add formatted strings to the 300k static targets (notes, Wikipedia hints, fact lists).
  Store numbers or reuse shared strings, and derive display text on demand in `lib/target.ts`
  (`noteOf`) or `describeQuery`.
- Name order is origin-independent; sort it from `useEarthTargets().all`, not from the
  distance-ordered list, so moving the pin does not re-sort 320k strings.

## External services and etiquette

| Service | Used for | Cache | Notes |
| --- | --- | --- | --- |
| CelesTrak GP + SATCAT | Satellite elements and catalog facts | 6 h / 7 d on disk | Do not fetch a group more than once per 2 h |
| NASA/JPL Horizons | Probes, moons, small bodies (48 h vector tables), orbit elements | daily / monthly on disk | 2 concurrent table requests, 150 ms apart; orbit fetches run one at a time and never while tables refresh (more parallelism gets 503s) |
| CNEOS close-approach API | This month's near-Earth flybys | daily | |
| Overpass (OSM) | Places of interest within 22 km | 7 d per 2 km cell | Slow; four mirrors tried in turn |
| adsb.fi / adsb.lol | Live aircraft | 8 s in memory | Browser polls every 10 s |
| AISStream.io | Live ships (AIS) | last position per ship, in memory | Needs `AISSTREAM_KEY` env or `data/keys.json` (git-ignored); one WebSocket, ±3° box around the origin, closed after 3 min without polls |
| Digitraffic (FI), Amtraker (US) | Live trains | 30 s / 60 s in memory | No key; Digitraffic needs the `Digitraffic-User` header and gzip |
| OpenNGC | Deep-sky catalogue | offline bundle (`deepsky.json`) | Built by `build_data.py`; distances curated or from redshift |
| Wikipedia REST + Wikidata | Descriptions | forever on disk (misses too) | |

The server warms caches at start-up; first start with an empty `data/cache/` takes a few minutes
to fill Horizons tables in the background while the app is already usable.

## Gotchas

- Windows: files are LF; `.gitattributes` enforces it. Ignore "LF will be replaced by CRLF" noise.
- `public/data/*.json` are row arrays with a `fields` header, not objects, to keep them small.
  Field order is defined in `scripts/build_data.py` and read positionally in `useStaticData.ts`.
- `dist/` is git-ignored. `npm start` without a build serves a plain-text hint instead of the app.
- Prefs persist in `localStorage` under `yonder:prefs`; the URL parameters `?lat=&lon=&name=`,
  `?map=`, `?only=`, `?sats=`, `?select=`, `?open=`, `?theme=` override them for the session.
  Nested preference objects (`layout`, `columns`, `globe`, `solar`, `sky`) are deep-merged with
  their defaults in `load()`, so adding a field only needs a default. Bump `PREFS_VERSION` when a
  default should reach existing users; `load()` then resets categories, solar/sky options and the
  onboarding flag once, keeping origin (unless it is the old Skopje default) and layout.
- First run: `onboarded` is false until the user picks an origin in `Welcome` (or a `?lat&lon`
  link is opened). The default origin is Greenwich; the default categories are a calm subset
  (`DEFAULT_CATS`), and the solar view shows planet orbits only.
- Panels: `Pane` is controlled (collapsed state lives in `prefs.layout`), `Splitter` reports the
  fraction between its two DOM siblings, and `App` turns `layout` into the `--cols` grid variable
  and the side column's flex values. Side panes are ordered by `layout.order` and sized by
  `layout.weights` (a splitter between two panes rewrites their two weights). Do not set an inline
  `minHeight` on side panes; the stylesheet's 170 px minimum plus the scrolling side column keeps
  them usable on short windows. The table's visible columns come from `prefs.columns` and are
  rendered through the `--cols` variable on `.table`.
- SkyView draws on a 2D canvas with `SkyFrame` (fast alt/az, no precession); it receives the
  unfiltered fixed/space/satellite lists on purpose, because "what is above me" should not depend
  on the table filter. Deep-sky labels are limited to curated objects that are not quasars or
  pulsars; compass labels sit at altitude −5.5°, so keep the dome radius at `min(w,h)/2 − 34`.
- SolarSystem3D: three.js `Raycaster` ignores `visible`, so `pick()` filters candidates itself;
  `CSS2DRenderer` honours only an object's own `visible`, so `setLabelsVisible()` traverses. Only
  the planet system nearest the camera (within 16 display radii) is shown. Moon offsets must be
  geometric and planet-relative from the same source (`Target.rel`, see ARCHITECTURE "Planet
  systems"); `A.GeoVector` with its light-time and aberration corrections put Phobos 60° and Charon
  168° away from their true directions, and astronomy-engine's outer-planet positions are too coarse
  for moons (Charon came out 150,000 km from Pluto), so moons wait for the planet's Horizons table. Planet orientation comes from `A.RotationAxis`; the texture's poles are along the
  body frame's +z and its prime meridian along +x.
- Horizons tables of kind `planet` (199…999) are reference vectors for moon offsets, not targets;
  `useSpaceTargets` filters them out and the footer does not count them.
- Headless verification: `scratchpad/cdp.mjs`-style DevTools scripting (Chrome with
  `--use-angle=swiftshader`, 1250×820) renders all views; use `?open=` and `?select=` to reach
  states, click toolbar buttons through `Runtime.evaluate`.
- Basemaps: CARTO's free tiles now return "API KEY REQUIRED" watermarks, so the dark and light
  basemaps are Esri's World Dark/Light Gray canvases (base + reference labels, max zoom 16).
- Horizons body ids: negative numbers are spacecraft, `NNN;` is a small-body record number,
  `DES=...;CAP;` selects a comet's current apparition (falls back without `CAP;`).
- The satellite set "active" is ~13k objects. It works, but everything that touches satellite
  rows must stay cheap for that case.
