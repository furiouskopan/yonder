// 3D globe with every tracked satellite orbiting in real time (globe.gl on three.js).
// Satellites, Earth places, aircraft and surface vehicles are THREE.Points layers drawn by a small
// shader (round, soft, per-point size) whose buffers are rewritten in place each tick. Buffers are
// allocated with spare capacity and only ever grow; the old GPU copies are disposed when they do
// (re-allocating without disposing leaked graphics memory until the browser dropped the WebGL
// context). The id lookup tables are rebuilt only when the set of ids changes, so a 13k-satellite
// tick costs one pass over a Float32Array and nothing else.
import { useCallback, useEffect, useRef, useState } from "react";
import Globe from "globe.gl";
import * as THREE from "three";
import type { Origin, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { formatDistance, type Unit } from "../lib/units";
import type { GlobePrefs } from "../hooks/usePrefs";
import Menu from "./Menu";

interface Props {
  origin: Origin;
  earthRows: Target[];
  sats: Target[];
  aircraft: Target[];
  vehicles: Target[]; // ships and trains
  selected: Target | null;
  hoverId: string | null;
  track: [number, number][] | null;
  footprint: [number, number][] | null;
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
const GLOBE_R = 100; // globe.gl's internal radius
const D2R = Math.PI / 180;
type GlobeT = InstanceType<typeof Globe>;

const VERT = `
attribute float size;
attribute vec3 color;
uniform float uScale;
uniform float uSizeMul;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * uSizeMul * uScale / -mv.z, 2.0, 26.0);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform float uOpacity;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.3, d);
  gl_FragColor = vec4(vColor, a * uOpacity);
}`;

interface Layer {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  ids: string[];
  items: Target[]; // parallel to ids, the latest Target for each drawn point
  index: Map<string, number>; // id -> point index, rebuilt only when the id list changes
  capacity: number;
  count: number;
  baseSize: number;
}

/** Scratch record a layer fill callback writes into (no per-point allocations). */
interface Slot {
  lat: number;
  lng: number;
  altKm: number;
  r: number;
  g: number;
  b: number;
  size: number;
}

function makeLayer(size: number): Layer {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("size", new THREE.BufferAttribute(new Float32Array(0), 1));
  geom.setDrawRange(0, 0);
  // Everything lives within geostationary distance of the globe; a fixed bounding sphere saves a per-tick recompute.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GLOBE_R * 8);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uScale: { value: 300 }, uSizeMul: { value: 1 }, uOpacity: { value: 0.95 } },
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geom, material);
  points.frustumCulled = false;
  return { points, material, ids: [], items: [], index: new Map(), capacity: 0, count: 0, baseSize: size };
}

/** Grow the buffers (never shrink). Disposing the geometry first frees the GPU copies of the old attributes. */
function ensureCapacity(layer: Layer, n: number): void {
  if (n <= layer.capacity) return;
  const cap = Math.max(256, Math.ceil(n * 1.3));
  const geom = layer.points.geometry;
  const sphere = geom.boundingSphere;
  geom.dispose();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  geom.setAttribute("size", new THREE.BufferAttribute(new Float32Array(cap), 1));
  geom.boundingSphere = sphere;
  layer.capacity = cap;
  layer.ids = new Array<string>(cap);
  layer.items = new Array<Target>(cap);
}

const slot: Slot = { lat: 0, lng: 0, altKm: 0, r: 1, g: 1, b: 1, size: 1 };

/** Rewrite a layer from a target list. `fill` returns false to skip a target. */
function fillLayer(layer: Layer, list: Target[], fill: (t: Target, s: Slot) => boolean): void {
  ensureCapacity(layer, list.length);
  const geom = layer.points.geometry;
  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const col = geom.getAttribute("color") as THREE.BufferAttribute;
  const siz = geom.getAttribute("size") as THREE.BufferAttribute;
  const pa = pos.array as Float32Array;
  const ca = col.array as Float32Array;
  const sa = siz.array as Float32Array;
  let n = 0;
  let idsChanged = false;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!fill(t, slot)) continue;
    const phi = (90 - slot.lat) * D2R;
    const theta = (90 - slot.lng) * D2R;
    const r = GLOBE_R * (1 + slot.altKm / EARTH_R);
    const sp = Math.sin(phi);
    const o = n * 3;
    pa[o] = r * sp * Math.cos(theta);
    pa[o + 1] = r * Math.cos(phi);
    pa[o + 2] = r * sp * Math.sin(theta);
    ca[o] = slot.r;
    ca[o + 1] = slot.g;
    ca[o + 2] = slot.b;
    sa[n] = slot.size;
    if (layer.ids[n] !== t.id) {
      layer.ids[n] = t.id;
      idsChanged = true;
    }
    layer.items[n] = t;
    n++;
  }
  if (n !== layer.count) idsChanged = true;
  pos.needsUpdate = true;
  col.needsUpdate = true;
  siz.needsUpdate = true;
  geom.setDrawRange(0, n);
  layer.count = n;
  if (idsChanged) {
    layer.index.clear();
    for (let i = 0; i < n; i++) layer.index.set(layer.ids[i], i);
  }
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
const SAT_UP = color("#22d3ee");
const SAT_DOWN = color("#0e7490");
const AIR = color("#eab308");

const TEXTURE_LABEL: Record<GlobePrefs["texture"], string> = { auto: "Texture: auto", night: "Texture: night", day: "Texture: day" };
const NEXT_TEXTURE: Record<GlobePrefs["texture"], GlobePrefs["texture"]> = { auto: "night", night: "day", day: "auto" };

interface PathDatum {
  pts: number[][];
  color: string;
  stroke: number;
  dash: number;
  gap: number;
}

export default function GlobeView(props: Props) {
  const { origin, earthRows, sats, aircraft, vehicles, selected, hoverId, track, footprint, trackHeightKm, unit, dark, prefs, onPrefs } = props;
  const divRef = useRef<HTMLDivElement>(null); // sized wrapper that also holds the overlays
  const mountRef = useRef<HTMLDivElement>(null); // globe.gl wipes and owns this element
  const globeRef = useRef<GlobeT | null>(null);
  const layersRef = useRef<{ sats: Layer; earth: Layer; air: Layer; veh: Layer } | null>(null);
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
    if (!L) return undefined;
    for (const layer of [L.sats, L.air, L.veh, L.earth]) {
      const i = layer.index.get(id);
      if (i !== undefined && i < layer.count) return layer.items[i];
    }
    return undefined;
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
      .pathColor((d: object) => (d as PathDatum).color)
      .pathStroke((d: object) => (d as PathDatum).stroke)
      .pathDashLength((d: object) => (d as PathDatum).dash)
      .pathDashGap((d: object) => (d as PathDatum).gap)
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
    const renderer = globe.renderer();
    const dpr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(dpr);
    const controls = globe.controls() as unknown as { enableDamping: boolean; dampingFactor: number; autoRotate: boolean; autoRotateSpeed: number; zoomSpeed: number };
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.autoRotate = propsRef.current.prefs.autoRotate;
    controls.autoRotateSpeed = 0.35;
    controls.zoomSpeed = 0.8;

    const satL = makeLayer(1.9);
    const earthL = makeLayer(1.3);
    const airL = makeLayer(1.8);
    const vehL = makeLayer(1.6);
    const layers = [satL, earthL, airL, vehL];
    const setScale = () => {
      const s = (el.clientHeight * dpr) / 2;
      for (const l of layers) l.material.uniforms.uScale.value = s;
    };
    setScale();
    const scene = globe.scene();
    scene.add(satL.points, earthL.points, airL.points, vehL.points);
    const highlight = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12), new THREE.MeshBasicMaterial({ color: "#f59e0b" }));
    highlight.visible = false;
    scene.add(highlight);
    layersRef.current = { sats: satL, earth: earthL, air: airL, veh: vehL };
    highlightRef.current = highlight;
    globeRef.current = globe;

    // Picking against the visible point layers, with a tolerance that follows the zoom level.
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const canvas = renderer.domElement;
    let last = 0;
    const pick = (ev: PointerEvent | MouseEvent): string | null => {
      const L = layersRef.current;
      if (!L) return null;
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      const camera = globe.camera() as THREE.Camera;
      raycaster.setFromCamera(mouse, camera);
      const altitude = camera.position.length() - GLOBE_R;
      raycaster.params.Points = { threshold: Math.max(0.25, altitude * 0.006) };
      const ordered = [L.sats, L.air, L.veh, L.earth].filter((l) => l.points.visible && l.count > 0);
      const hits = raycaster.intersectObjects(
        ordered.map((l) => l.points),
        false,
      );
      for (const h of hits) {
        const layer = ordered.find((l) => l.points === h.object);
        if (layer && h.index !== undefined && h.index < layer.count && layer.ids[h.index]) return layer.ids[h.index];
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
    const ro = new ResizeObserver(() => {
      globe.width(el.clientWidth).height(el.clientHeight);
      setScale();
    });
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
      for (const layer of layers) {
        layer.points.geometry.dispose();
        layer.material.dispose();
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
    L.veh.points.visible = prefs.vehicles;
    L.earth.points.visible = prefs.places;
    for (const l of [L.sats, L.air, L.veh, L.earth]) l.material.uniforms.uSizeMul.value = l.baseSize * prefs.pointSize;
  }, [prefs.sats, prefs.aircraft, prefs.vehicles, prefs.places, prefs.pointSize, ready]);

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
    const L = layersRef.current;
    if (!L || !ready) return;
    fillLayer(L.sats, sats, (t, s) => {
      if (t.subLat === undefined || t.subLon === undefined) return false;
      const up = (t.altDeg ?? -1) >= 0;
      const c = up ? SAT_UP : SAT_DOWN;
      s.lat = t.subLat;
      s.lng = t.subLon;
      s.altKm = t.heightKm ?? 400;
      s.r = c.r;
      s.g = c.g;
      s.b = c.b;
      s.size = up ? 1.25 : 1;
      return true;
    });
  }, [sats, ready]);

  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    fillLayer(L.earth, earthRows, (t, s) => {
      if (t.lat === undefined || t.lon === undefined) return false;
      const c = color(CATEGORY_BY_ID[t.category].color);
      s.lat = t.lat;
      s.lng = t.lon;
      s.altKm = 8;
      s.r = c.r;
      s.g = c.g;
      s.b = c.b;
      s.size = t.category === "landmark" || t.category === "capital" ? 1.3 : 1;
      return true;
    });
  }, [earthRows, ready]);

  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    fillLayer(L.air, aircraft, (t, s) => {
      if (t.lat === undefined || t.lon === undefined) return false;
      s.lat = t.lat;
      s.lng = t.lon;
      s.altKm = Math.max(2, t.heightKm ?? 0);
      s.r = AIR.r;
      s.g = AIR.g;
      s.b = AIR.b;
      s.size = 1;
      return true;
    });
  }, [aircraft, ready]);

  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    fillLayer(L.veh, vehicles, (t, s) => {
      if (t.lat === undefined || t.lon === undefined) return false;
      const c = color(CATEGORY_BY_ID[t.category].color);
      s.lat = t.lat;
      s.lng = t.lon;
      s.altKm = 4;
      s.r = c.r;
      s.g = c.g;
      s.b = c.b;
      s.size = 1;
      return true;
    });
  }, [vehicles, ready]);

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
    const paths: PathDatum[] = [];
    if (prefs.track && track && track.length > 1) paths.push({ pts: track.map(([la, lo]) => [la, lo, trackHeightKm / EARTH_R]), color: "#06b6d4", stroke: 1.5, dash: 0.03, gap: 0.015 });
    if (prefs.footprint && footprint && footprint.length > 2) paths.push({ pts: footprint.map(([la, lo]) => [la, lo, 0.004]), color: "rgba(245, 158, 11, 0.8)", stroke: 1.2, dash: 1, gap: 0 });
    globe.pathsData(paths);
  }, [track, footprint, trackHeightKm, prefs.track, prefs.footprint, ready]);

  const flyTo = useCallback((lat: number, lng: number, altitude: number) => {
    globeRef.current?.pointOfView({ lat, lng, altitude }, 800);
  }, []);

  const tipTarget = tip ? lookup(tip.id) : undefined;
  const hoverTarget = !tip && hoverId ? lookup(hoverId) : undefined;
  const selLat = selected?.subLat ?? selected?.lat;
  const selLng = selected?.subLon ?? selected?.lon;
  const satCount = sats.length;
  const airCount = aircraft.length;
  const vehCount = vehicles.length;

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
        <Menu label="Layers ▾" align="left" className="g-menu" title="Choose what the globe shows">
          <div className="menu-title">Show</div>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.sats} onChange={(e) => onPrefs({ sats: e.target.checked })} /> Satellites <span className="count">{satCount.toLocaleString()}</span>
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.aircraft} onChange={(e) => onPrefs({ aircraft: e.target.checked })} /> Aircraft <span className="count">{airCount}</span>
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.vehicles} onChange={(e) => onPrefs({ vehicles: e.target.checked })} /> Ships & trains <span className="count">{vehCount}</span>
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.places} onChange={(e) => onPrefs({ places: e.target.checked })} /> Places on the ground
          </label>
          <label className="menu-item" title="Orbit path of the selected satellite (or the ISS)">
            <input type="checkbox" checked={prefs.track} onChange={(e) => onPrefs({ track: e.target.checked })} /> Orbit path
          </label>
          <label className="menu-item" title="The area on the ground from which the tracked satellite is above the horizon">
            <input type="checkbox" checked={prefs.footprint} onChange={(e) => onPrefs({ footprint: e.target.checked })} /> Visibility circle
          </label>
          <label className="menu-item">
            <input type="checkbox" checked={prefs.labels} onChange={(e) => onPrefs({ labels: e.target.checked })} /> Origin label
          </label>
          <div className="menu-sep" />
          <label className="menu-item g-size" title="Dot size">
            Dot size
            <input type="range" min={0.4} max={3} step={0.1} value={prefs.pointSize} onChange={(e) => onPrefs({ pointSize: Number(e.target.value) })} />
          </label>
        </Menu>
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
            {selected.speedKms !== undefined && Number.isFinite(selected.speedKms) ? (selected.speedKms < 0.5 ? ` · ${Math.round(selected.speedKms * 3600)} km/h` : ` · ${selected.speedKms.toFixed(2)} km/s`) : ""}
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
        <span>
          <i style={{ background: "#0ea5e9" }} /> ship
        </span>
        <span>
          <i style={{ background: "#84cc16" }} /> train
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
