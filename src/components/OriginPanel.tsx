import { memo, useCallback, useEffect, useState } from "react";
import type { Origin } from "../types";
import PlaceSearch, { subOf, type SearchEntry } from "./PlaceSearch";
import { useGeolocate } from "../hooks/useGeolocate";

export type { SearchEntry } from "./PlaceSearch";

interface Props {
  origin: Origin;
  index: SearchEntry[]; // sorted by importance (population first)
  onChange: (lat: number, lon: number, name?: string) => void;
  pinOnClick: boolean;
  onPinToggle: (v: boolean) => void;
}

export default memo(function OriginPanel({ origin, index, onChange, pinOnClick, onPinToggle }: Props) {
  const [lat, setLat] = useState(origin.lat.toFixed(4));
  const [lon, setLon] = useState(origin.lon.toFixed(4));
  const onFix = useCallback((a: number, b: number) => onChange(a, b), [onChange]);
  const geo = useGeolocate(onFix);

  useEffect(() => {
    setLat(origin.lat.toFixed(4));
    setLon(origin.lon.toFixed(4));
  }, [origin.lat, origin.lon]);

  const pick = (e: SearchEntry) => {
    const sub = subOf(e);
    onChange(e.lat!, e.lon!, sub ? `${e.name}, ${sub}` : e.name);
  };

  const applyCoords = () => {
    const a = Number(lat);
    const b = Number(lon);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) onChange(a, b);
  };

  return (
    <div className="origin">
      <div className="origin-current">
        <span className="label">From</span>
        <strong title={`${origin.lat}, ${origin.lon}`}>{origin.name}</strong>
        <span className="muted">
          {origin.lat.toFixed(4)}°, {origin.lon.toFixed(4)}°
        </span>
      </div>
      <PlaceSearch index={index} onPick={pick} className="origin-search" />
      <div className="origin-coords">
        <input aria-label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCoords()} />
        <input aria-label="Longitude" value={lon} onChange={(e) => setLon(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCoords()} />
        <button type="button" onClick={applyCoords}>
          Set
        </button>
      </div>
      <button type="button" onClick={geo.locate} disabled={geo.busy} title="Use the browser's location">
        📍 My location
      </button>
      <label className="check">
        <input type="checkbox" checked={pinOnClick} onChange={(e) => onPinToggle(e.target.checked)} /> Click map to move
      </label>
      {geo.message && <span className="muted">{geo.message}</span>}
    </div>
  );
});
