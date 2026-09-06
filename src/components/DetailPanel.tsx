import type { Origin, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { chordKm } from "../lib/geo";
import { KM_PER_LY, MI_PER_KM, formatDistance, formatKm, formatLightTime, formatRate, type Unit } from "../lib/units";
import type { SkyFn } from "../lib/sky";
import type { DescriptionState } from "../hooks/useDescription";
import { directionOf } from "./DistanceTable";

interface Props {
  target: Target;
  origin: Origin;
  unit: Unit;
  sky: SkyFn | null;
  description: DescriptionState;
  onClose: () => void;
  onSetOrigin: (lat: number, lon: number, name: string) => void;
}

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export default function DetailPanel({ target: t, origin, unit, sky, description, onClose, onSetOrigin }: Props) {
  const cat = CATEGORY_BY_ID[t.category];
  const dir = directionOf(t, origin, sky);
  const d = t.distanceKm;
  const facts: [string, string][] = [];

  if (Number.isFinite(d)) {
    facts.push(["Kilometres", formatKm(d)]);
    facts.push(["Miles", d * MI_PER_KM < 1 ? `${Math.round(d * MI_PER_KM * 5280)} ft` : `${nf0.format(Math.round(d * MI_PER_KM))} mi`]);
    if (d > 1e6) facts.push(["Astronomical units", formatDistance(d, "au")]);
    if (d / KM_PER_LY > 0.001) facts.push(["Light-years", formatDistance(d, "ly")]);
    facts.push(["Light travel time", formatLightTime(d)]);
  }
  if (dir.text) facts.push([cat.realm === "earth" ? "Compass bearing" : "Where to look", dir.text + (dir.cls === "up" ? " (above your horizon)" : dir.cls === "down" ? " (below the horizon)" : "")]);
  if (t.lat !== undefined && cat.realm === "earth" && d > 500) facts.push(["Straight line through Earth", formatDistance(chordKm(d), unit)]);
  if (t.rateKms !== undefined) facts.push(["Approach", formatRate(t.rateKms)]);
  if (t.speedKms !== undefined && Number.isFinite(t.speedKms)) facts.push(["Speed", `${t.speedKms.toFixed(2)} km/s`]);
  if (t.lat !== undefined && t.lon !== undefined) facts.push(["Coordinates", `${t.lat.toFixed(4)}°, ${t.lon.toFixed(4)}°`]);
  if (t.subLat !== undefined && t.subLon !== undefined) facts.push(["Currently above", `${t.subLat.toFixed(2)}°, ${t.subLon.toFixed(2)}°`]);
  if (t.heightKm !== undefined && t.category === "satellite") facts.push(["Height", `${nf0.format(Math.round(t.heightKm))} km`]);
  if (t.ra !== undefined && t.dec !== undefined) facts.push(["RA / Dec (J2000)", `${(t.ra / 15).toFixed(2)} h, ${t.dec.toFixed(2)}°`]);
  if (t.facts) facts.push(...t.facts);
  if (t.note && !t.facts?.some(([, v]) => v === t.note)) facts.push(["Notes", t.note]);

  const desc = description.id === t.id ? description : null;
  const wikiLang = desc?.data?.lang && desc.data.lang !== "en" ? ` (${desc.data.lang.toUpperCase()} Wikipedia)` : "";

  return (
    <div className="detail">
      <div className="detail-head">
        <span className="pill" style={{ ["--chip" as string]: cat.color }}>
          {cat.label}
        </span>
        <div className="detail-title">
          <h2>{t.name}</h2>
          {t.subtitle && <span className="muted">{t.subtitle}</span>}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="detail-distance">
        <strong>{formatDistance(d, unit)}</strong>
        <span className="muted">{Number.isFinite(d) ? `from ${origin.name}` : "position not available yet"}</span>
      </div>
      <div className="detail-body">
        <dl className="facts">
          {facts.map(([k, v], i) => (
            <div key={`${k}-${i}`}>
              <dt>{k}</dt>
              <dd>{v.startsWith("http") ? <a href={v} target="_blank" rel="noreferrer">{v.replace(/^https?:\/\//, "")}</a> : v}</dd>
            </div>
          ))}
        </dl>
        <div className="detail-desc">
          {desc?.status === "loading" && <p className="muted">Looking up a description…</p>}
          {desc?.status === "error" && <p className="muted">Description unavailable (is the server running?).</p>}
          {desc?.status === "none" && <p className="muted">{t.category === "aircraft" ? "Live flight data; no encyclopedia entry." : "No Wikipedia article found."}</p>}
          {desc?.status === "ready" && desc.data && (
            <>
              {desc.data.thumbnail && <img src={desc.data.thumbnail.source} alt="" />}
              <p>
                <strong>{desc.data.title}</strong>
                {desc.data.description && <span className="muted"> · {desc.data.description}</span>}
              </p>
              <p>{desc.data.extract}</p>
              {desc.data.url && (
                <a href={desc.data.url} target="_blank" rel="noreferrer">
                  Read on Wikipedia{wikiLang} ↗
                </a>
              )}
            </>
          )}
        </div>
      </div>
      {t.lat !== undefined && t.lon !== undefined && cat.realm === "earth" && (
        <div className="detail-actions">
          <button type="button" onClick={() => onSetOrigin(t.lat!, t.lon!, t.name)}>
            Set as origin
          </button>
        </div>
      )}
    </div>
  );
}
