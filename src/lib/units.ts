export const KM_PER_AU = 149_597_870.7;
export const KM_PER_LY = 9_460_730_472_580.8;
export const C_KM_S = 299_792.458;
export const MI_PER_KM = 0.621_371_192;
export const KM_PER_NM = 1.852;
export const KM_PER_FT = 0.000_304_8;

export type Unit = "auto" | "km" | "mi" | "au" | "ly" | "light";

export const UNITS: { id: Unit; label: string }[] = [
  { id: "auto", label: "Auto (km / AU / ly)" },
  { id: "km", label: "Kilometres" },
  { id: "mi", label: "Miles" },
  { id: "au", label: "Astronomical units" },
  { id: "ly", label: "Light-years" },
  { id: "light", label: "Light travel time" },
];

const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function sig(x: number, digits: number): string {
  if (x === 0) return "0";
  const abs = Math.abs(x);
  if (abs >= 1e15 || abs < 1e-4) return x.toExponential(Math.max(0, digits - 1));
  const intDigits = Math.floor(Math.log10(abs)) + 1;
  const frac = Math.max(0, digits - intDigits);
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: Math.min(frac, 6) }).format(x);
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 1e15) return `${nf0.format(Math.round(km))} km`;
  return `${km.toExponential(3)} km`;
}

export function formatDistance(km: number, unit: Unit): string {
  if (!Number.isFinite(km)) return "…";
  switch (unit) {
    case "km":
      return formatKm(km);
    case "mi": {
      const mi = km * MI_PER_KM;
      if (mi < 0.5) return `${Math.round(mi * 5280)} ft`;
      if (mi < 1e15) return `${nf0.format(Math.round(mi))} mi`;
      return `${mi.toExponential(3)} mi`;
    }
    case "au":
      return `${sig(km / KM_PER_AU, 4)} AU`;
    case "ly":
      return `${sig(km / KM_PER_LY, 4)} ly`;
    case "light":
      return formatLightTime(km);
    case "auto":
    default: {
      if (km < 2_000_000) return formatKm(km);
      const au = km / KM_PER_AU;
      if (au < 3000) return `${sig(au, 4)} AU`;
      return `${sig(km / KM_PER_LY, 4)} ly`;
    }
  }
}

export function formatLightTime(km: number): string {
  if (!Number.isFinite(km)) return "…";
  const s = km / C_KM_S;
  if (s < 1) return `${(s * 1000).toFixed(s * 1000 < 10 ? 2 : 1)} ms`;
  if (s < 60) return `${s.toFixed(2)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  const d = s / 86400;
  if (d < 365.25) return `${d.toFixed(1)} days`;
  const y = d / 365.25;
  if (y < 1000) return `${y.toFixed(2)} years`;
  return `${nf0.format(Math.round(y))} years`;
}

/** Rate of change of distance: negative means approaching. */
export function formatRate(kms: number | undefined): string {
  if (kms === undefined || !Number.isFinite(kms)) return "";
  const a = Math.abs(kms);
  if (a < 0.0005) return "steady";
  const sign = kms < 0 ? "−" : "+";
  if (a >= 1) return `${sign}${a.toFixed(2)} km/s`;
  return `${sign}${(a * 1000).toFixed(a * 1000 < 10 ? 1 : 0)} m/s`;
}

export function formatPopulation(pop: number): string {
  if (pop >= 1e9) return `${(pop / 1e9).toFixed(2)} bn`;
  if (pop >= 1e6) return `${(pop / 1e6).toFixed(pop < 1e7 ? 1 : 0)}M`;
  if (pop >= 1e3) return `${Math.round(pop / 1e3)}k`;
  return String(pop);
}

export function formatAltitudeFt(ft: number | null | undefined): string {
  if (ft === null || ft === undefined) return "unknown altitude";
  if (ft <= 0) return "on the ground";
  return `${nf0.format(Math.round(ft))} ft (${nf0.format(Math.round(ft * KM_PER_FT * 1000))} m)`;
}

export function formatPeriodDays(days: number): string {
  if (days < 2) return `${(days * 24).toFixed(1)} h`;
  if (days < 365.25 * 2) return `${days.toFixed(days < 20 ? 1 : 0)} days`;
  return `${(days / 365.25).toFixed(1)} years`;
}
