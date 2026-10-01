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

/**
 * Version tag for a table set: changes whenever any body's data, status or the refresh state changes. Lets the
 * browser revalidate the 1.4 MB Horizons response (or the orbit set) with a 304 instead of downloading it again,
 * which matters when the app is shared through a tunnel.
 */
function tagOf(prefix: string, data: { pending: number; refreshing: boolean; bodies: { id: string; status: string; fetchedAt?: number }[] }): string {
  let latest = 0;
  let errors = 0;
  for (const b of data.bodies) {
    if ((b.fetchedAt ?? 0) > latest) latest = b.fetchedAt ?? 0;
    if (b.status !== "ok") errors++;
  }
  return `W/"${prefix}-${data.bodies.length}-${latest}-${errors}-${data.pending}-${data.refreshing ? 1 : 0}"`;
}

app.get("/api/horizons", (req, res) => {
  const data = getHorizonsTables();
  const tag = tagOf("hz", data);
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("ETag", tag);
  if (req.headers["if-none-match"] === tag) {
    res.status(304).end();
    return;
  }
  res.json(data);
});

app.get("/api/orbits", (req, res) => {
  const data = getOrbits();
  const tag = tagOf("orb", data);
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("ETag", tag);
  if (req.headers["if-none-match"] === tag) {
    res.status(304).end();
    return;
  }
  res.json(data);
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
