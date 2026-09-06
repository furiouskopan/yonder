# Yonder

How far is everything from here. Pick an origin anywhere on Earth and see the live distance to
more than 320,000 things: cities, towns and villages, capitals, landmarks, places of interest
around you, airports, your own places, aircraft in flight, satellites, the Sun, Moon and planets,
186 moons, dwarf planets, asteroids, comets, this month's near-Earth flybys, 28 deep-space probes,
6,000+ exoplanets and 8,700 naked-eye stars. Everything that moves updates every second.

## Run it

```bash
npm install          # once
npm run build        # builds the web app into dist/
npm start            # http://localhost:3000
```

`start.cmd` does all three and opens the browser. For development with hot reload use `npm run dev`
(API on :3000, web app on :5173).

The first start downloads satellite elements and the satellite catalog from CelesTrak, position
tables for 360+ Horizons bodies from NASA/JPL (a few minutes in the background), and later the
orbit shapes. Everything is cached in `data/cache/`, so later starts are instant and the app keeps
working offline (moving objects then drift slowly out of date).

## Using it

- **Origin**: search a city, town, landmark or airport, type coordinates, use the browser's
  location, click the map or globe, or drag the red pin. Remembered between visits.
- **Categories**: click a chip to show only that category; click it again or press **All** to go
  back. Ctrl/Shift-click adds or removes a category.
- **Details**: click any row, marker or dot. The panel shows every computed value plus a Wikipedia
  summary when one exists. Earth places can be made the new origin from there.
- **Map**: basemap switcher (dark, light, OpenStreetMap, satellite imagery, terrain), layer
  toggles, popups with descriptions, aircraft with headings, the ground track of the selected
  satellite (or the ISS). Hovering a marker highlights its row and vice versa.
- **3D globe**: switch with the 2D/3D control. Every tracked satellite orbits at its real height,
  cyan when above your horizon; aircraft in yellow; places as dots. Click a dot for details.
- **Solar system**: drag to orbit, wheel to zoom, right-drag to pan. Real orbit shapes for
  planets, dwarf planets, asteroids, comets and interstellar visitors, trajectories for
  spacecraft. Toggle between the compressed (logarithmic) and true scale.
- **Full screen**: every panel has a ⛶ button; Esc leaves full screen.
- **Satellite sets**: choose from stations, navigation, communications, Earth observation,
  science, Starlink/OneWeb/Kuiper, military, CubeSats, recent launches, debris clouds, or all
  ~13,000 active satellites.
- **Direction**: compass bearing for places on Earth; altitude above your horizon and compass
  azimuth for everything in the sky (green arrow = currently above the horizon).
- **Links**: `?lat=&lon=&name=` sets the origin, `?map=3d` opens the globe, `?only=satellite`
  shows one category, `?sats=active` picks a satellite set, `?select=sat-25544` selects an object.

## Data sources

| Data | Source | Refresh |
| --- | --- | --- |
| Cities (15k+), towns and villages (500+), capitals | GeoNames (CC BY 4.0), via `scripts/build_data.py` | offline bundle |
| Airports | OurAirports (public domain) | offline bundle |
| Places of interest within 22 km | OpenStreetMap via Overpass (ODbL) | per area, weekly |
| Landmarks, curated deep-sky objects | hand-curated lists in `src/data/` | |
| Aircraft | adsb.fi, fallback adsb.lol (community ADS-B) | every 10 s, dead-reckoned in between |
| Satellites | CelesTrak elements + SATCAT (owner, launch, orbit) | 6 h / weekly |
| Sun, Moon, planets | astronomy-engine, computed in the browser | every second |
| Probes, moons, small bodies, flybys | NASA/JPL Horizons; flyby list from CNEOS | daily |
| Orbit shapes | Horizons osculating elements and sampled trajectories | monthly |
| Exoplanets | NASA Exoplanet Archive | offline bundle |
| Stars (magnitude ≤ 6.5) | HYG database v4.1 (CC BY-SA 4.0) | offline bundle |
| Descriptions | Wikipedia REST API | cached |

`server/` is a small Express app that proxies and caches the external APIs (CelesTrak and Overpass
do not allow browser cross-origin requests) and stores your places in `data/custom-places.json`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server + Vite dev server with hot reload |
| `npm run build` | Type-check and build the web app |
| `npm start` | Serve the built app and API on port 3000 (`PORT=4000 npm start` to change) |
| `npm run typecheck` | Type-check client and server |
| `npm run data` | Rebuild the bundled datasets (GeoNames, OurAirports, exoplanets, stars) |
| `node scripts/check-math.mjs` | Compare the satellite and astronomy maths against live references |
