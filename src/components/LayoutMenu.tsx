import Menu from "./Menu";
import { DEFAULT_LAYOUT, type LayoutPrefs, type PaneId } from "../hooks/usePrefs";

interface Props {
  layout: LayoutPrefs;
  onChange: (patch: Partial<LayoutPrefs>) => void;
  onCollapse: (id: PaneId, collapsed: boolean) => void;
}

const PANES: { id: PaneId; label: string }[] = [
  { id: "table", label: "Distances table" },
  { id: "map", label: "Map / globe" },
  { id: "solar", label: "Solar system" },
];

export default function LayoutMenu({ layout, onChange, onCollapse }: Props) {
  return (
    <Menu label="Layout ▾" title="Show, hide and arrange the panels">
      <div className="menu-title">Panels</div>
      {PANES.map((p) => (
        <label key={p.id} className="menu-item">
          <input type="checkbox" checked={!layout.collapsed[p.id]} onChange={(e) => onCollapse(p.id, !e.target.checked)} /> {p.label}
        </label>
      ))}
      <label className="menu-item">
        <input type="checkbox" checked={layout.solarFirst} onChange={(e) => onChange({ solarFirst: e.target.checked })} /> Solar system above the map
      </label>
      <div className="menu-sep" />
      <button type="button" className="menu-item" onClick={() => onChange({ ...DEFAULT_LAYOUT, collapsed: { ...DEFAULT_LAYOUT.collapsed } })}>
        Reset layout
      </button>
      <div className="menu-hint">Drag the bars between panels to resize them; double-click a bar to reset it.</div>
    </Menu>
  );
}
