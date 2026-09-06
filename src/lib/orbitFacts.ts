import type { OrbitInfo } from "./orbits";
import { formatPeriodDays } from "./units";

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Human-readable orbit facts for the detail panel, from the Horizons elements or trajectory. */
export function orbitFacts(o: OrbitInfo | undefined): [string, string][] {
  if (!o || o.status !== "ok") return [];
  if (o.elements) {
    const e = o.elements;
    const out: [string, string][] = [];
    out.push(["Orbit", e.e < 1 ? `ellipse, eccentricity ${e.e.toFixed(3)}` : e.e === 1 ? "parabola (escaping)" : `hyperbola, eccentricity ${e.e.toFixed(3)} (unbound, leaving the Solar System)`]);
    out.push(["Perihelion", `${e.q.toFixed(3)} AU`]);
    if (e.a !== null && e.e < 1) {
      out.push(["Aphelion", `${(e.a * (1 + e.e)).toFixed(3)} AU`]);
      out.push(["Semi-major axis", `${e.a.toFixed(3)} AU`]);
    }
    if (e.period !== null) out.push(["Orbital period", formatPeriodDays(e.period)]);
    out.push(["Inclination", `${e.i.toFixed(2)}° to the ecliptic`]);
    const tpMs = (e.tp - 2440587.5) * 86400e3;
    if (Number.isFinite(tpMs)) out.push([tpMs > Date.now() ? "Next perihelion" : "Last perihelion", day(tpMs)]);
    return out;
  }
  if (o.trail && o.trail.rows.length > 1) {
    const end = o.trail.t0 + o.trail.stepSec * 1000 * (o.trail.rows.length - 1);
    return [["Trajectory shown", `${day(o.trail.t0)} to ${day(end)}, one point every ${Math.round(o.trail.stepSec / 86400)} days`]];
  }
  return [];
}
