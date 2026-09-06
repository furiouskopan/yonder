import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
  title?: string;
}

/** A button that opens a small popover; closes on outside click or Escape. */
export default function Menu({ label, children, className = "", align = "right", title }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu ${className}`} ref={ref}>
      <button type="button" className={`icon-btn${open ? " on" : ""}`} aria-haspopup="true" aria-expanded={open} title={title} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <div className={`menu-pop ${align}`} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}
