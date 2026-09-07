import { memo, useId, useMemo, useState } from "react";
import type { Target } from "../types";
import { norm } from "../lib/search";

/** Anything with a name, a position and a search key can be an origin suggestion; Targets qualify directly. */
export type SearchEntry = Pick<Target, "name" | "subtitle" | "note" | "category" | "lat" | "lon" | "key">;

/** Secondary line for a suggestion: the country for places, the town for airports. */
export function subOf(e: SearchEntry): string {
  if (e.category === "airport" && e.note) return e.note.split(" · ")[0];
  return (e.subtitle ?? "").replace(/^Capital of /, "");
}

interface Props {
  index: SearchEntry[]; // sorted by importance (population first)
  onPick: (e: SearchEntry) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

/** Type-ahead over the place index with keyboard navigation. Shared by the header and the welcome dialog. */
export default memo(function PlaceSearch({ index, onPick, placeholder = "Search a city, landmark or place…", autoFocus = false, className = "" }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const listId = useId();

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
    onPick(e);
    setQ("");
    setOpen(false);
  };

  return (
    <div className={`place-search ${className}`}>
      <input
        type="search"
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoFocus={autoFocus}
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
        <ul className="suggest" role="listbox" id={listId}>
          {results.map((r, i) => (
            <li key={`${r.name}-${r.lat}-${r.lon}`} role="option" aria-selected={i === hi} className={i === hi ? "active" : ""} onMouseDown={() => pick(r)} onMouseEnter={() => setHi(i)}>
              <span>{r.name}</span>
              <span className="muted">{subOf(r)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && q.trim().length >= 2 && results.length === 0 && index.length > 0 && <div className="suggest suggest-empty muted">No place matches “{q.trim()}”.</div>}
    </div>
  );
});
