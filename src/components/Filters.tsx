import type { MouseEvent } from "react";
import type { Category } from "../types";
import { CATEGORIES } from "../types";
import { UNITS, type Unit } from "../lib/units";
import type { SatSetInfo, SatState } from "../hooks/useSatellites";

interface Props {
  cats: Record<Category, boolean>;
  counts: Record<Category, number>;
  onSolo: (c: Category) => void;
  onToggle: (c: Category) => void;
  onAll: () => void;
  search: string;
  onSearch: (s: string) => void;
  unit: Unit;
  onUnit: (u: Unit) => void;
  satSet: string;
  satSets: SatSetInfo[];
  onSatSet: (id: string) => void;
  satState: SatState;
  shown: number;
  total: number;
  loading: string[];
}

function age(ms: number | undefined): string {
  if (!ms) return "";
  const h = (Date.now() - ms) / 3600e3;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min old`;
  return `${h.toFixed(h < 10 ? 1 : 0)} h old`;
}

export default function Filters(p: Props) {
  const allOn = CATEGORIES.every((c) => p.cats[c.id]);
  const sat = p.satState;
  const satText =
    sat.status === "loading"
      ? "loading orbits…"
      : sat.status === "error"
        ? `satellites unavailable (${sat.error})`
        : sat.status === "ready"
          ? `${sat.count.toLocaleString()} satellites · elements ${age(sat.fetchedAt)}`
          : "";
  const click = (c: Category) => (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) p.onToggle(c);
    else p.onSolo(c);
  };

  return (
    <div className="filters">
      <div className="chips">
        <button type="button" className={`chip all${allOn ? " on" : ""}`} onClick={p.onAll} title="Show every category">
          All
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip${p.cats[c.id] ? " on" : ""}`}
            style={{ ["--chip" as string]: c.color }}
            aria-pressed={p.cats[c.id]}
            onClick={click(c.id)}
            title="Click: show only this category · Ctrl/Shift-click: add or remove it"
          >
            <span className="dot" />
            {c.label}
            <span className="count">{p.counts[c.id].toLocaleString()}</span>
          </button>
        ))}
      </div>
      <div className="controls">
        <input type="search" className="search" placeholder="Filter results…" value={p.search} onChange={(e) => p.onSearch(e.target.value)} />
        <label>
          Units
          <select value={p.unit} onChange={(e) => p.onUnit(e.target.value as Unit)}>
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Satellites
          <select value={p.satSet} onChange={(e) => p.onSatSet(e.target.value)}>
            {p.satSets.length === 0 && <option value={p.satSet}>{p.satSet}</option>}
            {p.satSets.map((s) => (
              <option key={s.id} value={s.id} title={s.description}>
                {s.label} (~{s.approx.toLocaleString()})
              </option>
            ))}
          </select>
        </label>
        <span className="muted sat-status">{satText}</span>
        {p.loading.length > 0 && <span className="muted sat-status">loading {p.loading.join(", ")}…</span>}
        <span className="muted shown">
          {p.shown.toLocaleString()} of {p.total.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
