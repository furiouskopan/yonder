import { memo, useEffect, useMemo, useState } from "react";
import type { Origin, Target } from "../types";
import { norm } from "../lib/search";

/** Anything with a name, a position and a search key can be an origin suggestion; Targets qualify directly. */
export type SearchEntry = Pick<Target, "name" | "subtitle" | "note" | "category" | "lat" | "lon" | "key">;

interface Props {
  origin: Origin;
  index: SearchEntry[]; // sorted by importance (population first)
  onChange: (lat: number, lon: number, name?: string) => void;
  pinOnClick: boolean;
  onPinToggle: (v: boolean) => void;
}

/** Secondary line for a suggestion: the country for places, the town for airports. */
function subOf(e: SearchEntry): string {
  if (e.category === "airport" && e.note) return e.note.split(" · ")[0];
  return (e.subtitle ?? "").replace(/^Capital of /, "");
}

export default memo(function OriginPanel({ origin, index, onChange, pinOnClick, onPinToggle }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [lat, setLat] = useState(origin.lat.toFixed(4));
  const [lon, setLon] = useState(origin.lon.toFixed(4));
  const [geoMsg, setGeoMsg] = useState<string | null>(null);

  useEffect(() => {
    setLat(origin.lat.toFixed(4));
    setLon(origin.lon.toFixed(4));
  }, [origin.lat, origin.lon]);

  const results = useMemo(() => {
    const s = norm(q.trim());
    if (s.length < 2) return [];
    const starts: SearchEntry[] = [];
    const contains: SearchEntry[] = [];
    for (const e of index) {
      const key = e.key ?? "";
      if (key.startsWith(s)) {
        starts.push(e);
        if (starts.length >= 8) break;
      } else if (contains.length < 8 && key.includes(s)) {
        contains.push(e);
      }
    }
    return [...starts, ...contains].slice(0, 8);
  }, [q, index]);

  const pick = (e: SearchEntry) => {
    if (e.lat === undefined || e.lon === undefined) return;
    const sub = subOf(e);
    onChange(e.lat, e.lon, sub ? `${e.name}, ${sub}` : e.name);
    setQ("");
    setOpen(false);
  };

  const applyCoords = () => {
    const a = Number(lat);
    const b = Number(lon);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) onChange(a, b);
  };

  const locate = () => {
    if (!navigator.geolocation) {
      setGeoMsg("Geolocation is not available in this browser");
      return;
    }
    setGeoMsg("Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoMsg(null);
        onChange(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => setGeoMsg(err.message),
      { enableHighAccuracy: true, timeout: 15000 },
    );
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
      <div className="origin-search">
        <input
          type="search"
          placeholder="Search a city, landmark or place…"
          aria-label="Search for an origin"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="origin-suggestions"
          aria-autocomplete="list"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setHi(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              setHi((h) => Math.min(results.length - 1, h + 1));
              e.preventDefault();
            } else if (e.key === "ArrowUp") {
              setHi((h) => Math.max(0, h - 1));
              e.preventDefault();
            } else if (e.key === "Enter" && results[hi]) {
              pick(results[hi]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {open && results.length > 0 && (
          <ul className="suggest" role="listbox" id="origin-suggestions">
            {results.map((r, i) => (
              <li key={`${r.name}-${r.lat}-${r.lon}`} role="option" aria-selected={i === hi} className={i === hi ? "active" : ""} onMouseDown={() => pick(r)} onMouseEnter={() => setHi(i)}>
                <span>{r.name}</span>
                <span className="muted">{subOf(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="origin-coords">
        <input aria-label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCoords()} />
        <input aria-label="Longitude" value={lon} onChange={(e) => setLon(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyCoords()} />
        <button type="button" onClick={applyCoords}>
          Set
        </button>
      </div>
      <button type="button" onClick={locate} title="Use the browser's location">
        📍 My location
      </button>
      <label className="check">
        <input type="checkbox" checked={pinOnClick} onChange={(e) => onPinToggle(e.target.checked)} /> Click map to move
      </label>
      {geoMsg && <span className="muted">{geoMsg}</span>}
    </div>
  );
});
