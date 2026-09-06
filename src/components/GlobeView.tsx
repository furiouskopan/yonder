// 3D globe with every tracked satellite orbiting in real time (globe.gl on three.js).
// Satellites, Earth places and aircraft are three THREE.Points layers whose buffers are rewritten
// in place each tick. Buffers are allocated with spare capacity and only ever grow, and the old
// GPU copies are disposed when they do: re-allocating on every count change without disposing
// leaked graphics memory until the browser dropped the WebGL context (black screen).
import { useCallback, useEffect, useRef, useState } from "react";
import Globe from "globe.gl";
import * as THREE from "three";
import type { Origin, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { formatDistance, type Unit } from "../lib/units";
import type { GlobePrefs } from "../hooks/usePrefs";

interface Props {
  origin: Origin;
  earthRows: Target[];
  sats: Target[];
  aircraft: Target[];
  selected: Target | null;
  hoverId: string | null;
  track: [number, number][] | null;
  trackHeightKm: number;
  unit: Unit;
  dark: boolean;
  pinOnClick: boolean;
  prefs: GlobePrefs;
  onPrefs: (patch: Partial<GlobePrefs>) => void;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onOriginChange: (lat: number, lon: number) => void;
}

const EARTH_R = 6371;
type GlobeT = InstanceType<typeof Globe>;

interface Layer {
  points: THREE.Points;
  ids: string[];
  byId: Map<string, Target>;
  capacity: number;
  count: number;
  baseSize: number;
}

interface Item {
  t: Target;
  lat: number;
  lng: number;
  altKm: number;
  color: THREE.Color;
}

function makeLayer(size: number): Layer {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
  geom.setDrawRange(0, 0);
  const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  return { points, ids: [], byId: new Map(), capacity: 0, count: 0, baseSize: size };
}

/** Grow the buffers (never shrink). Disposing the geometry first frees the GPU copies of the old attributes. */
function ensureCapacity(layer: Layer, n: number): void {
  if (n <= layer.capacity) return;
  const cap = Math.max(256, Math.ceil(n * 1.3));
  const geom = layer.points.geometry;
  geom.dispose();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  layer.capacity = cap;
  layer.ids = new Array<string>(cap);
}

function fillLayer(layer: Layer, globe: GlobeT, items: Item[]): void {
  const n = items.length;
  ensureCapacity(layer, n);
  const geom = layer.points.geometry;
  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const col = geom.getAttribute("color") as THREE.BufferAttribute;
  const pa = pos.array as Float32Array;
  const ca = col.array as Float32Array;
  const byId = layer.byId;
  byId.clear();
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const c = globe.getCoords(it.lat, it.lng, it.altKm / EARTH_R);
    pa[i * 3] = c.x;
    pa[i * 3 + 1] = c.y;
    pa[i * 3 + 2] = c.z;
    ca[i * 3] = it.color.r;
    ca[i * 3 + 1] = it.color.g;
    ca[i * 3 + 2] = it.color.b;
    layer.ids[i] = it.t.id;
    byId.set(it.t.id, it.t);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geom.setDrawRange(0, n);
  layer.count = n;
  geom.computeBoundingSphere();
}

const COLOR_CACHE = new Map<string, THREE.Color>();
const color = (hex: string): THREE.Color => {
  let c = COLOR_CACHE.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    COLOR_CACHE.set(hex, c);
  }
  return c;
};

const TEXTURE_LABEL: Record<GlobePrefs["texture"], string> = { auto: "Texture: auto", night: "Texture: night", day: "Texture: day" };
const NEXT_TEXTURE: Record<GlobePrefs["texture"], GlobePrefs["texture"]> = { auto: "night", night: "day", day: "auto" };

export default function GlobeView(props: Props) {
  const { origin, earthRows, sats, aircraft, selected, hoverId, track, trackHeightKm, unit, dark, prefs, onPrefs } = props;
  const divRef = useRef<HTMLDivElement>(null); // sized wrapper that also holds the overlays
  const mountRef = useRef<HTMLDivElement>(null); // globe.gl wipes and owns this element
  const globeRef = useRef<GlobeT | null>(null);
  const layersRef = useRef<{ sats: Layer; earth: Layer; air: Layer } | null>(null);
  const highlightRef = useRef<THREE.Mesh | null>(null);
  const lastPickRef = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; id: string } | null>(null);

  const textureUrl = prefs.texture === "night" || (prefs.texture === "auto" && dark) ? "/textures/earth-night.jpg" : "/textures/earth-day.jpg";

  const lookup = (id: string): Target | undefined => {
    const L = layersRef.current;
    return L?.sats.byId.get(id) ?? L?.air.byId.get(id) ?? L?.earth.byId.get(id);
  };

  // Create the globe (again after a lost context, when `epoch` changes).
  useEffect(() => {
    const el = divRef.current;
    const mount = mountRef.current;
    if (!el || !mount) return;
    const globe = new Globe(mount, { animateIn: false, rendererConfig: { antialias: true, alpha: true, powerPreference: "high-performance" } });
    globe
      .globeImageUrl(propsRef.current.prefs.texture === "night" || (propsRef.current.prefs.texture === "auto" && propsRef.current.dark) ? "/textures/earth-night.jpg" : "/textures/earth-day.jpg")
      .bumpImageUrl("/textures/earth-topology.png")
      .backgroundImageUrl("/textures/night-sky.png")
      .showAtmosphere(true)
      .atmosphereColor("#3d7bd6")
      .atmosphereAltitude(0.16)
      .pointLat("lat")
      .pointLng("lng")
      .pointColor("color")
      .pointAltitude("alt")
      .pointRadius("r")
      .labelLat("lat")
      .labelLng("lng")
      .labelText("text")
      .labelSize(1.1)
      .labelDotRadius(0.35)
      .labelColor(() => "#ef4444")
      .labelAltitude(0.012)
      .pathPoints("pts")
      .pathPointAlt((p: number[]) => p[2])
      .pathColor(() => "#06b6d4")
      .pathStroke(1.5)
      .pathDashLength(0.03)
      .pathDashGap(0.015)
      .pathDashAnimateTime(6000)
      .ringLat("lat")
      .ringLng("lng")
      .ringColor(() => "#f59e0b")
      .ringMaxRadius(3)
      .ringPropagationSpeed(1.5)
      .ringRepeatPeriod(1200)
      .onGlobeClick(({ lat, lng }) => {
        if (performance.now() - lastPickRef.current < 150) return;
        if (propsRef.current.pinOnClick) propsRef.current.onOriginChange(lat, lng);
      });
    globe.width(el.clientWidth).height(el.clientHeight);
    const o = propsRef.current.origin;
    globe.pointOfView({ lat: o.lat, lng: o.lon, altitude: 2.2 }, 0);
    globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const controls = globe.controls() as unknown as { enableDamping: boolean; dampingFactor: number; autoRotate: boolean; autoRotateSpeed: number; zoomSpeed: number };
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.autoRotate = propsRef.current.prefs.autoRotate;
    controls.autoRotateSpeed = 0.35;
    controls.zoomSpeed = 0.8;

    const satL = makeLayer(1.7);
    const earthL = makeLayer(1.2);
    const airL = makeLayer(1.6);
    const scene = globe.scene();
    scene.add(satL.points, earthL.points, airL.points);
    const highlight = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12), new THREE.MeshBasicMaterial({ color: "#f59e0b" }));
    highlight.visible = false;
    scene.add(highlight);
    layersRef.current = { sats: satL, earth: earthL, air: airL };
    highlightRef.current = highlight;
    globeRef.current = globe;

    // Picking against the visible point layers.
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.4 };
    const mouse = new THREE.Vector2();
    const canvas = globe.renderer().domElement;
    let last = 0;
    const pick = (ev: PointerEvent | MouseEvent): string | null => {
      const L = layersRef.current;
      if (!L) return null;
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, globe.camera() as THREE.Camera);
      const hits = raycaster.intersectObjects([L.sats.points, L.air.points, L.earth.points].filter((p) => p.visible), false);
      for (const h of hits) {
        const layer = h.object === L.sats.points ? L.sats : h.object === L.air.points ? L.air : L.earth;
        if (h.index !== undefined && h.index < layer.count && layer.ids[h.index]) return layer.ids[h.index];
      }
      return null;
    };
    const onMove = (ev: PointerEvent) => {
      const t = performance.now();
      if (t - last < 40 || ev.buttons) return;
      last = t;
      const id = pick(ev);
      propsRef.current.onHover(id);
      if (id) {
        const rect = el.getBoundingClientRect();
        setTip({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, id });
      } else setTip(null);
    };
    const onClick = (ev: MouseEvent) => {
      const id = pick(ev);
      if (id) {
        lastPickRef.current = performance.now();
        propsRef.current.onSelect(id);
      }
    };
    const onLeave = () => {
      setTip(null);
      propsRef.current.onHover(null);
    };
    // The globe renders continuously; stop while the tab is hidden.
    const onVisibility = () => {
      if (document.hidden) globe.pauseAnimation();
      else globe.resumeAnimation();
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      setLost(true);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("webglcontextlost", onLost);
    document.addEventListener("visibilitychange", onVisibility);
    const ro = new ResizeObserver(() => globe.width(el.clientWidth).height(el.clientHeight));
    ro.observe(el);
    setLost(false);
    setReady(true);
    return () => {
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("webglcontextlost", onLost);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const layer of [satL, earthL, airL]) {
        layer.points.geometry.dispose();
        (layer.points.material as THREE.Material).dispose();
      }
      globe._destructor();
      mount.innerHTML = "";
      globeRef.current = null;
      layersRef.current = null;
      setReady(false);
    };
  }, [epoch]);

  useEffect(() => {
    globeRef.current?.globeImageUrl(textureUrl);
  }, [textureUrl, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready) return;
    const controls = globe.controls() as unknown as { autoRotate: boolean };
    controls.autoRotate = prefs.autoRotate;
  }, [prefs.autoRotate, ready]);

  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    L.sats.points.visible = prefs.sats;
    L.air.points.visible = prefs.aircraft;
    L.earth.points.visible = prefs.places;
    for (const l of [L.sats, L.air, L.earth]) (l.points.material as THREE.PointsMaterial).size = l.baseSize * prefs.pointSize;
  }, [prefs.sats, prefs.aircraft, prefs.places, prefs.pointSize, ready]);

  // Origin marker and label; fly there when it moves.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready) return;
    globe.pointsData([{ lat: origin.lat, lng: origin.lon, color: "#ef4444", alt: 0.01, r: 0.45 }]);
    globe.labelsData(prefs.labels ? [{ lat: origin.lat, lng: origin.lon, text: origin.name }] : []);
  }, [origin.lat, origin.lon, origin.name, prefs.labels, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready) return;
    globe.pointOfView({ lat: origin.lat, lng: origin.lon }, 900);
  }, [origin.lat, origin.lon, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    const L = layersRef.current;
    if (!globe || !L || !ready) return;
    const items: Item[] = [];
    for (const t of sats) {
      if (t.subLat === undefined || t.subLon === undefined) continue;
      items.push({ t, lat: t.subLat, lng: t.subLon, altKm: t.heightKm ?? 400, color: color((t.altDeg ?? -1) >= 0 ? "#22d3ee" : "#0e7490") });
    }
    fillLayer(L.sats, globe, items);
  }, [sats, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    const L = layersRef.current;
    if (!globe || !L || !ready) return;
    const items: Item[] = [];
    for (const t of earthRows) {
      if (t.lat === undefined || t.lon === undefined) continue;
      items.push({ t, lat: t.lat, lng: t.lon, altKm: 8, color: color(CATEGORY_BY_ID[t.category].color) });
    }
    fillLayer(L.earth, globe, items);
  }, [earthRows, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    const L = layersRef.current;
    if (!globe || !L || !ready) return;
    const items: Item[] = [];
    for (const t of aircraft) {
      if (t.lat === undefined || t.lon === undefined) continue;
      items.push({ t, lat: t.lat, lng: t.lon, altKm: Math.max(2, t.heightKm ?? 0), color: color("#eab308") });
    }
    fillLayer(L.air, globe, items);
  }, [aircraft, ready]);

  // Selection highlight.
  useEffect(() => {
    const globe = globeRef.current;
    const h = highlightRef.current;
    if (!globe || !h || !ready) return;
    const lat = selected?.subLat ?? selected?.lat;
    const lng = selected?.subLon ?? selected?.lon;
    if (!selected || lat === undefined || lng === undefined) {
      h.visible = false;
      globe.ringsData([]);
      return;
    }
    const altKm = selected.category === "satellite" || selected.category === "aircraft" ? (selected.heightKm ?? 0) : 5;
    const c = globe.getCoords(lat, lng, altKm / EARTH_R);
    h.position.set(c.x, c.y, c.z);
    h.visible = true;
    globe.ringsData([{ lat, lng }]);
  }, [selected, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready) return;
    globe.pathsData(prefs.track && track && track.length > 1 ? [{ pts: track.map(([la, lo]) => [la, lo, trackHeightKm / EARTH_R]) }] : []);
  }, [track, trackHeightKm, prefs.track, ready]);

  const flyTo = useCallback((lat: number, lng: number, altitude: number) => {
    globeRef.current?.pointOfView({ lat, lng, altitude }, 800);
  }, []);

  const tipTarget = tip ? lookup(tip.id) : undefined;
  const hoverTarget = !tip && hoverId ? lookup(hoverId) : undefined;
  const selLat = selected?.subLat ?? selected?.lat;
  const selLng = selected?.subLon ?? selected?.lon;
  const satCount = sats.length;
  const airCount = aircraft.length;

  return (
    <div className="globe" ref={divRef} role="application" aria-label="Globe">
      <div className="globe-mount" ref={mountRef} />
      <div className="g-toolbar">
        <button type="button" onClick={() => flyTo(origin.lat, origin.lon, 1.8)} title="Fly back to the origin">
          ◎ Origin
        </button>
        <button type="button" className={prefs.autoRotate ? "on" : ""} aria-pressed={prefs.autoRotate} onClick={() => onPrefs({ autoRotate: !prefs.autoRotate })}>
          Auto-rotate
        </button>
        <button type="button" onClick={() => onPrefs({ texture: NEXT_TEXTURE[prefs.texture] })} title="Cycle the Earth texture">
          {TEXTURE_LABEL[prefs.texture]}
        </button>
        <span className="g-sep" />
        <button type="button" className={prefs.sats ? "on" : ""} aria-pressed={prefs.sats} onClick={() => onPrefs({ sats: !prefs.sats })}>
          Satellites {satCount.toLocaleString()}
        </button>
        <button type="button" className={prefs.aircraft ? "on" : ""} aria-pressed={prefs.aircraft} onClick={() => onPrefs({ aircraft: !prefs.aircraft })}>
          Aircraft {airCount}
        </button>
        <button type="button" className={prefs.places ? "on" : ""} aria-pressed={prefs.places} onClick={() => onPrefs({ places: !prefs.places })}>
          Places
        </button>
        <button type="button" className={prefs.track ? "on" : ""} aria-pressed={prefs.track} onClick={() => onPrefs({ track: !prefs.track })} title="Orbit path of the selected satellite (or the ISS)">
          Orbit path
        </button>
        <button type="button" className={prefs.labels ? "on" : ""} aria-pressed={prefs.labels} onClick={() => onPrefs({ labels: !prefs.labels })}>
          Label
        </button>
        <label className="g-size" title="Dot size">
          Size
          <input type="range" min={0.4} max={3} step={0.1} value={prefs.pointSize} onChange={(e) => onPrefs({ pointSize: Number(e.target.value) })} />
        </label>
      </div>
      {tip && tipTarget && (
        <div className="solar-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <strong>{tipTarget.name}</strong>
          <span>{formatDistance(tipTarget.distanceKm, unit)}</span>
        </div>
      )}
      {hoverTarget && (
        <div className="globe-hover">
          <strong>{hoverTarget.name}</strong> · {formatDistance(hoverTarget.distanceKm, unit)}
        </div>
      )}
      {selected && selLat !== undefined && selLng !== undefined && (
        <div className="g-card">
          <strong>{selected.name}</strong>
          {selected.subtitle && <span className="muted">{selected.subtitle}</span>}
          <span>
            {formatDistance(selected.distanceKm, unit)}
            {selected.heightKm !== undefined && selected.category !== "aircraft" ? ` · ${Math.round(selected.heightKm).toLocaleString()} km up` : ""}
            {selected.speedKms !== undefined && Number.isFinite(selected.speedKms) ? ` · ${selected.speedKms.toFixed(2)} km/s` : ""}
          </span>
          <div className="g-card-actions">
            <button type="button" onClick={() => flyTo(selLat, selLng, selected.category === "satellite" ? 1.4 : 0.6)}>
              Fly to
            </button>
            <button type="button" onClick={() => props.onSelect(null)} title="Deselect">
              ✕
            </button>
          </div>
        </div>
      )}
      <div className="globe-legend">
        <span>
          <i style={{ background: "#22d3ee" }} /> satellite above your horizon
        </span>
        <span>
          <i style={{ background: "#0e7490" }} /> below
        </span>
        <span>
          <i style={{ background: "#eab308" }} /> aircraft
        </span>
        <span className="muted">drag to rotate · wheel to zoom · click a dot for details · click the ground to move the origin</span>
      </div>
      {lost && (
        <div className="lost">
          <p>The browser reset the 3D view (it ran out of graphics memory or the GPU was interrupted).</p>
          <button type="button" onClick={() => setEpoch((e) => e + 1)}>
            Rebuild the globe
          </button>
        </div>
      )}
    </div>
  );
}
