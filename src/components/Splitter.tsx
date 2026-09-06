import { useRef, type PointerEvent as ReactPointerEvent } from "react";

interface Props {
  direction: "col" | "row";
  /** Called with the fraction of the space between the two neighbouring panels given to the first one. */
  onChange: (fraction: number) => void;
  onReset?: () => void;
  min?: number;
  max?: number;
  label?: string;
}

/** A drag handle between two sibling panels. Works with the mouse, pen or touch; double-click resets. */
export default function Splitter({ direction, onChange, onReset, min = 0.2, max = 0.85, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    const prev = el?.previousElementSibling as HTMLElement | null;
    const next = el?.nextElementSibling as HTMLElement | null;
    if (!el || !prev || !next) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(direction === "col" ? "resizing-col" : "resizing-row");
    const move = (ev: PointerEvent) => {
      const a = prev.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      const f = direction === "col" ? (ev.clientX - a.left) / (b.right - a.left) : (ev.clientY - a.top) / (b.bottom - a.top);
      if (Number.isFinite(f)) onChange(Math.min(max, Math.max(min, f)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing-col", "resizing-row");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={ref}
      className={`splitter ${direction}`}
      role="separator"
      aria-orientation={direction === "col" ? "vertical" : "horizontal"}
      aria-label={label ?? "Resize panels"}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
    />
  );
}
