# Yonder

How far is everything from here. Pick an origin anywhere on Earth and see the live distance to
more than 330,000 things: cities, towns and villages, capitals, landmarks, places of interest
around you, airports, your own places, aircraft in flight, ships, trains, satellites, the Sun,
Moon and planets, 186 moons, dwarf planets, asteroids, comets, this month's near-Earth flybys,
28 deep-space probes, 6,000+ exoplanets, 8,700 naked-eye stars and nearly 10,000 galaxies,
clusters, nebulae, pulsars and quasars. Everything that moves updates every second.

On first open the app asks where you are (browser location, a search, a click on the map, or
Greenwich to just explore). It starts with a calm set of categories; towns, nearby places, live
aircraft, ships, trains and exoplanets are one click away.

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
- **Sky**: a planetarium of what is above the origin right now: zenith in the middle, horizon at
  the rim, north up and east on the left (as when you look up; Options can mirror it). Stars by
  magnitude and colour, the Sun and Moon (with phase), planets, spacecraft, satellites and aircraft
  above the horizon, galaxies and nebulae, twilight colours. Hover for names, click for details.
  Off by default; open it from the Layout menu or the collapsed Sky header.
- **Satellite passes**: selecting a satellite shows its next passes over the origin for the coming
  24 hours (rise, peak altitude and direction, set, duration) with a live countdown, plus the
  dashed footprint on the map and globe showing where on Earth it is above the horizon right now.
- **Categories**: click a chip to show only that category; click it again or press **All** to go
  back. Ctrl/Shift-click adds or removes a category.
- **Details**: click any row, marker or dot. The panel shows every computed value plus a Wikipedia
  summary when one exists. Earth places can be made the new origin from there.
- **Map**: basemap switcher (dark, light, OpenStreetMap, satellite imagery, terrain), layer
  toggles, popups with descriptions, aircraft with headings, the ground track of the selected
  satellite (or the ISS). Hovering a marker highlights its row and vice versa.
- **3D globe**: switch with the 2D/3D control. Every tracked satellite orbits at its real height,
  cyan when above your horizon; aircraft in yellow, ships in blue, trains in green; places as
  dots. Click a dot for details. The toolbar flies back to the origin, auto-rotates, switches
  day/night textures, toggles layers and sets the dot size. Dots are drawn by a small shader and
  the full 13,000-satellite catalogue stays smooth.
- **Solar system**: drag to orbit, wheel to zoom (towards the cursor), right-drag to pan.
  Textured, sunlit planets oriented and spinning as they really are (IAU rotation model),
  atmospheres, Earth's city lights on its night side, Saturn's rings and the Milky Way behind.
  Select a planet and press Focus to fly into its system: its moons (all 186, the major ones
  labelled), the spacecraft orbiting it and any close flyby appear around it at their real
  directions, true scale near the planet and compressed further out. Earth's system shows the
  Moon, the tracked satellites (low orbits hugging the surface, the geostationary ring further out)
  and the observatories at the Sun-Earth Lagrange points. Follow keeps the camera on the selected
  body as it moves. Planet orbits are always drawn; the orbit of an asteroid, comet or spacecraft
  appears when you hover or select it (Options can show them all). Options filter by kind, toggle
  atmospheres, labels or the background, and switch between the compressed (logarithmic) and true
  scale.
- **Panels**: drag the bars between panels to resize them (double-click resets), minimise any
  panel with – and bring it back from its header or the Layout menu, reorder the map, sky and
  solar system panels with the arrows in that menu, and pick which table columns to show with
  Columns. Every panel has a ⛶ full-screen
  button; Esc leaves full screen. Esc also closes the
  details panel, and table rows can be reached with Tab and selected with Enter.
- **Live / Paused**: the toolbar button freezes the once-a-second updates (and the CPU they use)
  until you resume.
- **Theme**: System, Light or Dark from the toolbar; the map's default basemap follows it.
- **Satellite sets**: choose from stations, navigation, communications, Earth observation,
  science, Starlink/OneWeb/Kuiper, military, CubeSats, recent launches, debris clouds, or all
  ~13,000 active satellites.
- **Direction**: compass bearing for places on Earth; altitude above your horizon and compass
  azimuth for everything in the sky (green arrow = currently above the horizon).
- **Ships and trains**: live AIS ship positions need a free key from [aisstream.io](https://aisstream.io):
  put it in the `AISSTREAM_KEY` environment variable or in `data/keys.json` as
  `{ "aisstream": "..." }` and restart the server. Ships within 500 km of the origin then appear
  with heading, speed, destination and status. Trains come from the open feeds that need no key
  (Finland's Digitraffic and Amtrak); there is no worldwide train feed, so they show wherever they
  are.
- **Links**: `?lat=&lon=&name=` sets the origin (and skips the welcome), `?map=3d` opens the globe,
  `?only=satellite` shows one category, `?sats=active` picks a satellite set, `?select=sat-25544`
  selects an object, `?open=sky` (or `map`, `solar`, `all`) expands panels, `?theme=dark` forces a
  theme.

## Development

- `CLAUDE.md` — conventions, commands and performance rules for anyone (or any agent) editing the code.
- `docs/ARCHITECTURE.md` — how data flows from the external services through the server and the
  client hooks into the table, map, globe and Solar System views.

## Data sources

| Data | Source | Refresh |
| --- | --- | --- |
| Cities (15k+), towns and villages (500+), capitals | GeoNames (CC BY 4.0), via `scripts/build_data.py` | offline bundle |
| Airports | OurAirports (public domain) | offline bundle |
| Places of interest within 22 km | OpenStreetMap via Overpass (ODbL) | per area, weekly |
| Landmarks, curated deep-sky objects, pulsars, quasars | hand-curated lists in `src/data/` | |
| Galaxies, clusters, nebulae (NGC/IC) | OpenNGC (CC BY-SA 4.0); Messier and named distances curated, galaxy distances from redshift | offline bundle |
| Aircraft | adsb.fi, fallback adsb.lol (community ADS-B) | every 10 s, dead-reckoned in between |
| Ships | AISStream.io (needs a free API key) | streamed, dead-reckoned between polls |
| Trains | Digitraffic (Finland), Amtraker (Amtrak) | every 30–60 s |
| Satellites | CelesTrak elements + SATCAT (owner, launch, orbit) | 6 h / weekly |
| Sun, Moon, planets | astronomy-engine, computed in the browser | every second |
| Probes, moons, small bodies, flybys | NASA/JPL Horizons; flyby list from CNEOS | daily |
| Orbit shapes | Horizons osculating elements and sampled trajectories | monthly |
| Exoplanets | NASA Exoplanet Archive | offline bundle |
| Stars (magnitude ≤ 6.5) | HYG database v4.1 (CC BY-SA 4.0) | offline bundle |
| Descriptions | Wikipedia REST API | cached |
| Planet textures | Solar System Scope (CC BY 4.0), via Wikimedia Commons | bundled |

`server/` is a small Express app that proxies and caches the external APIs (CelesTrak and Overpass
do not allow browser cross-origin requests) and stores your places in `data/custom-places.json`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server + Vite dev server with hot reload |
| `npm run build` | Type-check and build the web app |
| `npm start` | Serve the built app and API on port 3000 (`PORT=4000 npm start` to change) |
| `npm run typecheck` | Type-check client and server |
| `npm run data` | Rebuild the bundled datasets (GeoNames, OurAirports, exoplanets, stars, OpenNGC) |
| `node scripts/check-math.mjs` | Compare the satellite and astronomy maths against live references |
