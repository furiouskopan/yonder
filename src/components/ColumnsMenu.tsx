import Menu from "./Menu";
import { COLUMNS, type ColumnId } from "../hooks/usePrefs";

interface Props {
  columns: Record<ColumnId, boolean>;
  onChange: (columns: Record<ColumnId, boolean>) => void;
}

export default function ColumnsMenu({ columns, onChange }: Props) {
  return (
    <Menu label="Columns ▾" title="Show or hide table columns">
      <div className="menu-title">Columns</div>
      <div className="menu-hint">Name and distance are always shown.</div>
      {COLUMNS.map((c) => (
        <label key={c.id} className="menu-item">
          <input type="checkbox" checked={columns[c.id]} onChange={(e) => onChange({ ...columns, [c.id]: e.target.checked })} /> {c.label}
        </label>
      ))}
      <div className="menu-sep" />
      <button type="button" className="menu-item" onClick={() => onChange(Object.fromEntries(COLUMNS.map((c) => [c.id, true])) as Record<ColumnId, boolean>)}>
        Show all
      </button>
    </Menu>
  );
}
