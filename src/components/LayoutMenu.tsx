import Menu from "./Menu";
import { DEFAULT_LAYOUT, SIDE_PANES, type LayoutPrefs, type PaneId, type SidePane } from "../hooks/usePrefs";

interface Props {
  layout: LayoutPrefs;
  onChange: (patch: Partial<LayoutPrefs>) => void;
  onCollapse: (id: PaneId, collapsed: boolean) => void;
}

const labelOf = (id: SidePane): string => SIDE_PANES.find((p) => p.id === id)?.label ?? id;

export default function LayoutMenu({ layout, onChange, onCollapse }: Props) {
  const move = (id: SidePane, dir: -1 | 1) => {
    const order = layout.order.slice();
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    onChange({ order });
  };
  return (
    <Menu label="Layout ▾" title="Show, hide and arrange the panels">
      <div className="menu-title">Panels</div>
      <label className="menu-item">
        <input type="checkbox" checked={!layout.collapsed.table} onChange={(e) => onCollapse("table", !e.target.checked)} /> Distances table
      </label>
      {layout.order.map((id, i) => (
        <div key={id} className="menu-item menu-order">
          <label>
            <input type="checkbox" checked={!layout.collapsed[id]} onChange={(e) => onCollapse(id, !e.target.checked)} /> {labelOf(id)}
          </label>
          <span className="menu-order-btns">
            <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(id, -1)} title="Move up" aria-label={`Move ${labelOf(id)} up`}>
              ↑
            </button>
            <button type="button" className="icon-btn" disabled={i === layout.order.length - 1} onClick={() => move(id, 1)} title="Move down" aria-label={`Move ${labelOf(id)} down`}>
              ↓
            </button>
          </span>
        </div>
      ))}
      <div className="menu-sep" />
      <button type="button" className="menu-item" onClick={() => onChange({ ...DEFAULT_LAYOUT, collapsed: { ...DEFAULT_LAYOUT.collapsed }, weights: { ...DEFAULT_LAYOUT.weights }, order: DEFAULT_LAYOUT.order.slice() })}>
        Reset layout
      </button>
      <div className="menu-hint">Drag the bars between panels to resize them; double-click a bar to reset it.</div>
    </Menu>
  );
}
