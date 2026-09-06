import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import type { Origin, SortState, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { chordKm, compass, initialBearing } from "../lib/geo";
import { formatDistance, formatLightTime, formatRate, type Unit } from "../lib/units";
import { noteOf } from "../lib/target";
import type { SkyFn } from "../lib/sky";
import type { RowSource } from "../lib/merge";
import type { ColumnId } from "../hooks/usePrefs";

const ROW_H = 44;
const OVERSCAN = 8;

type Cols = Record<ColumnId, boolean>;

interface Props {
  rows: RowSource;
  unit: Unit;
  origin: Origin;
  sky: SkyFn | null;
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  sort: SortState;
  onSort: (s: SortState) => void;
  columns: Cols;
}

/** CSS grid template for the visible columns. Name and distance are always present. */
export function templateFor(c: Cols): string {
  const parts: string[] = [];
  if (c.rank) parts.push("44px");
  parts.push("minmax(160px, 2.2fr)");
  if (c.type) parts.push("120px");
  parts.push("minmax(120px, 1fr)");
  if (c.light) parts.push("90px");
  if (c.direction) parts.push("120px");
  if (c.approach) parts.push("100px");
  if (c.details) parts.push("minmax(140px, 2fr)");
  return parts.join(" ");
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
  columns: Cols;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  top: number;
}

const Row = memo(function Row({ t, i, unit, origin, sky, selected, hovered, columns, onSelect, onHover, top }: RowProps) {
  const cat = CATEGORY_BY_ID[t.category];
  const dir = columns.direction ? directionOf(t, origin, sky) : null;
  const rateCls = t.rateKms === undefined ? "" : t.rateKms < 0 ? "closer" : "farther";
  const chord = t.lat !== undefined && cat.realm === "earth" && t.distanceKm > 500 ? `straight line ${formatDistance(chordKm(t.distanceKm), unit)}` : "";
  const details = [noteOf(t), chord].filter(Boolean).join(" · ");
  return (
    <div
      className={`row${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
      style={{ top }}
      onClick={() => onSelect(selected ? null : t.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(selected ? null : t.id);
        }
      }}
      onMouseEnter={() => onHover(t.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(t.id)}
      role="row"
      aria-selected={selected}
      tabIndex={0}
      title={details}
    >
      {columns.rank && <span className="c-rank">{i + 1}</span>}
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
      {columns.type && (
        <span className="c-cat">
          <span className="pill" style={{ ["--chip" as string]: cat.color }}>
            {cat.label}
          </span>
        </span>
      )}
      <span className="c-dist num">{formatDistance(t.distanceKm, unit)}</span>
      {columns.light && <span className="c-light num muted">{formatLightTime(t.distanceKm)}</span>}
      {dir && <span className={`c-dir ${dir.cls}`}>{dir.text}</span>}
      {columns.approach && <span className={`c-rate num ${rateCls}`}>{formatRate(t.rateKms)}</span>}
      {columns.details && <span className="c-note muted">{details}</span>}
    </div>
  );
});

export default function DistanceTable({ rows, unit, origin, sky, selectedId, hoverId, onSelect, onHover, sort, onSort, columns }: Props) {
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
    const idx = rows.indexOf(selectedId);
    if (idx < 0) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2), behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, sort]);

  // Sort or filter changes can leave the scroll position past the end of a shorter list.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollTop > Math.max(0, rows.length * ROW_H - el.clientHeight)) el.scrollTop = 0;
  }, [rows.length]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const rendered: ReactElement[] = [];
  for (let i = start; i < end; i++) {
    const t = rows.at(i);
    rendered.push(
      <Row
        key={t.id}
        t={t}
        i={i}
        unit={unit}
        origin={origin}
        // Only sky-fixed objects need the per-second sky function; other rows can skip that re-render.
        sky={t.ra !== undefined ? sky : null}
        selected={t.id === selectedId}
        hovered={t.id === hoverId}
        columns={columns}
        onSelect={onSelect}
        onHover={onHover}
        top={i * ROW_H}
      />,
    );
  }

  const head = (key: SortState["key"], label: string, cls: string) => {
    const active = sort.key === key;
    return (
      <button
        type="button"
        className={`${cls} th${active ? " active" : ""}`}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        title={`Sort by ${label.toLowerCase()}`}
        onClick={() => onSort({ key, dir: active && sort.dir === "asc" ? "desc" : "asc" })}
      >
        {label}
        <span className="sort-mark">{active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
      </button>
    );
  };

  return (
    <div className="table" role="grid" aria-rowcount={rows.length} style={{ ["--cols" as string]: templateFor(columns) }}>
      <div className="thead" role="row">
        {columns.rank && <span className="c-rank">#</span>}
        {head("name", "Name", "c-name")}
        {columns.type && <span className="c-cat">Type</span>}
        {head("distance", "Distance", "c-dist")}
        {columns.light && <span className="c-light">Light time</span>}
        {columns.direction && <span className="c-dir">Direction</span>}
        {columns.approach && <span className="c-rate">Approach</span>}
        {columns.details && <span className="c-note">Details</span>}
      </div>
      <div className="tbody" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="tspacer" style={{ height: rows.length * ROW_H }}>
          {rendered}
        </div>
        {rows.length === 0 && <div className="empty">Nothing matches. Pick a category above or clear the filter.</div>}
      </div>
    </div>
  );
}
