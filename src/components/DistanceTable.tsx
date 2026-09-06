import { memo, useEffect, useRef, useState } from "react";
import type { Origin, SortState, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { chordKm, compass, initialBearing } from "../lib/geo";
import { formatDistance, formatLightTime, formatRate, type Unit } from "../lib/units";
import type { SkyFn } from "../lib/sky";

const ROW_H = 44;
const OVERSCAN = 8;

interface Props {
  rows: Target[];
  unit: Unit;
  origin: Origin;
  sky: SkyFn | null;
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  sort: SortState;
  onSort: (s: SortState) => void;
}

export function directionOf(t: Target, origin: Origin, sky: SkyFn | null): { text: string; cls: string } {
  if (t.altDeg !== undefined && t.azDeg !== undefined) {
    const up = t.altDeg >= 0;
    return { text: `${up ? "↑" : "↓"} ${t.altDeg.toFixed(0)}° · ${compass(t.azDeg)}`, cls: up ? "up" : "down" };
  }
  if (t.lat !== undefined && t.lon !== undefined) {
    const b = initialBearing(origin.lat, origin.lon, t.lat, t.lon);
    return { text: `${compass(b)} ${Math.round(b) % 360}°`, cls: "" };
  }
  if (t.ra !== undefined && t.dec !== undefined && sky) {
    const { alt, az } = sky(t.ra, t.dec);
    const up = alt >= 0;
    return { text: `${up ? "↑" : "↓"} ${alt.toFixed(0)}° · ${compass(az)}`, cls: up ? "up" : "down" };
  }
  return { text: "", cls: "" };
}

interface RowProps {
  t: Target;
  i: number;
  unit: Unit;
  origin: Origin;
  sky: SkyFn | null;
  selected: boolean;
  hovered: boolean;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  top: number;
}

const Row = memo(function Row({ t, i, unit, origin, sky, selected, hovered, onSelect, onHover, top }: RowProps) {
  const cat = CATEGORY_BY_ID[t.category];
  const dir = directionOf(t, origin, sky);
  const rateCls = t.rateKms === undefined ? "" : t.rateKms < 0 ? "closer" : "farther";
  const chord = t.lat !== undefined && cat.realm === "earth" && t.distanceKm > 500 ? `straight line ${formatDistance(chordKm(t.distanceKm), unit)}` : "";
  const details = [t.note, chord].filter(Boolean).join(" · ");
  return (
    <div
      className={`row${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
      style={{ top }}
      onClick={() => onSelect(selected ? null : t.id)}
      onMouseEnter={() => onHover(t.id)}
      onMouseLeave={() => onHover(null)}
      role="row"
      title={details}
    >
      <span className="c-rank">{i + 1}</span>
      <span className="c-name">
        <span className="name">
          {t.name}
          {t.approx && (
            <span className="approx" title="Approximate">
              ≈
            </span>
          )}
        </span>
        {t.subtitle && <span className="sub">{t.subtitle}</span>}
      </span>
      <span className="c-cat">
        <span className="pill" style={{ ["--chip" as string]: cat.color }}>
          {cat.label}
        </span>
      </span>
      <span className="c-dist num">{formatDistance(t.distanceKm, unit)}</span>
      <span className="c-light num muted">{formatLightTime(t.distanceKm)}</span>
      <span className={`c-dir ${dir.cls}`}>{dir.text}</span>
      <span className={`c-rate num ${rateCls}`}>{formatRate(t.rateKms)}</span>
      <span className="c-note muted">{details}</span>
    </div>
  );
});

export default function DistanceTable({ rows, unit, origin, sky, selectedId, hoverId, onSelect, onHover, sort, onSort }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row in view when it is selected from the map or the globe.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !selectedId) return;
    const idx = rows.findIndex((r) => r.id === selectedId);
    if (idx < 0) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2), behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  const head = (key: SortState["key"], label: string, cls: string) => {
    const active = sort.key === key;
    return (
      <button type="button" className={`${cls} th${active ? " active" : ""}`} onClick={() => onSort({ key, dir: active && sort.dir === "asc" ? "desc" : "asc" })}>
        {label}
        {active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    );
  };

  return (
    <div className="table">
      <div className="thead" role="row">
        <span className="c-rank">#</span>
        {head("name", "Name", "c-name")}
        <span className="c-cat">Type</span>
        {head("distance", "Distance", "c-dist")}
        <span className="c-light">Light time</span>
        <span className="c-dir">Direction</span>
        <span className="c-rate">Approach</span>
        <span className="c-note">Details</span>
      </div>
      <div className="tbody" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="tspacer" style={{ height: rows.length * ROW_H }}>
          {rows.slice(start, end).map((t, k) => (
            <Row
              key={t.id}
              t={t}
              i={start + k}
              unit={unit}
              origin={origin}
              sky={sky}
              selected={t.id === selectedId}
              hovered={t.id === hoverId}
              onSelect={onSelect}
              onHover={onHover}
              top={(start + k) * ROW_H}
            />
          ))}
        </div>
        {rows.length === 0 && <div className="empty">Nothing matches. Pick a category above or clear the filter.</div>}
      </div>
    </div>
  );
}
