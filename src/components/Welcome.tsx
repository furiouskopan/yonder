import { useCallback } from "react";
import PlaceSearch, { subOf, type SearchEntry } from "./PlaceSearch";
import { useGeolocate } from "../hooks/useGeolocate";
import { DEFAULT_ORIGIN } from "../hooks/usePrefs";

interface Props {
  index: SearchEntry[];
  ready: boolean; // the place index has loaded
  onChoose: (lat: number, lon: number, name?: string) => void;
  onPickOnMap: () => void;
  onDismiss: () => void;
}

/** First-run dialog: asks where to measure from before anything else is decided. */
export default function Welcome({ index, ready, onChoose, onPickOnMap, onDismiss }: Props) {
  const onFix = useCallback((lat: number, lon: number) => onChoose(lat, lon), [onChoose]);
  const geo = useGeolocate(onFix);
  const pick = (e: SearchEntry) => {
    const sub = subOf(e);
    onChoose(e.lat!, e.lon!, sub ? `${e.name}, ${sub}` : e.name);
  };
  return (
    <div className="welcome-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="welcome">
        <h2 id="welcome-title">Where are you?</h2>
        <p>
          Yonder shows the live distance from one spot on Earth to cities, aircraft, satellites, the planets, spacecraft and the stars. Everything is measured from the origin you choose here; you can move it any time.
        </p>
        <button type="button" className="welcome-primary" onClick={geo.locate} disabled={geo.busy}>
          📍 Use my location
        </button>
        {geo.message && <div className="muted welcome-msg">{geo.message}</div>}
        <div className="welcome-or">or search</div>
        <PlaceSearch index={index} onPick={pick} placeholder={ready ? "City, landmark or airport…" : "Loading places…"} autoFocus className="welcome-search" />
        <div className="welcome-row">
          <button type="button" onClick={onPickOnMap}>
            Pick a spot on the map
          </button>
          <button type="button" onClick={onDismiss} title={`${DEFAULT_ORIGIN.name} (0° longitude)`}>
            Start from Greenwich
          </button>
        </div>
        <ul className="welcome-tips muted">
          <li>Click a category chip to show only that category; Ctrl-click adds or removes one.</li>
          <li>The panels resize, minimise and reorder from the Layout menu. The Sky panel is a planetarium of what is above you right now.</li>
          <li>Towns, nearby places, live aircraft, ships and trains are off until you switch them on.</li>
        </ul>
      </div>
    </div>
  );
}
