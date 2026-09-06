import { memo, type MouseEvent } from "react";
import type { Category } from "../types";
import { CATEGORIES } from "../types";
import { UNITS, type Unit } from "../lib/units";
import type { SatSetInfo, SatState } from "../hooks/useSatellites";
import type { ThemePref } from "../hooks/usePrefs";

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
  live: boolean;
  onLive: (v: boolean) => void;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
}

function age(ms: number | undefined): string {
  if (!ms) return "";
  const h = (Date.now() - ms) / 3600e3;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min old`;
  return `${h.toFixed(h < 10 ? 1 : 0)} h old`;
}

export default memo(function Filters(p: Props) {
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
      <div className="chips" role="group" aria-label="Categories">
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
        <input type="search" className="search" placeholder="Filter results…" aria-label="Filter results" value={p.search} onChange={(e) => p.onSearch(e.target.value)} />
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
        <label>
          Theme
          <select value={p.theme} onChange={(e) => p.onTheme(e.target.value as ThemePref)} aria-label="Colour theme">
            <option value="auto">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <button
          type="button"
          className={`live${p.live ? " on" : ""}`}
          onClick={() => p.onLive(!p.live)}
          aria-pressed={p.live}
          title={p.live ? "Pause the once-a-second updates (also saves CPU)" : "Resume live updates"}
        >
          <span className="dot" />
          {p.live ? "Live" : "Paused"}
        </button>
        <span className="muted sat-status">{satText}</span>
        {p.loading.length > 0 && <span className="muted sat-status">loading {p.loading.join(", ")}…</span>}
        <span className="muted shown">
          {p.shown.toLocaleString()} of {p.total.toLocaleString()}
        </span>
      </div>
    </div>
  );
});
