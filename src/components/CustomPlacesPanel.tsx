import { memo, useState, type FormEvent } from "react";
import type { CustomPlace, Origin } from "../types";
import type { PlacesStatus } from "../hooks/useCustomPlaces";

interface Props {
  places: CustomPlace[];
  onAdd: (p: Omit<CustomPlace, "id">) => void;
  onRemove: (id: string) => void;
  status: PlacesStatus;
  error: string | null;
  origin: Origin;
}

export default memo(function CustomPlacesPanel({ places, onAdd, onRemove, status, error, origin }: Props) {
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [note, setNote] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = Number(lat);
    const b = Number(lon);
    if (!name.trim() || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return;
    onAdd({ name: name.trim(), lat: a, lon: b, note: note.trim() || undefined });
    setName("");
    setLat("");
    setLon("");
    setNote("");
  };

  return (
    <details className="places">
      <summary>
        My places <span className="count">{places.length}</span>
      </summary>
      <div className="places-body">
        <ul>
          {places.map((p) => (
            <li key={p.id}>
              <span>
                <strong>{p.name}</strong>{" "}
                <span className="muted">
                  {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                </span>
                {p.note && <span className="muted"> · {p.note}</span>}
              </span>
              <button type="button" onClick={() => onRemove(p.id)} title="Remove">
                ✕
              </button>
            </li>
          ))}
          {places.length === 0 && <li className="muted">No places yet. Add one below.</li>}
        </ul>
        <form onSubmit={submit}>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} required inputMode="decimal" />
          <input placeholder="Longitude" value={lon} onChange={(e) => setLon(e.target.value)} required inputMode="decimal" />
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            type="button"
            onClick={() => {
              setLat(origin.lat.toFixed(4));
              setLon(origin.lon.toFixed(4));
            }}
            title="Fill in the current origin coordinates"
          >
            Use origin
          </button>
          <button type="submit">Add</button>
        </form>
        <p className="muted">
          {status === "server"
            ? "Saved to data/custom-places.json in the project folder."
            : status === "local"
              ? "Server not reachable: places are saved in this browser only."
              : "Loading…"}
          {error && ` · ${error}`}
        </p>
      </div>
    </details>
  );
});
