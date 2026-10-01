// Live ships (AIS via the server's AISStream subscription) and trains (open national feeds),
// polled every few seconds and dead-reckoned between polls like the aircraft.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Origin, Target } from "../types";
import { destinationPoint, haversineKm } from "../lib/geo";
import { KM_PER_NM } from "../lib/units";
import { norm } from "../lib/search";

export interface VehicleState {
  status: "idle" | "loading" | "ready" | "error" | "unconfigured";
  count: number;
  fetchedAt?: number;
  error?: string;
  note?: string; // e.g. which providers answered
}

interface Ship {
  mmsi: number;
  name: string;
  lat: number;
  lon: number;
  sogKn: number | null;
  cog: number | null;
  heading: number | null;
  status: string;
  type: string;
  dest: string;
  ts: number;
}

interface Train {
  id: string;
  name: string;
  operator: string;
  country: string;
  route: string;
  dest: string;
  lat: number;
  lon: number;
  speedKmh: number | null;
  heading: number | null;
  ts: number;
}

interface ShipsSample {
  configured: boolean;
  connected: boolean;
  fetchedAt: number;
  error?: string;
  ships: Ship[];
}

interface TrainsSample {
  fetchedAt: number;
  providers: { id: string; label: string; count: number; error?: string }[];
  trains: Train[];
}

const SHIP_POLL_MS = 15_000;
const TRAIN_POLL_MS = 30_000;
export const SHIP_RADIUS_KM = 500;

function usePoll<T>(url: string | null, intervalMs: number, onSample: (s: T) => void, onError: (msg: string) => void, onStart: () => void): void {
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const r = await fetch(url);
        const j = (await r.json()) as T & { error?: string };
        if (cancelled) return;
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        onSample(j);
      } catch (e) {
        if (!cancelled) onError((e as Error).message);
      }
      if (!cancelled) timer = window.setTimeout(poll, intervalMs);
    };
    onStart();
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs]);
}

const ageText = (sec: number): string => (sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);

export function useVehicles(now: number, origin: Origin, wantShips: boolean, wantTrains: boolean): { ships: Target[]; trains: Target[]; shipState: VehicleState; trainState: VehicleState } {
  const [shipSample, setShipSample] = useState<ShipsSample | null>(null);
  const [trainSample, setTrainSample] = useState<TrainsSample | null>(null);
  const [shipState, setShipState] = useState<VehicleState>({ status: "idle", count: 0 });
  const [trainState, setTrainState] = useState<VehicleState>({ status: "idle", count: 0 });
  const prev = useRef(new Map<string, { d: number; t: number }>());
  const olat = Math.round(origin.lat * 10) / 10;
  const olon = Math.round(origin.lon * 10) / 10;

  usePoll<ShipsSample>(
    wantShips ? `/api/ships?lat=${olat}&lon=${olon}&km=${SHIP_RADIUS_KM}` : null,
    SHIP_POLL_MS,
    (s) => {
      setShipSample(s);
      if (!s.configured) setShipState({ status: "unconfigured", count: 0, note: "add an AISStream key to the server to see ships" });
      else setShipState({ status: "ready", count: s.ships.length, fetchedAt: s.fetchedAt, error: s.error, note: s.connected ? "live" : "connecting…" });
    },
    (msg) => setShipState((st) => ({ ...st, status: "error", error: msg })),
    () => setShipState((st) => ({ ...st, status: "loading" })),
  );
  usePoll<TrainsSample>(
    wantTrains ? `/api/trains?lat=${olat}&lon=${olon}` : null,
    TRAIN_POLL_MS,
    (s) => {
      setTrainSample(s);
      const failed = s.providers.filter((p) => p.error);
      setTrainState({
        status: "ready",
        count: s.trains.length,
        fetchedAt: s.fetchedAt,
        error: failed.length ? failed.map((p) => `${p.label}: ${p.error}`).join("; ") : undefined,
        note: s.providers.map((p) => `${p.label.replace(/ \(.*\)$/, "")} ${p.count}`).join(" · "),
      });
    },
    (msg) => setTrainState((st) => ({ ...st, status: "error", error: msg })),
    () => setTrainState((st) => ({ ...st, status: "loading" })),
  );
  useEffect(() => {
    if (!wantShips) setShipState({ status: "idle", count: 0 });
  }, [wantShips]);
  useEffect(() => {
    if (!wantTrains) setTrainState({ status: "idle", count: 0 });
  }, [wantTrains]);

  const rateOf = (id: string, d: number): number | undefined => {
    const p = prev.current.get(id);
    prev.current.set(id, { d, t: now });
    return p && now > p.t ? (d - p.d) / ((now - p.t) / 1000) : undefined;
  };

  const ships = useMemo(() => {
    if (!wantShips || !shipSample) return [];
    const out: Target[] = [];
    for (const s of shipSample.ships) {
      const dt = Math.max(0, Math.min(900, (now - s.ts) / 1000));
      let { lat, lon } = s;
      const kmh = s.sogKn ? s.sogKn * KM_PER_NM : 0;
      if (kmh > 0.5 && s.cog !== null) {
        const moved = destinationPoint(lat, lon, s.cog, (kmh / 3600) * dt);
        lat = moved.lat;
        lon = moved.lon;
      }
      const d = haversineKm(origin.lat, origin.lon, lat, lon);
      const id = `ship-${s.mmsi}`;
      out.push({
        id,
        name: s.name,
        category: "ship",
        subtitle: `${s.type}${s.dest ? ` · to ${s.dest}` : ""}`,
        key: norm(`${s.name} ${s.type} ${s.dest} ship vessel`),
        distanceKm: d,
        rateKms: rateOf(id, d),
        lat,
        lon,
        heading: s.heading ?? s.cog ?? undefined,
        speedKms: s.sogKn !== null ? kmh / 3600 : undefined,
        speedRef: "the ground",
        kind: "ship",
        note: `${s.sogKn !== null ? `${s.sogKn.toFixed(1)} kn` : "speed unknown"}${s.status ? ` · ${s.status}` : ""}`,
        facts: [
          ["MMSI", String(s.mmsi)],
          ["Vessel type", s.type],
          ["Destination", s.dest || "not reported"],
          ["Speed", s.sogKn !== null ? `${s.sogKn.toFixed(1)} kn (${Math.round(kmh)} km/h)` : "unknown"],
          ["Course", s.cog !== null ? `${Math.round(s.cog)}°` : "unknown"],
          ["Status", s.status || "unknown"],
          ["Position age", `${ageText(dt)} (dead-reckoned)`],
          ["Source", "AIS via AISStream.io"],
        ],
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, shipSample, origin.lat, origin.lon, wantShips]);

  const trains = useMemo(() => {
    if (!wantTrains || !trainSample) return [];
    const out: Target[] = [];
    for (const t of trainSample.trains) {
      const dt = Math.max(0, Math.min(600, (now - t.ts) / 1000));
      let { lat, lon } = t;
      if (t.speedKmh && t.speedKmh > 2 && t.heading !== null) {
        const moved = destinationPoint(lat, lon, t.heading, (t.speedKmh / 3600) * dt);
        lat = moved.lat;
        lon = moved.lon;
      }
      const d = haversineKm(origin.lat, origin.lon, lat, lon);
      const id = `train-${t.id}`;
      out.push({
        id,
        name: t.name,
        category: "train",
        subtitle: `${t.operator} · ${t.country}`,
        key: norm(`${t.name} ${t.operator} ${t.route} ${t.dest} ${t.country} train`),
        distanceKm: d,
        rateKms: rateOf(id, d),
        lat,
        lon,
        heading: t.heading ?? undefined,
        speedKms: t.speedKmh !== null ? t.speedKmh / 3600 : undefined,
        speedRef: "the ground",
        kind: "train",
        note: `${t.speedKmh !== null ? `${Math.round(t.speedKmh)} km/h` : "speed unknown"}${t.dest ? ` · to ${t.dest}` : ""}`,
        facts: [
          ["Operator", t.operator],
          ["Country", t.country],
          ["Route", t.route || "not reported"],
          ["Destination", t.dest || "not reported"],
          ["Speed", t.speedKmh !== null ? `${Math.round(t.speedKmh)} km/h` : "unknown"],
          ["Heading", t.heading !== null ? `${Math.round(t.heading)}°` : "unknown"],
          ["Position age", `${ageText(dt)}${t.heading !== null ? " (dead-reckoned)" : ""}`],
          ["Source", t.operator === "VR" ? "Digitraffic (Fintraffic)" : "Amtraker"],
        ],
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, trainSample, origin.lat, origin.lon, wantTrains]);

  return { ships, trains, shipState, trainState };
}
