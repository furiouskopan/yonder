# Yonder — notes for Claude Code

Yonder is a local web app that shows the live distance from a chosen origin on Earth to roughly
320,000 things: cities, towns, airports, landmarks, nearby OpenStreetMap places, aircraft,
satellites, Solar System bodies, spacecraft, exoplanets and stars. Everything that moves updates
once a second. It is a single-user desktop tool, not a hosted service.

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
  components/        UI; MapView (Leaflet), GlobeView (globe.gl), SolarSystem3D (three.js)
  workers/           sat.worker.ts — SGP4 propagation off the main thread
  data/              Hand-curated lists: landmarks, deep-sky objects, Solar System regions
server/              Express 5 API: proxies and caches external services, stores custom places
scripts/             build_data.py (datasets), check-math.mjs
public/data/         Offline bundles built by build_data.py (committed, ~17 MB)
public/textures/     Globe textures
data/cache/          Runtime cache written by the server (git-ignored)
data/raw/            Downloads used by build_data.py (git-ignored)
data/custom-places.json   The user's own places, editable by hand
```

## Conventions

- Distances are kilometres everywhere internally; `lib/units.ts` formats for display.
  `Target.distanceKm` is `NaN` while unknown and sorts last.
- Every row shown anywhere is a `Target` (`src/types.ts`). Ids are prefixed by source:
  `city-`, `town-`, `apt-`, `lm-`, `poi-`, `custom-`, `air-`, `sat-<norad>`, `sol-`, `hz-<horizons id>`,
  `exo-`, `hyg-`, `dso-`, `region-`. Several places pattern-match on these prefixes.
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
  into existing buffers.
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
| Wikipedia REST + Wikidata | Descriptions | forever on disk (misses too) | |

The server warms caches at start-up; first start with an empty `data/cache/` takes a few minutes
to fill Horizons tables in the background while the app is already usable.

## Gotchas

- Windows: files are LF; `.gitattributes` enforces it. Ignore "LF will be replaced by CRLF" noise.
- `public/data/*.json` are row arrays with a `fields` header, not objects, to keep them small.
  Field order is defined in `scripts/build_data.py` and read positionally in `useStaticData.ts`.
- `dist/` is git-ignored. `npm start` without a build serves a plain-text hint instead of the app.
- Prefs persist in `localStorage` under `yonder:prefs`; the URL parameters `?lat=&lon=&name=`,
  `?map=`, `?only=`, `?sats=`, `?select=` override them for the session.
- Horizons body ids: negative numbers are spacecraft, `NNN;` is a small-body record number,
  `DES=...;CAP;` selects a comet's current apparition (falls back without `CAP;`).
- The satellite set "active" is ~13k objects. It works, but everything that touches satellite
  rows must stay cheap for that case.
