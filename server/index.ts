import express from "express";
import compression from "compression";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./cache";
import { SAT_SETS, getSatelliteSet } from "./celestrak";
import { getSatcat } from "./satcat";
import { getHorizonsTables, ensureRefresh, refreshLists } from "./horizons";
import { ensureOrbitsRefresh, getOrbits } from "./orbits";
import { getPois } from "./poi";
import { getAircraft } from "./aircraft";
import { getShips } from "./ships";
import { getTrains } from "./trains";
import { describe, flushDescriptions } from "./describe";
import { readCustomPlaces, writeCustomPlaces } from "./customPlaces";

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.use(compression());
app.use(express.json({ limit: "2mb" }));

const num = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

app.get("/api/satellites/sets", (_req, res) => {
  res.json(SAT_SETS.map(({ id, label, approx, description }) => ({ id, label, approx, description })));
});

app.get("/api/satellites/:set", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=600");
    res.json(await getSatelliteSet(req.params.set));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/horizons", (_req, res) => {
  res.json(getHorizonsTables());
});

app.get("/api/orbits", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(getOrbits());
});

app.get("/api/poi", async (req, res) => {
  const lat = num(req.query.lat, -90, 90);
  const lon = num(req.query.lon, -180, 180);
  if (lat === null || lon === null) {
    res.status(400).json({ error: "lat and lon are required" });
    return;
  }
  try {
    res.json(await getPois(lat, lon));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/aircraft", async (req, res) => {
  const lat = num(req.query.lat, -90, 90);
  const lon = num(req.query.lon, -180, 180);
  const nm = num(req.query.nm, 10, 250) ?? 250;
  if (lat === null || lon === null) {
    res.status(400).json({ error: "lat and lon are required" });
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getAircraft(lat, lon, nm));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/ships", (req, res) => {
  const lat = num(req.query.lat, -90, 90);
  const lon = num(req.query.lon, -180, 180);
  const km = num(req.query.km, 10, 1000) ?? 500;
  if (lat === null || lon === null) {
    res.status(400).json({ error: "lat and lon are required" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(getShips(lat, lon, km));
});

app.get("/api/trains", async (req, res) => {
  const lat = num(req.query.lat, -90, 90);
  const lon = num(req.query.lon, -180, 180);
  const km = num(req.query.km, 10, 40000) ?? 40000;
  if (lat === null || lon === null) {
    res.status(400).json({ error: "lat and lon are required" });
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getTrains(lat, lon, km));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/describe", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const fallback = String(req.query.fallback ?? "").trim() || undefined;
  const lang = /^[a-z]{2,3}$/.test(String(req.query.lang ?? "")) ? String(req.query.lang) : "en";
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  try {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json(await describe(q, fallback, lang));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/custom-places", (_req, res) => {
  res.json({ places: readCustomPlaces() });
});

app.put("/api/custom-places", (req, res) => {
  try {
    const body = req.body as { places?: unknown };
    res.json({ places: writeCustomPlaces(body?.places ?? []) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Serve the built web app when it exists (npm run build), otherwise explain what to do.
const dist = path.join(ROOT, "dist");
if (fs.existsSync(path.join(dist, "index.html"))) {
  // Hashed assets can be cached for a long time; index.html and the data files must always revalidate.
  app.use(
    express.static(dist, {
      index: "index.html",
      setHeaders: (res, filePath) => {
        const longLived = /[\\/]assets[\\/]/.test(filePath);
        res.setHeader("Cache-Control", longLived ? "public, max-age=31536000, immutable" : "no-cache");
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(dist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .type("text/plain")
      .send("Yonder API is running. Run `npm run build` to create the web app, or `npm run dev` for the dev server on :5173.");
  });
}

process.on("SIGINT", () => {
  flushDescriptions();
  process.exit(0);
});

app.listen(PORT, async () => {
  console.log(`Yonder is listening on http://localhost:${PORT}`);
  // Warm the caches in the background so the first page load is fast.
  await refreshLists().catch(() => {});
  getSatcat().catch((err) => console.warn(`[satcat] warm-up failed: ${(err as Error).message}`));
  getSatelliteSet("curated").catch((err) => console.warn(`[celestrak] warm-up failed: ${(err as Error).message}`));
  ensureRefresh()
    .then(() => ensureOrbitsRefresh())
    .catch((err) => console.warn(`[horizons] warm-up failed: ${(err as Error).message}`));
});
