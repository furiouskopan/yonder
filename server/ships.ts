// Live ship positions (AIS) from AISStream.io over a WebSocket. Needs a free API key from
// https://aisstream.io: put it in the AISSTREAM_KEY environment variable or in data/keys.json as
// { "aisstream": "..." }. One subscription covers a box around the current origin; the socket is
// only kept open while the browser keeps asking, and the last-known position of every ship seen
// is served from memory.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./cache";
import { haversine } from "./geoutil";

export interface Ship {
  mmsi: number;
  name: string;
  lat: number;
  lon: number;
  sogKn: number | null; // speed over ground, knots
  cog: number | null; // course over ground, degrees
  heading: number | null;
  status: string;
  type: string;
  dest: string;
  ts: number; // ms since epoch of the last position
}

export interface ShipsResponse {
  configured: boolean;
  connected: boolean;
  fetchedAt: number;
  radiusKm: number;
  count: number;
  error?: string;
  ships: Ship[];
}

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (ev: { data?: unknown; message?: string }) => void): void;
}

interface Meta {
  MMSI?: number;
  ShipName?: string;
  latitude?: number;
  longitude?: number;
  time_utc?: string;
}
interface PositionReport {
  Cog?: number;
  Sog?: number;
  TrueHeading?: number;
  NavigationalStatus?: number;
  Latitude?: number;
  Longitude?: number;
}
interface StaticData {
  Destination?: string;
  Type?: number;
  Name?: string;
}
interface AisMessage {
  MessageType?: string;
  MetaData?: Meta;
  Message?: { PositionReport?: PositionReport; ShipStaticData?: StaticData };
}

const BOX_LAT = 3; // degrees around the origin subscribed to
const BOX_LON = 4.5;
const STALE_MS = 25 * 60e3; // forget ships not heard from in this long
const WANTED_MS = 3 * 60e3; // keep the socket while the browser polled within this window
const RECONNECT_MS = 10e3;

const NAV_STATUS: Record<number, string> = {
  0: "under way", 1: "at anchor", 2: "not under command", 3: "restricted manoeuvrability", 4: "constrained by draught", 5: "moored", 6: "aground", 7: "fishing", 8: "under sail",
};

function typeLabel(t: number | null): string {
  if (t === null) return "Vessel";
  if (t === 30) return "Fishing vessel";
  if (t === 31 || t === 32) return "Towing vessel";
  if (t === 33) return "Dredger";
  if (t === 35) return "Military vessel";
  if (t === 36) return "Sailing vessel";
  if (t === 37) return "Pleasure craft";
  if (t >= 40 && t <= 49) return "High-speed craft";
  if (t === 50) return "Pilot vessel";
  if (t === 51) return "Search and rescue vessel";
  if (t === 52) return "Tug";
  if (t === 55) return "Law-enforcement vessel";
  if (t >= 60 && t <= 69) return "Passenger ship";
  if (t >= 70 && t <= 79) return "Cargo ship";
  if (t >= 80 && t <= 89) return "Tanker";
  return "Vessel";
}

function apiKey(): string | null {
  if (process.env.AISSTREAM_KEY) return process.env.AISSTREAM_KEY;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "keys.json"), "utf-8")) as { aisstream?: string };
    return j.aisstream || null;
  } catch {
    return null;
  }
}

const ships = new Map<number, Ship>();
const statics = new Map<number, { type: number | null; dest: string; name: string }>();
let ws: WsLike | null = null;
let connected = false;
let centre: { lat: number; lon: number } | null = null;
let lastWanted = 0;
let lastError: string | undefined;
let reconnectTimer: NodeJS.Timeout | null = null;

function handle(raw: unknown): void {
  let m: AisMessage;
  try {
    m = JSON.parse(String(raw)) as AisMessage;
  } catch {
    return;
  }
  const meta = m.MetaData;
  if (!meta?.MMSI) return;
  const mmsi = meta.MMSI;
  if (m.MessageType === "ShipStaticData" && m.Message?.ShipStaticData) {
    const s = m.Message.ShipStaticData;
    statics.set(mmsi, { type: typeof s.Type === "number" ? s.Type : null, dest: (s.Destination ?? "").trim(), name: (s.Name ?? "").trim() });
    const ship = ships.get(mmsi);
    if (ship) {
      ship.type = typeLabel(typeof s.Type === "number" ? s.Type : null);
      ship.dest = (s.Destination ?? "").trim();
      if (!ship.name && s.Name) ship.name = s.Name.trim();
    }
    return;
  }
  const p = m.Message?.PositionReport;
  if (!p) return;
  const lat = typeof p.Latitude === "number" ? p.Latitude : meta.latitude;
  const lon = typeof p.Longitude === "number" ? p.Longitude : meta.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return;
  const st = statics.get(mmsi);
  const ts = meta.time_utc ? Date.parse(meta.time_utc.replace(" +0000 UTC", "Z").replace(" UTC", "Z")) : NaN;
  ships.set(mmsi, {
    mmsi,
    name: (meta.ShipName ?? st?.name ?? "").trim() || `MMSI ${mmsi}`,
    lat,
    lon,
    sogKn: typeof p.Sog === "number" && p.Sog < 102.3 ? p.Sog : null,
    cog: typeof p.Cog === "number" && p.Cog < 360 ? p.Cog : null,
    heading: typeof p.TrueHeading === "number" && p.TrueHeading < 360 ? p.TrueHeading : null,
    status: NAV_STATUS[p.NavigationalStatus ?? 15] ?? "",
    type: typeLabel(st?.type ?? null),
    dest: st?.dest ?? "",
    ts: Number.isFinite(ts) ? ts : Date.now(),
  });
}

function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  ws = null;
  connected = false;
}

function connect(key: string, lat: number, lon: number): void {
  disconnect();
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (!Ctor) {
    lastError = "this Node version has no WebSocket client (need Node 22+)";
    return;
  }
  centre = { lat, lon };
  const sock = new Ctor("wss://stream.aisstream.io/v0/stream");
  ws = sock;
  sock.addEventListener("open", () => {
    connected = true;
    lastError = undefined;
    const box = [
      [Math.max(-90, lat - BOX_LAT), Math.max(-180, lon - BOX_LON)],
      [Math.min(90, lat + BOX_LAT), Math.min(180, lon + BOX_LON)],
    ];
    sock.send(JSON.stringify({ APIKey: key, BoundingBoxes: [box], FilterMessageTypes: ["PositionReport", "ShipStaticData"] }));
    console.log(`[ships] subscribed around ${lat.toFixed(1)}, ${lon.toFixed(1)}`);
  });
  sock.addEventListener("message", (ev) => handle(ev.data));
  sock.addEventListener("error", (ev) => {
    lastError = ev.message ?? "socket error";
  });
  sock.addEventListener("close", () => {
    connected = false;
    if (ws !== sock) return;
    ws = null;
    if (Date.now() - lastWanted < WANTED_MS && centre) {
      reconnectTimer = setTimeout(() => centre && connect(key, centre.lat, centre.lon), RECONNECT_MS);
    }
  });
}

// Drop the socket when nobody has asked for ships in a while, and forget stale ships.
setInterval(() => {
  if (ws && Date.now() - lastWanted > WANTED_MS) {
    disconnect();
    console.log("[ships] idle, disconnected");
  }
  const cutoff = Date.now() - STALE_MS;
  for (const [k, s] of ships) if (s.ts < cutoff) ships.delete(k);
}, 60e3).unref();

export function getShips(lat: number, lon: number, radiusKm: number): ShipsResponse {
  lastWanted = Date.now();
  const key = apiKey();
  if (!key) return { configured: false, connected: false, fetchedAt: Date.now(), radiusKm, count: 0, ships: [] };
  if (!ws || !centre || Math.abs(centre.lat - lat) > 1.2 || Math.abs(centre.lon - lon) > 1.5) connect(key, lat, lon);
  const out: Ship[] = [];
  for (const s of ships.values()) if (haversine(lat, lon, s.lat, s.lon) <= radiusKm) out.push(s);
  return { configured: true, connected, fetchedAt: Date.now(), radiusKm, count: out.length, error: lastError, ships: out };
}
