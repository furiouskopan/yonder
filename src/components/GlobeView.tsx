// 3D globe with every tracked satellite orbiting in real time (globe.gl on three.js).
// Satellites, Earth places, aircraft, surface vehicles, the tracked satellite's orbit and its visibility
// footprint are THREE.Points layers drawn by one small shader (round, soft, per-point size). Their buffers are
// rewritten in place each tick, allocated with spare capacity and only ever grown (the old GPU copies are
// disposed when they do: re-allocating without disposing leaked graphics memory until the browser dropped the
// WebGL context). Nothing here goes through globe.gl's data layers per tick: its path and ring layers rebuild
// their objects (and recompile their shaders) whenever the data changes, which at once a second meant a
// constant stream of shader compiles. globe.gl's pointer interaction is off as well, because it raycasts the
// whole globe twenty times a second whether or not the pointer moves; picking and the click-to-move-origin
// are done here instead.
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
  track: [number, number, number][] | null; // lat, lon, height above the surface (km)
  footprint: [number, number][] | null;
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
  gl_PointSize = clamp(size * uSizeMul * uScale / -mv.z, 3.0, 28.0);
  gl_Position = projectionMatrix * mv;
}`;
// Colours are stored linear (THREE.Color); colorspace_fragment converts to the canvas's sRGB output like the
// built-in materials do. Without it every dot is drawn several times too dark.
const FRAG = `
uniform float uOpacity;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, (1.0 - smoothstep(0.32, 0.5, d)) * uOpacity);
  #include <colorspace_fragment>
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

function makeLayer(size: number, opacity = 0.95): Layer {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("size", new THREE.BufferAttribute(new Float32Array(0), 1));
  geom.setDrawRange(0, 0);
  // Generous fixed bounding sphere: everything from the surface to beyond geostationary orbit fits, and the
  // per-tick update need not recompute it.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), GLOBE_R * 12);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { uScale: { value: 300 }, uSizeMul: { value: 1 }, uOpacity: { value: opacity } },
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

/** globe.gl's polar-to-cartesian mapping (three-globe polar2Cartesian), inlined for the per-tick loops. */
function writeCoords(arr: Float32Array, o: number, lat: number, lng: number, altKm: number): void {
  const phi = (90 - lat) * D2R;
  const theta = (90 - lng) * D2R;
  const r = GLOBE_R * (1 + altKm / EARTH_R);
  const sp = Math.sin(phi);
  arr[o] = r * sp * Math.cos(theta);
  arr[o + 1] = r * Math.cos(phi);
  arr[o + 2] = r * sp * Math.sin(theta);
}

function finish(layer: Layer, n: number, idsChanged: boolean): void {
  const geom = layer.points.geometry;
  (geom.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  (geom.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  (geom.getAttribute("size") as THREE.BufferAttribute).needsUpdate = true;
  geom.setDrawRange(0, n);
  if (n !== layer.count) idsChanged = true;
  layer.count = n;
  if (idsChanged) {
    layer.index.clear();
    for (let i = 0; i < n; i++) if (layer.ids[i]) layer.index.set(layer.ids[i], i);
  }
}

/** Rewrite a layer from a target list. `fill` returns false to skip a target. */
function fillLayer(layer: Layer, list: Target[], fill: (t: Target, s: Slot) => boolean): void {
  ensureCapacity(layer, list.length);
  const geom = layer.points.geometry;
  const pa = (geom.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const ca = (geom.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
  const sa = (geom.getAttribute("size") as THREE.BufferAttribute).array as Float32Array;
  let n = 0;
  let idsChanged = false;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!fill(t, slot)) continue;
    const o = n * 3;
    writeCoords(pa, o, slot.lat, slot.lng, slot.altKm);
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
  finish(layer, n, idsChanged);
}

/** Rewrite a decorative (unpickable) layer from coordinates: [lat, lon] or [lat, lon, height km]. */
function fillCoords(layer: Layer, coords: number[][] | null, altKm: number, color: THREE.Color, size: number): void {
  const n = coords?.length ?? 0;
  ensureCapacity(layer, n);
  const geom = layer.points.geometry;
  const pa = (geom.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const ca = (geom.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
  const sa = (geom.getAttribute("size") as THREE.BufferAttribute).array as Float32Array;
  for (let i = 0; i < n; i++) {
    const c = coords![i];
    writeCoords(pa, i * 3, c[0], c[1], c.length > 2 ? c[2] : altKm);
    ca[i * 3] = color.r;
    ca[i * 3 + 1] = color.g;
    ca[i * 3 + 2] = color.b;
    sa[i] = size;
  }
  finish(layer, n, false);
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
const SAT_DOWN = color("#1a9bb5");
const AIR = color("#eab308");
const TRACK = color("#06b6d4");
const FOOTPRINT = color("#f59e0b");

const TEXTURE_LABEL: Record<GlobePrefs["texture"], string> = { auto: "Texture: auto", night: "Texture: night", day: "Texture: day" };
const NEXT_TEXTURE: Record<GlobePrefs["texture"], GlobePrefs["texture"]> = { auto: "night", night: "day", day: "auto" };

interface Layers {
  sats: Layer;
  earth: Layer;
  air: Layer;
  veh: Layer;
  track: Layer;
  foot: Layer;
}

export default function GlobeView(props: Props) {
  const { origin, earthRows, sats, aircraft, vehicles, selected, hoverId, track, footprint, unit, dark, prefs, onPrefs } = props;
  const divRef = useRef<HTMLDivElement>(null); // sized wrapper that also holds the overlays
  const mountRef = useRef<HTMLDivElement>(null); // globe.gl wipes and owns this element
  const globeRef = useRef<GlobeT | null>(null);
  const layersRef = useRef<Layers | null>(null);
  const highlightRef = useRef<{ dot: THREE.Mesh; ring: THREE.Mesh } | null>(null);
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
      // No transitions: three-globe's tweens are registered in tween.js's default group, which globe.gl never
      // empties, so every animated data change leaked its objects.
      .pointsTransitionDuration(0)
      .labelsTransitionDuration(0)
      .enablePointerInteraction(false);
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

    const L: Layers = { sats: makeLayer(2.2), earth: makeLayer(1.4), air: makeLayer(2), veh: makeLayer(1.8), track: makeLayer(1, 0.8), foot: makeLayer(0.9, 0.85) };
    const all = Object.values(L);
    const setScale = () => {
      const s = (el.clientHeight * dpr) / 2;
      for (const l of all) l.material.uniforms.uScale.value = s;
    };
    setScale();
    const scene = globe.scene();
    for (const l of all) scene.add(l.points);

    // Selection: a dot at the target's height plus a ring pulsing on the ground below it.
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshBasicMaterial({ color: "#f59e0b" }));
    dot.visible = false;
    const ringMat = new THREE.MeshBasicMaterial({ color: "#f59e0b", transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64), ringMat);
    ring.visible = false;
    ring.onBeforeRender = () => {
      const f = (performance.now() % 1600) / 1600;
      ring.scale.setScalar(0.6 + 4.6 * f);
      ringMat.opacity = 0.85 * (1 - f);
    };
    scene.add(dot, ring);
    layersRef.current = L;
    highlightRef.current = { dot, ring };
    globeRef.current = globe;

    // Picking against the visible point layers, with a tolerance that follows the zoom level.
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const canvas = renderer.domElement;
    const setRay = (ev: PointerEvent | MouseEvent): THREE.Camera => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      const camera = globe.camera() as THREE.Camera;
      raycaster.setFromCamera(mouse, camera);
      return camera;
    };
    const pick = (ev: PointerEvent | MouseEvent): string | null => {
      const camera = setRay(ev);
      const altitude = camera.position.length() - GLOBE_R;
      raycaster.params.Points = { threshold: Math.max(0.25, altitude * 0.006) };
      const ordered = [L.sats, L.air, L.veh, L.earth].filter((l) => l.points.visible && l.count > 0);
      const hits = raycaster.intersectObjects(
        ordered.map((l) => l.points),
        false,
      );
      // Points hidden behind the globe are not pickable: the ray must reach them before the globe's surface.
      const surface = raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), GLOBE_R), new THREE.Vector3());
      const limit = surface ? surface.distanceTo(raycaster.ray.origin) : Infinity;
      for (const h of hits) {
        if (h.distance > limit + 0.5) continue;
        const layer = ordered.find((l) => l.points === h.object);
        if (layer && h.index !== undefined && h.index < layer.count && layer.ids[h.index]) return layer.ids[h.index];
      }
      return null;
    };
    let last = 0;
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
    // A click is a press and release without dragging the globe around in between.
    let down: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => {
      down = { x: ev.clientX, y: ev.clientY };
    };
    const onClick = (ev: MouseEvent) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
      down = null;
      const id = pick(ev);
      if (id) {
        propsRef.current.onSelect(id);
        return;
      }
      if (!propsRef.current.pinOnClick) return;
      setRay(ev);
      const hit = raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), GLOBE_R), new THREE.Vector3());
      if (!hit) return;
      const { lat, lng } = globe.toGeoCoords(hit);
      propsRef.current.onOriginChange(lat, lng);
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
    canvas.addEventListener("pointerdown", onDown);
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
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("webglcontextlost", onLost);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const layer of all) {
        layer.points.geometry.dispose();
        layer.material.dispose();
      }
      dot.geometry.dispose();
      (dot.material as THREE.Material).dispose();
      ring.geometry.dispose();
      ringMat.dispose();
      globe._destructor();
      mount.innerHTML = "";
      globeRef.current = null;
      layersRef.current = null;
      highlightRef.current = null;
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
    L.track.points.visible = prefs.track;
    L.foot.points.visible = prefs.footprint;
    for (const l of Object.values(L)) l.material.uniforms.uSizeMul.value = l.baseSize * prefs.pointSize;
  }, [prefs.sats, prefs.aircraft, prefs.vehicles, prefs.places, prefs.track, prefs.footprint, prefs.pointSize, ready]);

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
      s.size = up ? 1.3 : 1;
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

  // Orbit of the tracked satellite (refreshed once a minute) and the ground it is visible from (every tick).
  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    fillCoords(L.track, track, 400, TRACK, 1);
  }, [track, ready]);

  useEffect(() => {
    const L = layersRef.current;
    if (!L || !ready) return;
    fillCoords(L.foot, footprint, 3, FOOTPRINT, 1);
  }, [footprint, ready]);

  // Selection highlight: moved in place every tick, never rebuilt.
  useEffect(() => {
    const H = highlightRef.current;
    if (!H || !ready) return;
    const lat = selected?.subLat ?? selected?.lat;
    const lng = selected?.subLon ?? selected?.lon;
    if (!selected || lat === undefined || lng === undefined) {
      H.dot.visible = false;
      H.ring.visible = false;
      return;
    }
    const airborne = selected.category === "satellite" || selected.category === "aircraft";
    const p = new Float32Array(3);
    writeCoords(p, 0, lat, lng, airborne ? (selected.heightKm ?? 0) : 5);
    H.dot.position.set(p[0], p[1], p[2]);
    H.dot.visible = true;
    writeCoords(p, 0, lat, lng, 2);
    H.ring.position.set(p[0], p[1], p[2]);
    H.ring.lookAt(0, 0, 0); // lie flat on the ground
    H.ring.visible = true;
  }, [selected, ready]);

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
          <label className="menu-item" title="Orbit of the selected satellite (or the ISS), 45 minutes either side of now">
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
          <i style={{ background: "#1a9bb5" }} /> below
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
