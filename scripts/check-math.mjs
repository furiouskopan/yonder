// Self-test: compares Yonder's satellite and astronomy maths against independent references.
//   node scripts/check-math.mjs
import fs from "node:fs";
import * as S from "satellite.js";
import * as A from "astronomy-engine";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const KM_PER_AU = 149597870.7;
const origin = { lat: 41.9981, lon: 21.4254 }; // Skopje

// --- ISS from cached CelesTrak elements vs. wheretheiss.at ---
const cache = JSON.parse(fs.readFileSync("data/cache/celestrak-stations.json", "utf8"));
const iss = cache.data.find((s) => s.norad === 25544);
const rec = S.twoline2satrec(iss.l1, iss.l2);
const now = new Date();
const pv = S.propagate(rec, now);
const gmst = S.gstime(now);
const gd = S.eciToGeodetic(pv.position, gmst);
const obsGd = { longitude: origin.lon * D2R, latitude: origin.lat * D2R, height: 0 };
const ecf = S.eciToEcf(pv.position, gmst);
const obsEcf = S.geodeticToEcf(obsGd);
const dist = Math.hypot(ecf.x - obsEcf.x, ecf.y - obsEcf.y, ecf.z - obsEcf.z);
const look = S.ecfToLookAngles(obsGd, ecf);
console.log("ISS (ours)      lat %s lon %s alt %s km | from Skopje %s km, az %s el %s, rangeSat %s",
  (gd.latitude * R2D).toFixed(3), (gd.longitude * R2D).toFixed(3), gd.height.toFixed(1),
  dist.toFixed(1), (look.azimuth * R2D).toFixed(1), (look.elevation * R2D).toFixed(1), look.rangeSat.toFixed(1));
try {
  const r = await fetch("https://api.wheretheiss.at/v1/satellites/25544", { signal: AbortSignal.timeout(15000) });
  const w = await r.json();
  console.log("ISS (reference) lat %s lon %s alt %s km  (wheretheiss.at, %s s apart)",
    w.latitude.toFixed(3), w.longitude.toFixed(3), w.altitude.toFixed(1), Math.round(Math.abs(w.timestamp * 1000 - now.getTime()) / 1000));
} catch (e) {
  console.log("ISS reference unavailable:", e.message);
}

// --- Moon geocentric distance vs. Horizons (368,542 km at 2026-09-06 00:00 TDB) ---
const t = A.MakeTime(new Date(Date.UTC(2026, 8, 5, 23, 58, 51))); // 00:00 TDB ≈ 23:58:51 UTC
const moon = A.GeoVector(A.Body.Moon, t, true);
console.log("Moon geocentric distance 2026-09-06 00:00 TDB: %s km (Horizons: 368,542 km)", (moon.Length() * KM_PER_AU).toFixed(0));

// --- Topocentric vs geocentric sanity: difference must be below one Earth radius ---
const obs = new A.Observer(origin.lat, origin.lon, 0);
const eq = A.Equator(A.Body.Moon, t, obs, true, true);
console.log("Moon topocentric from Skopje: %s km (difference from geocentric %s km, must be < 6,378)",
  (eq.dist * KM_PER_AU).toFixed(0), Math.abs(eq.dist * KM_PER_AU - moon.Length() * KM_PER_AU).toFixed(0));

// --- Observer vector + Horizons-style vector maths: Sun via both routes must agree ---
const sunGeo = A.GeoVector(A.Body.Sun, t, true);
const ov = A.ObserverVector(t, obs, false);
const viaVectors = Math.hypot(sunGeo.x - ov.x, sunGeo.y - ov.y, sunGeo.z - ov.z) * KM_PER_AU;
const viaEquator = A.Equator(A.Body.Sun, t, obs, true, true).dist * KM_PER_AU;
console.log("Sun topocentric via vectors %s km vs via Equator() %s km (diff %s km)",
  viaVectors.toFixed(0), viaEquator.toFixed(0), Math.abs(viaVectors - viaEquator).toFixed(0));

// --- Haversine check: Skopje -> Sydney (published ~15,720 km) ---
const R = 6371.0088;
const hav = (a, b, c, d) => { const p1 = a * D2R, p2 = c * D2R, dp = (c - a) * D2R, dl = (d - b) * D2R; const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
console.log("Skopje -> Sydney great circle: %s km (expected ~15,700)", hav(origin.lat, origin.lon, -33.8688, 151.2093).toFixed(0));
