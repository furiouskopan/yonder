import { useEffect, useState, type ReactNode } from "react";

interface Props {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled panel with a full-screen toggle (Esc exits). */
export default function Pane({ title, actions, children, className = "" }: Props) {
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  return (
    <section className={`pane ${className}${full ? " fullscreen" : ""}`}>
      <header className="pane-head">
        <span className="pane-title">{title}</span>
        <div className="pane-actions">
          {actions}
          <button type="button" className="icon-btn" onClick={() => setFull((f) => !f)} title={full ? "Exit full screen (Esc)" : "Full screen"}>
            {full ? "✕ Exit" : "⛶"}
          </button>
        </div>
      </header>
      <div className="pane-body">{children}</div>
    </section>
  );
}
