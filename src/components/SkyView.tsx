// Planetarium: the hemisphere above the origin drawn on a canvas (zenith in the middle, horizon at
// the rim, north at the top, east on the left as when you look up). Stars come from the fixed
// catalogue via the fast SkyFrame maths; Sun, Moon, planets, spacecraft, satellites and aircraft use
// the look angles the rest of the app already computes each second.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as A from "astronomy-engine";
import type { Origin, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { SkyFrame } from "../lib/sky";
import { makeTime } from "../lib/astro";
import { formatDistance, type Unit } from "../lib/units";
import { compass } from "../lib/geo";
import type { SkyPrefs } from "../hooks/usePrefs";
import Menu from "./Menu";

interface Props {
  now: number;
  origin: Origin;
  fixed: Target[]; // stars, deep-sky objects, exoplanets (only rows with ra/dec are used)
  bodies: Target[]; // Sun, Moon, planets, Horizons bodies (altDeg/azDeg)
  sats: Target[];
  aircraft: Target[];
  selected: Target | null;
  hoverId: string | null;
  unit: Unit;
  dark: boolean;
  prefs: SkyPrefs;
  onPrefs: (patch: Partial<SkyPrefs>) => void;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

const D2R = Math.PI / 180;
const STAR_COLORS = ["#9bb0ff", "#cad7ff", "#f8f7ff", "#fff4ea", "#ffd2a1", "#ffcc6f", "#e5e7eb"]; // O/B, A, F, G, K, M, unknown
const PLANET_COLORS: Record<string, string> = {
  Mercury: "#c4c4c4", Venus: "#f5e6c8", Mars: "#f87171", Jupiter: "#e7c8a0", Saturn: "#f1e0b0", Uranus: "#9ad9ec", Neptune: "#818cf8", Pluto: "#c4b5fd",
};
const MOON_BRIGHT = "#e8e6df";
const MOON_DARK = "#3b3f4a";

interface StarIndex {
  idx: Int32Array; // indices into `fixed`
  ra: Float32Array; // radians
  sinDec: Float32Array;
  cosDec: Float32Array;
  size: Float32Array; // pixel radius
  color: Uint8Array; // STAR_COLORS index
}

interface Hit {
  x: number;
  y: number;
  r: number;
  id: string;
}

function spectralIndex(spect: string | undefined): number {
  const c = spect?.[0]?.toUpperCase();
  switch (c) {
    case "O":
    case "B":
      return 0;
    case "A":
      return 1;
    case "F":
      return 2;
    case "G":
      return 3;
    case "K":
      return 4;
    case "M":
      return 5;
    default:
      return 6;
  }
}

/** Stars, including curated multiple-star systems (Sirius, Procyon, Capella) that took over their catalogue rows. */
const isStar = (t: Target): boolean => t.kind === "Star" || (t.kind === "Star system" && t.mag !== undefined);

function buildStars(fixed: Target[], magLimit: number): StarIndex {
  const idx: number[] = [];
  for (let i = 0; i < fixed.length; i++) {
    const t = fixed[i];
    if (!isStar(t) || t.ra === undefined || t.dec === undefined || t.mag === undefined || t.mag > magLimit) continue;
    idx.push(i);
  }
  const n = idx.length;
  const out: StarIndex = { idx: Int32Array.from(idx), ra: new Float32Array(n), sinDec: new Float32Array(n), cosDec: new Float32Array(n), size: new Float32Array(n), color: new Uint8Array(n) };
  for (let k = 0; k < n; k++) {
    const t = fixed[idx[k]];
    out.ra[k] = t.ra! * D2R;
    out.sinDec[k] = Math.sin(t.dec! * D2R);
    out.cosDec[k] = Math.cos(t.dec! * D2R);
    out.size[k] = Math.max(0.55, Math.min(4.6, 0.5 + (magLimit + 0.8 - t.mag!) * 0.5));
    out.color[k] = spectralIndex(t.facts?.find(([k2]) => k2 === "Spectral type")?.[1]);
  }
  return out;
}

/** Deep-sky objects worth drawing: the curated list plus catalogue entries down to magnitude 8.5. */
function buildDeep(fixed: Target[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < fixed.length; i++) {
    const t = fixed[i];
    // Stars and multiple stars are drawn by the star pass (or, without a magnitude, not at all), never as diamonds.
    if (t.category !== "star" || t.kind === "Star" || t.kind === "Star system" || t.ra === undefined || t.dec === undefined) continue;
    if (t.id.startsWith("dso-") || (t.mag !== undefined && t.mag <= 8.5)) out.push(i);
  }
  return out;
}

const mix = (a: [number, number, number], b: [number, number, number], f: number): string => `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(a[2] + (b[2] - a[2]) * f)})`;
const smooth = (lo: number, hi: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

function skyWord(sunAlt: number): string {
  if (sunAlt > 0) return "daytime";
  if (sunAlt > -6) return "civil twilight";
  if (sunAlt > -12) return "nautical twilight";
  if (sunAlt > -18) return "astronomical twilight";
  return "night";
}

export default function SkyView({ now, origin, fixed, bodies, sats, aircraft, selected, hoverId, unit, dark, prefs, onPrefs, onSelect, onHover }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null); // hover and selection rings, redrawn on their own
  const hitsRef = useRef<Hit[]>([]);
  // The dome redraws once per clock tick from the latest data; satellites arrive from the worker in a commit of
  // their own and hover changes come from every pane, so neither should trigger a full redraw of the sky.
  const dataRef = useRef({ bodies, sats, aircraft });
  dataRef.current = { bodies, sats, aircraft };
  const markRef = useRef({ hoverId, selectedId: selected?.id ?? null });
  markRef.current = { hoverId, selectedId: selected?.id ?? null };
  const byIdRef = useRef(new Map<string, Target>());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; id: string } | null>(null);
  const propsRef = useRef({ onSelect, onHover });
  propsRef.current = { onSelect, onHover };

  const stars = useMemo(() => (prefs.stars ? buildStars(fixed, prefs.magLimit) : null), [fixed, prefs.stars, prefs.magLimit]);
  const deep = useMemo(() => (prefs.deep ? buildDeep(fixed) : []), [fixed, prefs.deep]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- drawing ----
  const drawOverlay = useCallback(() => {
    const c = overlayRef.current;
    if (!c || size.w === 0 || size.h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const mark = (id: string | null, color: string, r: number) => {
      if (!id) return;
      const h = hitsRef.current.find((hh) => hh.id === id);
      if (!h) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.stroke();
    };
    mark(markRef.current.hoverId, "#ffffff", 9);
    mark(markRef.current.selectedId, "#f59e0b", 11);
  }, [size]);

  useEffect(() => {
    drawOverlay();
  }, [hoverId, selected?.id, drawOverlay]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const { bodies, sats, aircraft } = dataRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const W = size.w;
    const H = size.h;
    const cx = W / 2;
    const cy = H / 2 + 6;
    const R = Math.max(40, Math.min(W, H) / 2 - 34);
    const sx = prefs.flip ? 1 : -1;
    const project = (alt: number, az: number): [number, number] => {
      const r = (1 - alt / 90) * R;
      const a = az * D2R;
      return [cx + sx * r * Math.sin(a), cy - r * Math.cos(a)];
    };
    const hits: Hit[] = [];
    const byId = byIdRef.current;
    byId.clear();
    const time = makeTime(now);
    const frame = new SkyFrame(time, origin.lat, origin.lon);
    const sun = bodies.find((b) => b.name === "Sun");
    const sunAlt = sun?.altDeg ?? -30;
    const dayness = smooth(-18, 8, sunAlt);
    const nightSky: [number, number, number] = [5, 9, 24];
    const daySky: [number, number, number] = [111, 163, 224];
    const twilightGlow: [number, number, number] = [214, 120, 66];

    // Sky dome with a twilight glow at the horizon near the Sun.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, mix(nightSky, daySky, dayness));
    g.addColorStop(1, mix(nightSky, [150, 190, 235], dayness));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const glow = 1 - Math.min(1, Math.abs(sunAlt + 2) / 10);
    if (glow > 0 && sun?.azDeg !== undefined) {
      const [gx, gy] = project(0, sun.azDeg);
      const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 0.9);
      gg.addColorStop(0, `rgba(${twilightGlow.join(",")}, ${0.55 * glow})`);
      gg.addColorStop(1, "rgba(214, 120, 66, 0)");
      ctx.fillStyle = gg;
      ctx.fillRect(0, 0, W, H);
    }

    // Altitude rings and cardinal lines.
    if (prefs.grid) {
      ctx.strokeStyle = dayness > 0.5 ? "rgba(255,255,255,0.28)" : "rgba(148,163,184,0.22)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      for (const alt of [30, 60]) {
        ctx.beginPath();
        ctx.arc(cx, cy, (1 - alt / 90) * R, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();
    }

    // Stars.
    if (stars) {
      const starAlpha = 1 - dayness * 0.92;
      if (starAlpha > 0.02) {
        ctx.globalAlpha = starAlpha;
        const n = stars.idx.length;
        const pts: number[][] = STAR_COLORS.map(() => []);
        for (let k = 0; k < n; k++) {
          const up = frame.sinAlt(stars.ra[k], stars.sinDec[k], stars.cosDec[k]);
          if (up <= 0) continue;
          const { alt, az } = frame.altAz(stars.ra[k], stars.sinDec[k], stars.cosDec[k]);
          const [x, y] = project(alt, az);
          const s = stars.size[k];
          pts[stars.color[k]].push(x, y, s);
          if (s >= 1.4) hits.push({ x, y, r: Math.max(5, s + 3), id: fixed[stars.idx[k]].id });
          if (s >= 1.4) byId.set(fixed[stars.idx[k]].id, fixed[stars.idx[k]]);
        }
        for (let c = 0; c < STAR_COLORS.length; c++) {
          const arr = pts[c];
          if (!arr.length) continue;
          ctx.fillStyle = STAR_COLORS[c];
          ctx.beginPath();
          for (let i = 0; i < arr.length; i += 3) {
            ctx.moveTo(arr[i] + arr[i + 2], arr[i + 1]);
            ctx.arc(arr[i], arr[i + 1], arr[i + 2], 0, Math.PI * 2);
          }
          ctx.fill();
        }
        if (prefs.labels) {
          ctx.fillStyle = "rgba(226,232,240,0.85)";
          ctx.font = "11px system-ui, sans-serif";
          ctx.textAlign = "left";
          for (let k = 0; k < n; k++) {
            const t = fixed[stars.idx[k]];
            if (t.mag! > 1.6 || !t.wiki) continue;
            const { alt, az } = frame.altAz(stars.ra[k], stars.sinDec[k], stars.cosDec[k]);
            if (alt <= 0) continue;
            const [x, y] = project(alt, az);
            ctx.fillText(t.name, x + 6, y + 4);
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // Deep-sky objects: small diamonds, labelled when curated.
    if (deep.length && dayness < 0.7) {
      ctx.globalAlpha = 1 - dayness;
      ctx.strokeStyle = "#c084fc";
      ctx.lineWidth = 1;
      ctx.font = "10px system-ui, sans-serif";
      for (const i of deep) {
        const t = fixed[i];
        const { alt, az } = frame.altAz(t.ra! * D2R, Math.sin(t.dec! * D2R), Math.cos(t.dec! * D2R));
        if (alt <= 0) continue;
        const [x, y] = project(alt, az);
        const faint = t.kind === "Quasar" || t.kind === "Pulsar";
        const d = faint ? 2.5 : 4;
        ctx.beginPath();
        ctx.moveTo(x, y - d);
        ctx.lineTo(x + d, y);
        ctx.lineTo(x, y + d);
        ctx.lineTo(x - d, y);
        ctx.closePath();
        ctx.stroke();
        hits.push({ x, y, r: 7, id: t.id });
        byId.set(t.id, t);
        if (prefs.labels && t.id.startsWith("dso-") && !faint) {
          ctx.fillStyle = "rgba(216,180,254,0.9)";
          ctx.fillText(t.name.replace(/ \(.*\)$/, ""), x + 6, y + 3);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Satellites and aircraft above the horizon.
    const dot = (list: Target[], color: string, r: number, labelIf: (t: Target) => boolean) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const t of list) {
        if (t.altDeg === undefined || t.azDeg === undefined || t.altDeg <= 0) continue;
        const [x, y] = project(t.altDeg, t.azDeg);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
        hits.push({ x, y, r: r + 4, id: t.id });
        byId.set(t.id, t);
      }
      ctx.fill();
      if (!prefs.labels) return;
      ctx.font = "10px system-ui, sans-serif";
      for (const t of list) {
        if (t.altDeg === undefined || t.azDeg === undefined || t.altDeg <= 0 || !labelIf(t)) continue;
        const [x, y] = project(t.altDeg, t.azDeg);
        ctx.fillText(t.name, x + 5, y + 3);
      }
    };
    if (prefs.sats) dot(sats, "#22d3ee", 2.2, (t) => t.id === "sat-25544" || t.kind === "station");
    if (prefs.aircraft) dot(aircraft, "#eab308", 2.4, (t) => t.altDeg! > 40);

    // Solar-system bodies.
    ctx.font = "11px system-ui, sans-serif";
    for (const t of bodies) {
      if (t.altDeg === undefined || t.azDeg === undefined || t.altDeg <= 0) continue;
      if (t.kind === "moon" || t.kind === "asteroid" || t.kind === "neo" || t.kind === "tno" || t.kind === "centaur" || t.kind === "region") continue;
      const [x, y] = project(t.altDeg, t.azDeg);
      if (t.name === "Sun") {
        const sg = ctx.createRadialGradient(x, y, 0, x, y, 40);
        sg.addColorStop(0, "rgba(255, 240, 180, 0.9)");
        sg.addColorStop(1, "rgba(255, 200, 80, 0)");
        ctx.fillStyle = sg;
        ctx.fillRect(x - 40, y - 40, 80, 80);
        ctx.fillStyle = "#fde68a";
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
        hits.push({ x, y, r: 12, id: t.id });
      } else if (t.name === "Moon") {
        const phase = A.MoonPhase(time); // 0 new … 180 full … 360
        const f = (1 - Math.cos(phase * D2R)) / 2; // illuminated fraction
        const waxing = phase < 180;
        const litRight = waxing !== prefs.flip; // waxing Moon is lit on the west (right when looking up, north up)
        const r = 8;
        ctx.fillStyle = MOON_DARK;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = MOON_BRIGHT;
        ctx.beginPath();
        ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2, !litRight);
        ctx.ellipse(x, y, r * Math.abs(Math.cos(Math.PI * f)), r, 0, Math.PI / 2, (3 * Math.PI) / 2, litRight === f < 0.5);
        ctx.fill();
        hits.push({ x, y, r: 12, id: t.id });
      } else if (t.kind === "Planet" || t.kind === "Dwarf planet") {
        ctx.fillStyle = PLANET_COLORS[t.name] ?? "#e5e7eb";
        ctx.beginPath();
        ctx.arc(x, y, t.name === "Pluto" ? 2.5 : 4, 0, Math.PI * 2);
        ctx.fill();
        hits.push({ x, y, r: 8, id: t.id });
      } else if (t.kind === "probe") {
        ctx.strokeStyle = "#f472b6";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x, y + 4);
        ctx.stroke();
        hits.push({ x, y, r: 7, id: t.id });
      } else {
        ctx.fillStyle = CATEGORY_BY_ID[t.category].color;
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        hits.push({ x, y, r: 6, id: t.id });
      }
      byId.set(t.id, t);
      if (prefs.labels && (t.kind === "Planet" || t.name === "Sun" || t.name === "Moon" || t.kind === "Dwarf planet")) {
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.fillText(t.name, x + 9, y + 4);
      }
    }
    ctx.restore();

    // Rim, compass points.
    ctx.strokeStyle = dark ? "rgba(148,163,184,0.7)" : "rgba(71,85,105,0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = dark ? "#e2e8f0" : "#1f2937";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [label, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const) {
      const [x, y] = project(-5.5, az);
      ctx.fillText(label, x, y);
    }
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = dark ? "rgba(203,213,225,0.8)" : "rgba(71,85,105,0.9)";
    for (const [label, az] of [["NE", 45], ["SE", 135], ["SW", 225], ["NW", 315]] as const) {
      const [x, y] = project(-5.5, az);
      ctx.fillText(label, x, y);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    hitsRef.current = hits;
    drawOverlay();
  }, [now, origin, fixed, stars, deep, prefs, size, dark, drawOverlay]);

  // ---- picking ----
  const pick = useCallback((ev: React.PointerEvent | React.MouseEvent): Hit | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    let best: Hit | null = null;
    let bd = Infinity;
    for (const h of hitsRef.current) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= h.r + 2 && d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }, []);
  const lastMove = useRef(0);
  const onMove = (ev: React.PointerEvent) => {
    const t = performance.now();
    if (t - lastMove.current < 40) return;
    lastMove.current = t;
    const h = pick(ev);
    propsRef.current.onHover(h?.id ?? null);
    if (h) {
      const rect = wrapRef.current!.getBoundingClientRect();
      setTip({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, id: h.id });
    } else setTip(null);
  };

  const tipTarget = tip ? byIdRef.current.get(tip.id) : undefined;
  const sun = bodies.find((b) => b.name === "Sun");
  const sunAlt = sun?.altDeg;
  const sel = selected;
  const selBelow = sel && sel.altDeg !== undefined && sel.altDeg <= 0 ? sel : null;
  const selFixedBelow = useMemo(() => {
    if (!sel || sel.altDeg !== undefined || sel.ra === undefined || sel.dec === undefined) return null;
    const f = new SkyFrame(makeTime(now), origin.lat, origin.lon).altAz(sel.ra * D2R, Math.sin(sel.dec * D2R), Math.cos(sel.dec * D2R));
    return f.alt <= 0 ? { ...f } : null;
  }, [sel, now, origin.lat, origin.lon]);
  const upCount = { sats: sats.reduce((n, t) => n + ((t.altDeg ?? -1) > 0 ? 1 : 0), 0), air: aircraft.reduce((n, t) => n + ((t.altDeg ?? -1) > 0 ? 1 : 0), 0) };

  return (
    <div className="sky" ref={wrapRef} role="application" aria-label="Sky view">
      <canvas ref={overlayRef} className="sky-overlay" style={{ width: size.w, height: size.h }} aria-hidden="true" />
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setTip(null);
          propsRef.current.onHover(null);
        }}
        onClick={(ev) => {
          const h = pick(ev);
          propsRef.current.onSelect(h ? h.id : null);
        }}
      />
      <div className="sky-caption">
        <strong>{sunAlt !== undefined ? skyWord(sunAlt) : "sky"}</strong>
        {sunAlt !== undefined && <span className="muted"> · Sun {sunAlt >= 0 ? "+" : "−"}{Math.abs(sunAlt).toFixed(0)}°</span>}
        <span className="muted"> · {upCount.sats.toLocaleString()} satellites{prefs.aircraft && upCount.air ? ` · ${upCount.air} aircraft` : ""} above the horizon</span>
      </div>
      <div className="g-toolbar sky-toolbar">
        <Menu label="Options ▾" align="right" className="g-menu" title="Choose what the sky shows">
          <div className="menu-title">Show</div>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.stars} onChange={(e) => onPrefs({ stars: e.target.checked })} /> Stars
          </label>
          <label className="menu-item g-size" title="Faintest star to draw (higher = more stars)">
            Limit mag {prefs.magLimit.toFixed(1)}
            <input type="range" min={2} max={6.5} step={0.5} value={prefs.magLimit} onChange={(e) => onPrefs({ magLimit: Number(e.target.value) })} />
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.deep} onChange={(e) => onPrefs({ deep: e.target.checked })} /> Galaxies, clusters, nebulae
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.sats} onChange={(e) => onPrefs({ sats: e.target.checked })} /> Satellites
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.aircraft} onChange={(e) => onPrefs({ aircraft: e.target.checked })} /> Aircraft
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.labels} onChange={(e) => onPrefs({ labels: e.target.checked })} /> Labels
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.grid} onChange={(e) => onPrefs({ grid: e.target.checked })} /> Altitude rings
          </label>
          <div className="menu-sep" />
          <label className="menu-item" title="Looking up, east is on the left. Flip to read it like a map.">
            <input type="checkbox" checked={prefs.flip} onChange={(e) => onPrefs({ flip: e.target.checked })} /> Mirror east/west
          </label>
        </Menu>
      </div>
      {tip && tipTarget && (
        <div className="solar-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>{tipTarget.name}</strong>
          <span>
            {tipTarget.altDeg !== undefined && tipTarget.azDeg !== undefined ? `↑ ${tipTarget.altDeg.toFixed(0)}° · ${compass(tipTarget.azDeg)} · ` : ""}
            {formatDistance(tipTarget.distanceKm, unit)}
          </span>
        </div>
      )}
      {(selBelow || selFixedBelow) && sel && (
        <div className="sky-below muted">
          {sel.name} is below the horizon ({(selBelow?.altDeg ?? selFixedBelow?.alt ?? 0).toFixed(0)}°, {compass(selBelow?.azDeg ?? selFixedBelow?.az ?? 0)})
        </div>
      )}
      <div className="globe-legend sky-legend">
        <span>
          <i style={{ background: "#22d3ee" }} /> satellite
        </span>
        <span>
          <i style={{ background: "#eab308" }} /> aircraft
        </span>
        <span>
          <i style={{ background: "#c084fc" }} /> deep sky
        </span>
        <span>
          <i style={{ background: "#f472b6" }} /> spacecraft
        </span>
        <span className="muted">zenith in the centre · horizon at the rim · north up, east left · hover for names · click for details</span>
      </div>
    </div>
  );
}
