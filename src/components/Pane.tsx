import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

interface Props {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  /** Collapsed form is a narrow vertical strip (for the table column) instead of a header bar. */
  vertical?: boolean;
}

/** A titled panel that can be minimised to its header and expanded to full screen (Esc exits). */
export default function Pane({ title, actions, children, className = "", style, collapsed = false, onCollapse, vertical = false }: Props) {
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  if (collapsed) {
    return (
      <section className={`pane collapsed${vertical ? " vertical" : ""} ${className}`} style={style}>
        <header className="pane-head">
          <button type="button" className="icon-btn expand" onClick={() => onCollapse?.(false)} title={`Show the ${title.toLowerCase()} panel`} aria-label={`Show ${title}`}>
            {vertical ? "▸" : "▾"}
          </button>
          <span className="pane-title">{title}</span>
        </header>
      </section>
    );
  }

  return (
    <section className={`pane ${className}${full ? " fullscreen" : ""}`} style={full ? undefined : style}>
      <header className="pane-head">
        <span className="pane-title">{title}</span>
        <div className="pane-actions">
          {actions}
          {onCollapse && (
            <button type="button" className="icon-btn" onClick={() => onCollapse(true)} title="Minimise this panel" aria-label={`Minimise ${title}`}>
              –
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => setFull((f) => !f)} title={full ? "Exit full screen (Esc)" : "Full screen"}>
            {full ? "✕ Exit" : "⛶"}
          </button>
        </div>
      </header>
      <div className="pane-body">{children}</div>
    </section>
  );
}
