import type { Origin, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { chordKm, compass } from "../lib/geo";
import { KM_PER_LY, MI_PER_KM, formatDistance, formatKm, formatLightTime, formatRate, type Unit } from "../lib/units";
import type { SkyFn } from "../lib/sky";
import type { DescriptionState } from "../hooks/useDescription";
import { noteOf } from "../lib/target";
import { alwaysUp, formatClock, formatCountdown, formatDuration, type PassSet } from "../lib/passes";
import { directionOf } from "./DistanceTable";

interface Props {
  target: Target;
  origin: Origin;
  unit: Unit;
  sky: SkyFn | null;
  description: DescriptionState;
  /** Facts computed elsewhere (e.g. orbit elements) shown after the target's own facts. */
  extraFacts?: [string, string][];
  now: number;
  passes?: PassSet | null; // satellite passes over the origin, when the target is a satellite
  passesLoading?: boolean;
  onClose: () => void;
  onSetOrigin: (lat: number, lon: number, name: string) => void;
}

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function Passes({ t, set, loading, now }: { t: Target; set: PassSet | null | undefined; loading: boolean | undefined; now: number }) {
  if (!set || set.id !== t.id) return <p className="muted">{loading ? "Searching the next 24 hours for passes…" : "Pass times appear once the orbit is loaded."}</p>;
  if (alwaysUp(set)) {
    return (
      <p>
        Stays above your horizon all day (geostationary or a very high orbit){t.altDeg !== undefined && t.azDeg !== undefined ? `; look ${t.altDeg.toFixed(0)}° up toward ${compass(t.azDeg)}` : ""}.
      </p>
    );
  }
  const current = set.passes.find((p) => p.start - 20e3 <= now && now <= p.end + 20e3);
  const upcoming = set.passes.filter((p) => p.start > now).slice(0, 6);
  return (
    <>
      {current && (
        <p className="pass-now">
          <strong>Above your horizon now.</strong>{" "}
          {now < current.max ? `Peaks at ${current.maxEl.toFixed(0)}° toward ${compass(current.maxAz)} ${formatCountdown(current.max - now)}, then ` : "Past its highest point; "}
          sets toward {compass(current.endAz)} {formatCountdown(current.end - now)} ({formatClock(current.end)}).
        </p>
      )}
      {upcoming.length > 0 ? (
        <>
          <p>
            <strong>Next pass {formatCountdown(upcoming[0].start - now)}</strong> at {formatClock(upcoming[0].start)}: rises {compass(upcoming[0].startAz)}, peaks {upcoming[0].maxEl.toFixed(0)}° toward{" "}
            {compass(upcoming[0].maxAz)} at {formatClock(upcoming[0].max)}, sets {compass(upcoming[0].endAz)} at {formatClock(upcoming[0].end)} · {formatDuration(upcoming[0].end - upcoming[0].start)}.
          </p>
          {upcoming.length > 1 && (
            <table className="pass-table">
              <thead>
                <tr>
                  <th>Rises</th>
                  <th>Sets</th>
                  <th>Max</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.slice(1).map((p) => (
                  <tr key={p.start}>
                    <td>{formatClock(p.start)}</td>
                    <td>{formatClock(p.end)}</td>
                    <td>{p.maxEl.toFixed(0)}°</td>
                    <td>
                      {compass(p.startAz)} → {compass(p.endAz)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        !current && <p className="muted">Not above your horizon in the next {set.hours} hours from here.</p>
      )}
      <p className="muted pass-hint">Elevation above 0° from {`${set.origin}`}; passes below 10° are hard to see. Times are local.</p>
    </>
  );
}

export default function DetailPanel({ target: t, origin, unit, sky, description, extraFacts, now, passes, passesLoading, onClose, onSetOrigin }: Props) {
  const cat = CATEGORY_BY_ID[t.category];
  const dir = directionOf(t, origin, sky);
  const d = t.distanceKm;
  const facts: [string, string][] = [];

  if (Number.isFinite(d)) {
    facts.push(["Kilometres", formatKm(d)]);
    facts.push(["Miles", d * MI_PER_KM < 1 ? `${Math.round(d * MI_PER_KM * 5280)} ft` : `${nf0.format(Math.round(d * MI_PER_KM))} mi`]);
    if (d > 1e6) facts.push(["Astronomical units", formatDistance(d, "au")]);
    if (d / KM_PER_LY > 0.001) facts.push(["Light-years", formatDistance(d, "ly")]);
    facts.push([t.category === "probe" ? "One-way signal time (live)" : "Light travel time", formatLightTime(d)]);
  }
  if (dir.text) facts.push([cat.realm === "earth" ? "Compass bearing" : "Where to look", dir.text + (dir.cls === "up" ? " (above your horizon)" : dir.cls === "down" ? " (below the horizon)" : "")]);
  if (t.lat !== undefined && cat.realm === "earth" && d > 500) facts.push(["Straight line through Earth", formatDistance(chordKm(d), unit)]);
  if (t.rateKms !== undefined) facts.push(["Approach", formatRate(t.rateKms)]);
  if (t.speedKms !== undefined && Number.isFinite(t.speedKms)) facts.push(["Speed", t.speedKms < 0.5 ? `${Math.round(t.speedKms * 3600)} km/h` : `${t.speedKms.toFixed(2)} km/s`]);
  if (t.lat !== undefined && t.lon !== undefined) facts.push(["Coordinates", `${t.lat.toFixed(4)}°, ${t.lon.toFixed(4)}°`]);
  if (t.subLat !== undefined && t.subLon !== undefined) facts.push(["Currently above", `${t.subLat.toFixed(2)}°, ${t.subLon.toFixed(2)}°`]);
  if (t.heightKm !== undefined && t.category === "satellite") facts.push(["Height", `${nf0.format(Math.round(t.heightKm))} km`]);
  if (t.ra !== undefined && t.dec !== undefined) facts.push(["RA / Dec (J2000)", `${(t.ra / 15).toFixed(2)} h, ${t.dec.toFixed(2)}°`]);
  if (t.mag !== undefined && !t.facts?.some(([k]) => k === "Apparent magnitude")) facts.push(["Apparent magnitude", t.mag.toFixed(1)]);
  if (t.facts) facts.push(...t.facts);
  if (extraFacts) facts.push(...extraFacts);
  const note = noteOf(t);
  if (note && !t.facts?.some(([, v]) => v === note)) facts.push(["Notes", note]);

  const desc = description.id === t.id ? description : null;
  const wikiLang = desc?.data?.lang && desc.data.lang !== "en" ? ` (${desc.data.lang.toUpperCase()} Wikipedia)` : "";
  const liveOnly = t.category === "aircraft" || t.category === "ship" || t.category === "train";

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
          {t.category === "satellite" && (
            <div className="passes">
              <h3>Passes over {origin.name}</h3>
              <Passes t={t} set={passes} loading={passesLoading} now={now} />
            </div>
          )}
          {desc?.status === "loading" && <p className="muted">Looking up a description…</p>}
          {desc?.status === "error" && <p className="muted">Description unavailable (is the server running?).</p>}
          {desc?.status === "none" && <p className="muted">{liveOnly ? "Live tracking data; no encyclopedia entry." : "No Wikipedia article found."}</p>}
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
