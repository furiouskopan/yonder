import type { Target } from "../types";
import { formatPopulation } from "./units";

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/**
 * The one-line note shown in the Details column and the detail panel.
 * Static tiers store a numeric `pop` rather than a formatted string (300k fewer strings in memory),
 * and satellites keep their per-second part (height, speed) out of the stored object.
 */
export function noteOf(t: Target): string | undefined {
  if (t.category === "satellite" && t.heightKm !== undefined && Number.isFinite(t.heightKm)) {
    const speed = t.speedKms !== undefined && Number.isFinite(t.speedKms) ? ` · ${t.speedKms.toFixed(2)} km/s` : "";
    return `${nf0.format(Math.round(t.heightKm))} km up${speed}${t.note ? ` · ${t.note}` : ""}`;
  }
  if (t.note !== undefined) return t.note;
  if (t.pop) return `pop. ${formatPopulation(t.pop)}`;
  return undefined;
}
