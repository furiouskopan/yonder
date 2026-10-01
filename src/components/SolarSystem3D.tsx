// Interactive solar system on three.js. Planets are textured, lit spheres oriented and spun with the IAU
// rotation model (astronomy-engine RotationAxis), with rim-lit atmospheres, Earth's city lights on its night
// side and Saturn's rings. Each planet has a local system drawn as an inset around it: true scale out to 2.3
// planet radii (rings, low orbits, Phobos), logarithmic beyond, so the Moon, the big moons, Lagrange-point
// observatories, orbiting spacecraft and close flybys all fit in one picture at their real directions. A
// system appears when the camera comes near its planet (Focus does that); spacecraft and flybys inside a system
// stay visible from afar. Earth's system also shows the tracked artificial satellites.
//
// The scene is rebuilt only when the set of bodies, the orbit data, the kind filters or the scale change; the
// once-a-second update writes positions and orientations into existing objects.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import * as A from "astronomy-engine";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Target, Vec3 } from "../types";
import type { OrbitInfo } from "../lib/orbits";
import { conicPath } from "../lib/orbits";
import { KM_PER_AU, formatDistance, type Unit } from "../lib/units";
import { makeTime } from "../lib/astro";
import { SOLAR_KINDS, type SolarKind, type SolarPrefs } from "../hooks/usePrefs";

export interface SolarItem {
  id: string;
  name: string;
  pos: Vec3; // heliocentric ecliptic J2000, AU
  kind: string;
  category: string;
  distanceKm: number;
  orbit?: Vec3[]; // sampled orbit (planets); a new array whenever it is resampled
  hzId?: string; // Horizons id for orbit lookup
  radiusKm?: number;
  system?: string; // the planet whose local system this body is drawn in (moons; nearby spacecraft and flybys)
  rel?: Vec3; // offset from that planet, ecliptic J2000, AU
}

interface Props {
  items: SolarItem[];
  sats: Target[]; // Earth's artificial satellites (sub-point, height, look angles)
  orbits: Map<string, OrbitInfo>;
  selectedId: string | null;
  hoverId: string | null;
  unit: Unit;
  now: number;
  prefs: SolarPrefs;
  onPrefs: (patch: Partial<SolarPrefs>) => void;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

const R_MIN = 0.05;
const R_MAX = 300;
const RADIUS = 110;
const D2R = Math.PI / 180;
const OBLIQUITY = 23.439 * D2R;
const LINEAR_SIZE = 0.12; // True scale: bodies shrink so the Sun and the inner planets no longer overlap
const SUN_R = { log: 2.4, linear: 0.32 };
const INSET_TRUE = 2.3; // planet radii drawn at true scale inside a system inset
const INSET_LOG = 1.2; // display radii per decade beyond that
const SYSTEM_VIEW_RADII = 16; // a system shows when the camera is this many display radii from its planet
const SUN_RADIUS_KM = 695_700;
const OCCLUDED = 1.2; // a body this close to a sphere's centre (in display radii) is drawn in that body's inset

const PLANET_COLORS: Record<string, number> = {
  Mercury: 0x9ca3af, Venus: 0xf5deb3, Earth: 0x3b82f6, Mars: 0xef4444, Jupiter: 0xd4a373,
  Saturn: 0xe9d8a6, Uranus: 0x7dd3fc, Neptune: 0x6366f1, Pluto: 0xa78bfa,
};
const PLANET_RADII_KM: Record<string, number> = { Mercury: 2440, Venus: 6052, Earth: 6371, Mars: 3390, Jupiter: 69911, Saturn: 58232, Uranus: 25362, Neptune: 24622, Pluto: 1188 };
const KIND_COLORS: Record<SolarKind, number> = {
  planet: 0x3b82f6, moon: 0xd1d5db, satellite: 0x22d3ee, probe: 0xec4899, dwarf: 0xf97316, tno: 0xfb923c, centaur: 0xfdba74, asteroid: 0xf59e0b,
  comet: 0x38bdf8, interstellar: 0x22d3ee, neo: 0xef4444,
};
const TEXTURES: Record<string, string> = {
  Sun: "sun", Mercury: "mercury", Venus: "venus_atmosphere", Earth: "earth_daymap", Mars: "mars",
  Jupiter: "jupiter", Saturn: "saturn", Uranus: "uranus", Neptune: "neptune", Moon: "moon",
};
// Rim glow colour, strength and falloff per world.
const ATMOS: Record<string, { color: number; intensity: number; power: number }> = {
  Earth: { color: 0x5aa8ff, intensity: 1.1, power: 2.6 },
  Venus: { color: 0xf5dfae, intensity: 0.8, power: 3.2 },
  Mars: { color: 0xf3b58f, intensity: 0.35, power: 4 },
  Jupiter: { color: 0xecd9b8, intensity: 0.35, power: 4 },
  Saturn: { color: 0xf5e7c0, intensity: 0.3, power: 4 },
  Uranus: { color: 0xa9e7f2, intensity: 0.5, power: 3.4 },
  Neptune: { color: 0x8a9bff, intensity: 0.55, power: 3.4 },
};
// Mean radii of the moons worth sizing and labelling (km); the rest are drawn as small spheres.
const MOON_RADII_KM: Record<string, number> = {
  Moon: 1737, Phobos: 11, Deimos: 6, Io: 1822, Europa: 1561, Ganymede: 2634, Callisto: 2410, Amalthea: 84, Himalia: 70, Thebe: 49,
  Mimas: 198, Enceladus: 252, Tethys: 531, Dione: 561, Rhea: 764, Titan: 2575, Hyperion: 135, Iapetus: 735, Phoebe: 107, Janus: 90,
  Miranda: 236, Ariel: 579, Umbriel: 585, Titania: 789, Oberon: 761, Puck: 81, Triton: 1353, Nereid: 170, Proteus: 210, Larissa: 97,
  Charon: 606, Nix: 25, Hydra: 25,
};
const MOON_COLORS: Record<string, number> = { Io: 0xe8d36a, Europa: 0xe3dccf, Ganymede: 0xb5a58f, Callisto: 0x8c8073, Titan: 0xe0a04a, Enceladus: 0xf3f4f6, Triton: 0xd7c8c0, Charon: 0xb8b0a8 };
const LABELLED_MOONS = new Set(Object.keys(MOON_RADII_KM).filter((n) => MOON_RADII_KM[n] >= 150 || n === "Phobos" || n === "Deimos"));

type Scaler = (v: Vec3, out: THREE.Vector3) => THREE.Vector3;

function makeScaler(mode: SolarPrefs["scale"]): Scaler {
  if (mode === "linear") {
    const k = RADIUS / 35;
    return (v, out) => out.set(v.x * k, v.y * k, v.z * k);
  }
  const l0 = Math.log10(R_MIN);
  const l1 = Math.log10(R_MAX);
  return (v, out) => {
    const r = Math.hypot(v.x, v.y, v.z);
    if (r < 1e-9) return out.set(0, 0, 0);
    const s = (Math.max(0, Math.log10(Math.max(r, R_MIN)) - l0) / (l1 - l0)) * RADIUS;
    const f = s / r;
    return out.set(v.x * f, v.y * f, v.z * f);
  };
}

/** Distance from a planet's centre inside its system inset, in display radii, for a true distance in planet radii. */
export function insetRadii(ratio: number): number {
  return ratio <= INSET_TRUE ? Math.max(1.02, ratio) : INSET_TRUE + INSET_LOG * Math.log10(ratio / INSET_TRUE);
}

const planetDisplayRadius = (radiusKm: number | undefined, mode: SolarPrefs["scale"]): number =>
  (radiusKm ? Math.min(2.6, Math.max(0.9, (Math.log10(radiusKm) - 2.4) * 0.95)) : 1) * (mode === "linear" ? LINEAR_SIZE : 1);

export function kindOf(it: SolarItem): SolarKind {
  if (it.id === "earth" || it.kind === "Planet" || it.kind === "Dwarf planet" || it.kind === "Star") return "planet";
  if (it.kind === "moon" || it.kind === "Moon") return "moon";
  return (it.kind in KIND_COLORS ? it.kind : "asteroid") as SolarKind;
}

// ---- orientation (IAU rotation model) ----
const EQJ_TO_ECL = new THREE.Matrix4().makeRotationX(-OBLIQUITY);
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Vector3();
const _m = new THREE.Vector3();
const _y = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/** Orientation of a body's frame (x = prime meridian, z = north pole) in the ecliptic J2000 scene frame. */
function orient(body: A.Body, time: A.AstroTime, out: THREE.Quaternion): void {
  const ax = A.RotationAxis(body, time);
  const ra = ax.ra * 15 * D2R;
  const dec = ax.dec * D2R;
  const w = ax.spin * D2R;
  _p.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)); // pole, EQJ
  _n.set(-Math.sin(ra), Math.cos(ra), 0); // ascending node of the body's equator on the J2000 equator
  _q.crossVectors(_p, _n);
  _m.copy(_n).multiplyScalar(Math.cos(w)).addScaledVector(_q, Math.sin(w)); // prime meridian
  _y.crossVectors(_p, _m);
  _mat.makeBasis(_m, _y, _p).premultiply(EQJ_TO_ECL);
  out.setFromRotationMatrix(_mat);
}

const BODY_OF: Record<string, A.Body> = {
  Sun: A.Body.Sun, Moon: A.Body.Moon, Mercury: A.Body.Mercury, Venus: A.Body.Venus, Earth: A.Body.Earth, Mars: A.Body.Mars,
  Jupiter: A.Body.Jupiter, Saturn: A.Body.Saturn, Uranus: A.Body.Uranus, Neptune: A.Body.Neptune, Pluto: A.Body.Pluto,
};

function makeLabel(text: string, cls: string): CSS2DObject {
  const div = document.createElement("div");
  div.className = `s3d-label ${cls}`;
  div.textContent = text;
  return new CSS2DObject(div);
}

/** CSS2DRenderer only honours an object's own `visible`, so toggle every label under a group explicitly. */
function setLabelsVisible(root: THREE.Object3D, v: boolean): void {
  root.traverse((o) => {
    if (o instanceof CSS2DObject) o.visible = v;
  });
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

/** Write a polyline (optionally closed) into a position buffer. */
function fillLine(arr: Float32Array, pts: Vec3[], closed: boolean, scale: Scaler): void {
  for (let i = 0; i < pts.length; i++) {
    scale(pts[i], tmp);
    arr[i * 3] = tmp.x;
    arr[i * 3 + 1] = tmp.y;
    arr[i * 3 + 2] = tmp.z;
  }
  if (closed) {
    scale(pts[0], tmp);
    arr[pts.length * 3] = tmp.x;
    arr[pts.length * 3 + 1] = tmp.y;
    arr[pts.length * 3 + 2] = tmp.z;
  }
}

function lineOf(pts: Vec3[], colorHex: number, opacity: number, closed: boolean, scale: Scaler): THREE.Line {
  const arr = new Float32Array((pts.length + (closed ? 1 : 0)) * 3);
  fillLine(arr, pts, closed, scale);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity }));
  line.userData.baseOpacity = opacity;
  return line;
}

// ---- textures (loaded once, shared across rebuilds) ----
const loader = new THREE.TextureLoader();
const texCache = new Map<string, Promise<THREE.Texture>>();
function loadTexture(file: string, base = "/textures/planets/"): Promise<THREE.Texture> {
  const url = base + file;
  let p = texCache.get(url);
  if (!p) {
    p = new Promise<THREE.Texture>((resolve, reject) =>
      loader.load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          resolve(t);
        },
        undefined,
        reject,
      ),
    );
    p.catch(() => texCache.delete(url));
    texCache.set(url, p);
  }
  return p;
}

let glowTexture: THREE.CanvasTexture | null = null;
function sunGlow(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255, 236, 170, 1)");
  g.addColorStop(0.2, "rgba(255, 200, 80, 0.55)");
  g.addColorStop(0.5, "rgba(255, 150, 40, 0.16)");
  g.addColorStop(1, "rgba(255, 120, 20, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

/** Ring geometry whose texture coordinate runs radially, so a 1-D ring strip maps correctly. */
function ringGeometry(inner: number, outer: number): THREE.RingGeometry {
  const geom = new THREE.RingGeometry(inner, outer, 128, 1);
  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const uv = geom.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }
  uv.needsUpdate = true;
  return geom;
}

const ATMOSPHERE_SCALE = 1.12;

/**
 * Atmospheric halo: the back faces of a slightly larger shell, brightest just outside the planet's limb and
 * fading to nothing at the shell's edge (a front-face rim term instead peaks at the shell's own silhouette and
 * reads as a hard band), and brighter on the side lit by the Sun at the origin.
 */
function atmosphere(r: number, spec: { color: number; intensity: number; power: number }): THREE.Mesh {
  const limb = Math.sqrt(1 - 1 / (ATMOSPHERE_SCALE * ATMOSPHERE_SCALE)); // -dot(N, V) on the shell's far side behind the planet's limb
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(spec.color) }, uIntensity: { value: spec.intensity }, uPower: { value: Math.max(1.2, spec.power * 0.6) }, uLimb: { value: limb } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vNW; varying vec3 vPW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPW = wp.xyz;
        vNW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * wp;
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    // colorspace_fragment converts the linear colour to the canvas's sRGB output, as the built-in materials do.
    fragmentShader: `
      uniform vec3 uColor; uniform float uIntensity; uniform float uPower; uniform float uLimb;
      varying vec3 vN; varying vec3 vV; varying vec3 vNW; varying vec3 vPW;
      void main() {
        float t = clamp(-dot(normalize(vN), normalize(vV)) / uLimb, 0.0, 1.0);
        float day = 0.25 + 0.75 * smoothstep(-0.35, 0.45, dot(normalize(vNW), normalize(-vPW)));
        gl_FragColor = vec4(uColor, pow(t, uPower) * uIntensity * day);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r * ATMOSPHERE_SCALE, 48, 32), mat);
  mesh.renderOrder = 2;
  return mesh;
}

/** Earth: city lights only where the Sun (at the scene origin) does not shine. */
function nightLights(mat: THREE.MeshStandardMaterial, tex: THREE.Texture): void {
  mat.emissiveMap = tex;
  mat.emissive.set(0xffffff);
  mat.emissiveIntensity = 1.0;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;").replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        vec3 toSunView = normalize((viewMatrix * vec4(-vWorldPos, 0.0)).xyz);
        float dayside = dot(normalize(normal), toSunView);
        totalEmissiveRadiance *= (1.0 - smoothstep(-0.08, 0.18, dayside));`,
      );
  };
  mat.needsUpdate = true;
}

/** A sphere whose texture's poles lie along the parent's +z and whose prime meridian lies along +x. */
function texturedSphere(r: number, colorHex: number, name: string, onLoad: () => void, segments = 48): { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial } {
  const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, segments, Math.round(segments * 0.67)), mat);
  mesh.rotation.x = Math.PI / 2;
  const file = TEXTURES[name];
  if (file) {
    loadTexture(`${file}.jpg`)
      .then((t) => {
        mat.map = t;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
        onLoad();
      })
      .catch((e: unknown) => console.warn(`[solar] texture ${file}.jpg failed`, e));
  }
  return { mesh, mat };
}

/** Per-body handles into the scene so positions can be updated without rebuilding anything. */
interface Handle {
  kind: SolarKind;
  name: string;
  root?: THREE.Object3D; // positioned group (planets, the Moon)
  body?: THREE.Object3D; // oriented with the IAU rotation model every tick
  bodyEnum?: A.Body;
  mesh?: THREE.Mesh;
  label?: CSS2DObject;
  orbitLine?: THREE.Line;
  orbitSrc?: Vec3[];
  point?: number; // index into the small-body point cloud
  marker?: number; // index into the planet-marker cloud
  radius: number; // display radius
  system?: PlanetSystem; // moons, and bodies currently inside a planet's system
  instance?: number; // index in the system's instanced moon mesh
  inSystem?: boolean; // the body was drawn inside a planet's system on the last tick
  insetOf?: string; // which body's inset it was drawn in (a planet, or the Sun)
  hzId?: string; // Horizons id, for the orbit line
}

interface PlanetSystem {
  name: string;
  planetId: string;
  group: THREE.Group; // positioned at the planet; visible while the camera is near
  radius: number; // the planet's display radius
  radiusKm: number;
  moons: THREE.InstancedMesh | null;
  moonIds: string[];
  sats: THREE.Points | null; // Earth only
  satIds: string[];
  satCapacity: number;
  labels: CSS2DObject[]; // moon labels (they live in the label scene, not in the group)
  shown: boolean;
}

interface Scene {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  smallLineGroup: THREE.Group; // orbit and trajectory lines of small bodies, rebuilt on their own
  labelScene: THREE.Scene; // only CSS2D labels: the label renderer walks this small scene, not the 3D content
  labelGroup: THREE.Group;
  moonLabelGroup: THREE.Group;
  overlay: THREE.Group;
  skybox: THREE.Mesh;
  stars: THREE.Points;
  sun: THREE.Mesh;
  sunBody: THREE.Group;
  glow: THREE.Sprite;
  sunR: number;
  pickables: THREE.Object3D[];
  small: THREE.Points | null;
  markers: THREE.Points | null;
  atmospheres: THREE.Object3D[];
  planetOrbits: THREE.Line[];
  handles: Map<string, Handle>;
  positions: Map<string, THREE.Vector3>;
  lines: Map<string, THREE.Line>;
  smallLines: Set<string>; // ids whose orbit line is only shown on demand
  systems: Map<string, PlanetSystem>;
  highlight: THREE.Mesh;
  highlightR: number; // display radius of the selected body (0 for points)
  hoverLabel: CSS2DObject;
  hoverHit: { id: string; point: THREE.Vector3 } | null;
  hoveredLine: THREE.Line | null;
  selectedLine: THREE.Line | null;
  dirty: boolean;
  raf: number;
}

const setLineOpacity = (line: THREE.Line | null, factor: number) => {
  if (!line) return;
  const m = line.material as THREE.LineBasicMaterial;
  m.opacity = Math.min(1, (line.userData.baseOpacity as number) * factor);
};

const MOON_GEOMETRY = new THREE.SphereGeometry(1, 20, 14);
const _inst = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const SAT_UP = new THREE.Color(0x22d3ee);
const SAT_DOWN = new THREE.Color(0x1a9bb5);

/** Offset of a body inside a planet's system inset, in scene units, from its true offset in AU. */
function insetOffset(sys: PlanetSystem, rel: Vec3, out: THREE.Vector3): THREE.Vector3 {
  const dist = Math.hypot(rel.x, rel.y, rel.z);
  if (dist <= 0) return out.set(0, 0, 0);
  const ratio = (dist * KM_PER_AU) / sys.radiusKm;
  return out.set(rel.x, rel.y, rel.z).multiplyScalar((insetRadii(ratio) * sys.radius) / dist);
}

/** Write Earth's artificial satellites into the Earth system's point cloud (only while that system is shown). */
function updateSatellites(sys: PlanetSystem, sats: Target[], earthQuat: THREE.Quaternion): void {
  if (!sys.sats) return;
  let n = 0;
  for (const t of sats) if (t.subLat !== undefined && t.subLon !== undefined && t.heightKm !== undefined && Number.isFinite(t.heightKm)) n++;
  const geom = sys.sats.geometry;
  if (n > sys.satCapacity) {
    // Grow, never shrink; disposing first frees the GPU copies of the old buffers.
    const cap = Math.max(256, Math.ceil(n * 1.3));
    geom.dispose();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    sys.satCapacity = cap;
  }
  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const col = geom.getAttribute("color") as THREE.BufferAttribute;
  const pa = pos.array as Float32Array;
  const ca = col.array as Float32Array;
  let i = 0;
  sys.satIds.length = 0;
  for (const t of sats) {
    if (t.subLat === undefined || t.subLon === undefined || t.heightKm === undefined || !Number.isFinite(t.heightKm)) continue;
    const la = t.subLat * D2R;
    const lo = t.subLon * D2R;
    tmp.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).applyQuaternion(earthQuat);
    tmp.multiplyScalar(insetRadii(1 + t.heightKm / sys.radiusKm) * sys.radius);
    pa[i * 3] = tmp.x;
    pa[i * 3 + 1] = tmp.y;
    pa[i * 3 + 2] = tmp.z;
    const c = (t.altDeg ?? -1) >= 0 ? SAT_UP : SAT_DOWN;
    ca[i * 3] = c.r;
    ca[i * 3 + 1] = c.g;
    ca[i * 3 + 2] = c.b;
    sys.satIds[i] = t.id;
    i++;
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geom.setDrawRange(0, i);
}

export default function SolarSystem3D({ items, sats, orbits, selectedId, hoverId, unit, now, prefs, onPrefs, onSelect, onHover }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null); // sized wrapper that also holds the overlays
  const mountRef = useRef<HTMLDivElement>(null); // the renderer's canvas and label layer live here
  const sceneRef = useRef<Scene | null>(null);
  const propsRef = useRef({ items, sats, onSelect, onHover, unit, prefs, selectedId, hoverId, now });
  propsRef.current = { items, sats, onSelect, onHover, unit, prefs, selectedId, hoverId, now };
  const earthQuatRef = useRef(new THREE.Quaternion());
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const kindsKey = SOLAR_KINDS.map((k) => (prefs.kinds[k.id] ? "1" : "0")).join("");
  // The scene structure depends only on which bodies exist (and which are shown), not on where they are.
  const structureKey = useMemo(() => items.map((i) => i.id).join("\n"), [items]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(SOLAR_KINDS.map((k) => [k.id, 0])) as Record<SolarKind, number>;
    for (const it of items) if (it.id !== "sol-Sun") c[kindOf(it)]++;
    c.satellite = sats.length;
    return c;
  }, [items, sats.length]);

  // Scene setup (again after a lost context).
  useEffect(() => {
    const el = wrapRef.current;
    const mount = mountRef.current;
    if (!el || !mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.domElement.className = "s3d-canvas";
    mount.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.setSize(el.clientWidth, el.clientHeight);
    labels.domElement.className = "s3d-labels";
    mount.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(1, el.clientHeight), 0.01, 6000);
    camera.up.set(0, 0, 1);
    camera.position.set(150, -190, 120);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.15;
    controls.maxDistance = 1500;
    controls.zoomSpeed = 0.9;
    controls.zoomToCursor = true;

    // Milky Way behind everything (falls back to a plain star field until the texture arrives).
    const skybox = new THREE.Mesh(new THREE.SphereGeometry(2500, 48, 32), new THREE.MeshBasicMaterial({ color: 0x8b93a7, side: THREE.BackSide, depthWrite: false }));
    skybox.rotation.x = -OBLIQUITY; // the panorama is in equatorial coordinates
    skybox.visible = false;
    scene.add(skybox);
    loadTexture("stars_milky_way.jpg")
      .then((t) => {
        const m = skybox.material as THREE.MeshBasicMaterial;
        m.map = t;
        m.color.set(0xb8bfd0);
        m.needsUpdate = true;
        S.dirty = true;
      })
      .catch(() => {});
    const starGeom = new THREE.BufferGeometry();
    const starPos = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      starPos[i * 3] = 2000 * s * Math.cos(th);
      starPos[i * 3 + 1] = 2000 * s * Math.sin(th);
      starPos[i * 3 + 2] = 2000 * u;
    }
    starGeom.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeom, new THREE.PointsMaterial({ color: 0x94a3b8, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.6 }));
    scene.add(stars);

    // Sun: textured sphere (oriented and spun like the planets) plus an additive glow sprite; lights everything else.
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffd36e });
    const sun = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), sunMat);
    sun.rotation.x = Math.PI / 2;
    sun.userData.id = "sol-Sun";
    const sunBody = new THREE.Group();
    sunBody.add(sun);
    scene.add(sunBody);
    loadTexture("sun.jpg")
      .then((t) => {
        sunMat.map = t;
        sunMat.color.set(0xffffff);
        sunMat.needsUpdate = true;
        S.dirty = true;
      })
      .catch(() => {});
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlow(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    scene.add(glow);
    const labelScene = new THREE.Scene();
    labelScene.add(makeLabel("Sun", "planet"));
    scene.add(new THREE.PointLight(0xfff4e0, 2.4, 0, 0));
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));

    const content = new THREE.Group();
    const smallLineGroup = new THREE.Group();
    const labelGroup = new THREE.Group();
    const moonLabelGroup = new THREE.Group();
    const overlay = new THREE.Group();
    scene.add(content, smallLineGroup, overlay);
    labelScene.add(labelGroup, moonLabelGroup);
    // Selection ring: a camera-facing quad whose shader draws a ring about 2 px wide at any size.
    const highlight = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0xf59e0b) }, uOpacity: { value: 0.9 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
          void main() {
            float d = length(vUv - 0.5) * 2.0;
            float w = fwidth(d);
            float ring = smoothstep(1.0 - 3.0 * w, 1.0 - 2.0 * w, d) * (1.0 - smoothstep(1.0 - w, 1.0, d));
            if (ring <= 0.0) discard;
            gl_FragColor = vec4(uColor, ring * uOpacity);
            #include <colorspace_fragment>
          }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    highlight.renderOrder = 5;
    highlight.visible = false;
    overlay.add(highlight);
    const hoverLabel = makeLabel("", "hover");
    hoverLabel.visible = false;
    labelScene.add(hoverLabel);

    const S: Scene = {
      renderer, labels, scene, camera, controls, content, smallLineGroup, labelScene, labelGroup, moonLabelGroup, overlay, skybox, stars, sun, sunBody, glow, sunR: SUN_R.log,
      pickables: [], small: null, markers: null, atmospheres: [], planetOrbits: [],
      handles: new Map(), positions: new Map(), lines: new Map(), smallLines: new Set(), systems: new Map(),
      highlight, highlightR: 0, hoverLabel, hoverHit: null, hoveredLine: null, selectedLine: null, dirty: true, raf: 0,
    };
    sceneRef.current = S;
    // Headless checks (`?debug`) can inspect the scene.
    if (new URLSearchParams(window.location.search).has("debug")) (window as unknown as { __solar?: Scene }).__solar = S;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const pick = (ev: MouseEvent): { id: string; point: THREE.Vector3 } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      // Tolerance follows the zoom: a few pixels whether you look at the whole system or one moon.
      const d = camera.position.distanceTo(controls.target);
      raycaster.params.Points = { threshold: Math.max(0.004, d * 0.011) };
      raycaster.params.Line = { threshold: Math.max(0.003, d * 0.0055) };
      // three.js raycasts invisible objects too, so filter by visibility (including a hidden planet system).
      const candidates = S.pickables.filter((o) => o.visible && (!(o.userData.group as THREE.Object3D | undefined) || (o.userData.group as THREE.Object3D).visible));
      const hits = raycaster.intersectObjects(candidates, false);
      // Bodies win over orbit lines when both are under the cursor.
      let lineHit: { id: string; point: THREE.Vector3 } | null = null;
      for (const h of hits) {
        const o = h.object;
        if (o instanceof THREE.Points) {
          const ids = o.userData.ids as string[] | undefined;
          if (h.index !== undefined && ids?.[h.index]) return { id: ids[h.index], point: h.point };
        } else if (o instanceof THREE.InstancedMesh) {
          const ids = o.userData.ids as string[] | undefined;
          if (h.instanceId !== undefined && ids?.[h.instanceId]) return { id: ids[h.instanceId], point: h.point };
        } else if (o instanceof THREE.Line) {
          if (!lineHit && o.userData.id) lineHit = { id: o.userData.id as string, point: h.point };
        } else if (o.userData.id) return { id: o.userData.id as string, point: h.point };
      }
      return lineHit;
    };
    let last = 0;
    const onMove = (ev: PointerEvent) => {
      const t = performance.now();
      if (t - last < 50 || ev.buttons) return;
      last = t;
      const hit = pick(ev);
      S.hoverHit = hit;
      propsRef.current.onHover(hit?.id ?? null);
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => {
      down = { x: ev.clientX, y: ev.clientY };
    };
    const onClick = (ev: MouseEvent) => {
      if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return; // that was a drag
      const hit = pick(ev);
      if (hit) propsRef.current.onSelect(hit.id);
    };
    const onLeave = () => {
      S.hoverHit = null;
      propsRef.current.onHover(null);
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      setLost(true);
    };
    // Wheel zoom (and keyboard panning) is applied inside OrbitControls' own event handlers, so the render
    // loop's controls.update() reports no movement afterwards: without this the zoom showed only at the next
    // one-second tick.
    const onControlsChange = () => {
      S.dirty = true;
    };
    controls.addEventListener("change", onControlsChange);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("pointerleave", onLeave);
    renderer.domElement.addEventListener("webglcontextlost", onLost);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      S.dirty = true;
    });
    ro.observe(el);

    const pxToWorld = (px: number, at: THREE.Vector3): number => (px * 2 * camera.position.distanceTo(at) * Math.tan((camera.fov * D2R) / 2)) / Math.max(1, el.clientHeight);

    const loop = () => {
      S.raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const moved = controls.update();
      if (moved || S.dirty) {
        // Show one planet system: the selected body's, if the camera is near it (in 2026 Saturn and Neptune line up
        // on the compressed scale, so "nearest" alone can pick the wrong one), otherwise the nearest to the camera,
        // measured in its planet's display radii.
        const selId = propsRef.current.selectedId;
        const selH = selId ? S.handles.get(selId) : undefined;
        const selSys = selId?.startsWith("sat-")
          ? S.systems.get("Earth")
          : selH
            ? selH.kind === "planet"
              ? S.systems.get(selH.name)
              : (selH.system ?? (selH.insetOf ? S.systems.get(selH.insetOf) : undefined))
            : undefined;
        let best: PlanetSystem | null = null;
        if (selSys && camera.position.distanceTo(selSys.group.position) / selSys.radius < SYSTEM_VIEW_RADII) best = selSys;
        else {
          let bestQ = SYSTEM_VIEW_RADII;
          for (const sys of S.systems.values()) {
            const q = camera.position.distanceTo(sys.group.position) / sys.radius;
            if (q < bestQ) {
              bestQ = q;
              best = sys;
            }
          }
        }
        for (const sys of S.systems.values()) {
          const show = sys === best;
          if (show !== sys.shown) {
            sys.shown = show;
            sys.group.visible = show;
            for (const l of sys.labels) l.visible = show && propsRef.current.prefs.labels;
            if (show && sys.sats) updateSatellites(sys, propsRef.current.prefs.kinds.satellite ? propsRef.current.sats : [], earthQuatRef.current);
          }
        }
        S.dirty = false;
        S.glow.scale.setScalar(Math.max(8, Math.min(40, camera.position.length() * 0.08)) * (S.sunR / SUN_R.log));
        // The selection ring faces the camera and never shrinks below a few pixels.
        if (S.highlight.visible) {
          S.highlight.quaternion.copy(camera.quaternion);
          S.highlight.scale.setScalar(Math.max(S.highlightR * 1.3, pxToWorld(10, S.highlight.position)));
        }
        renderer.render(scene, camera);
        labels.render(S.labelScene, camera);
      }
    };
    loop();
    setLost(false);
    setReady(true);

    return () => {
      cancelAnimationFrame(S.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      controls.removeEventListener("change", onControlsChange);
      controls.dispose();
      renderer.dispose();
      mount.innerHTML = "";
      sceneRef.current = null;
      setReady(false);
    };
  }, [epoch]);

  // Background and label visibility toggles.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    S.skybox.visible = prefs.skybox;
    S.stars.visible = !prefs.skybox;
    S.labelGroup.visible = prefs.labels;
    setLabelsVisible(S.labelGroup, prefs.labels);
    for (const sys of S.systems.values()) for (const l of sys.labels) l.visible = prefs.labels && sys.shown;
    S.dirty = true;
  }, [prefs.skybox, prefs.labels, ready]);

  // Build the scene content when the set of bodies, the orbit data, the filters or the scale changes.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    const mode = prefs.scale;
    const scale = makeScaler(mode);
    const disposeChildren = (g: THREE.Group) => {
      for (const child of [...g.children]) {
        g.remove(child);
        child.traverse((o) => {
          const obj = o as THREE.Mesh | THREE.Line | THREE.Points;
          if ("geometry" in obj && obj.geometry && obj.geometry !== MOON_GEOMETRY) obj.geometry.dispose();
          if ("material" in obj && obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
          if (o instanceof THREE.InstancedMesh) o.dispose();
          if (o instanceof CSS2DObject) o.element.remove();
        });
      }
    };
    disposeChildren(S.content);
    disposeChildren(S.labelGroup);
    disposeChildren(S.moonLabelGroup);
    S.pickables = [];
    S.handles.clear();
    S.positions.clear();
    S.lines.clear();
    S.smallLines.clear();
    S.systems.clear();
    S.atmospheres = [];
    S.planetOrbits = [];
    S.small = null;
    S.markers = null;
    S.hoveredLine = null;
    S.selectedLine = null;

    S.sunR = SUN_R[mode];
    S.sun.scale.setScalar(S.sunR);
    // The Sun is part of the fixed scene, but selectable and focusable like any body.
    S.positions.set("sol-Sun", new THREE.Vector3());
    S.handles.set("sol-Sun", { kind: "planet", name: "Sun", radius: S.sunR });
    S.pickables.push(S.sun);

    // Reference rings at 1, 10 and 100 AU
    for (const au of [1, 10, 100]) {
      const pts: Vec3[] = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        pts.push({ x: au * Math.cos(a), y: au * Math.sin(a), z: 0 });
      }
      S.content.add(lineOf(pts, 0x334155, 0.5, false, scale));
      const lbl = makeLabel(`${au} AU`, "ring");
      scale({ x: au * Math.SQRT1_2, y: au * Math.SQRT1_2, z: 0 }, lbl.position);
      S.labelGroup.add(lbl);
    }

    const current = propsRef.current.items;
    const planets: SolarItem[] = [];
    const moons: SolarItem[] = [];
    const rest: SolarItem[] = [];
    for (const it of current) {
      if (it.id === "sol-Sun") continue;
      const k = kindOf(it);
      (k === "planet" ? planets : k === "moon" ? moons : rest).push(it);
    }

    // ---- planets, their markers and their systems ----
    const markerIds: string[] = [];
    const markerCol: number[] = [];
    if (prefs.kinds.planet) {
      for (const it of planets) {
        const r = planetDisplayRadius(it.radiusKm ?? PLANET_RADII_KM[it.name], mode);
        const h: Handle = { kind: "planet", name: it.name, radius: r, bodyEnum: BODY_OF[it.name] };
        const root = new THREE.Group();
        const body = new THREE.Group();
        root.add(body);
        const { mesh, mat } = texturedSphere(r, PLANET_COLORS[it.name] ?? 0xe5e7eb, it.name, () => (S.dirty = true));
        mesh.userData.id = it.id;
        body.add(mesh);
        if (it.id === "earth") {
          loadTexture("earth-night.jpg", "/textures/")
            .then((t) => {
              nightLights(mat, t);
              S.dirty = true;
            })
            .catch(() => {});
        }
        const atm = ATMOS[it.name];
        if (atm) {
          const a = atmosphere(r, atm);
          a.visible = prefs.atmospheres;
          root.add(a);
          S.atmospheres.push(a);
        }
        if (it.name === "Saturn") {
          // Main rings, 1.11 to 2.27 Saturn radii, in the equatorial plane (inside the inset's true-scale zone).
          const ringMat = new THREE.MeshBasicMaterial({ color: 0xd9c9a3, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false });
          const ring = new THREE.Mesh(ringGeometry(r * 1.11, r * 2.27), ringMat);
          ring.userData.id = it.id;
          body.add(ring);
          S.pickables.push(ring);
          loadTexture("saturn_ring_alpha.png")
            .then((t) => {
              ringMat.map = t;
              ringMat.alphaMap = t;
              ringMat.color.set(0xffffff);
              ringMat.needsUpdate = true;
              S.dirty = true;
            })
            .catch(() => {});
        }
        h.root = root;
        h.body = body;
        h.mesh = mesh;
        S.content.add(root);
        S.pickables.push(mesh);
        h.label = makeLabel(it.id === "earth" ? "Earth (you are here)" : it.name, "planet");
        S.labelGroup.add(h.label);
        if (it.orbit) {
          h.orbitLine = lineOf(it.orbit, PLANET_COLORS[it.name] ?? 0x64748b, 0.45, true, scale);
          h.orbitLine.userData.id = it.id;
          h.orbitLine.visible = prefs.orbits;
          h.orbitSrc = it.orbit;
          S.content.add(h.orbitLine);
          S.pickables.push(h.orbitLine);
          S.lines.set(it.id, h.orbitLine);
          S.planetOrbits.push(h.orbitLine);
        }
        h.marker = markerIds.length;
        markerIds.push(it.id);
        _col.setHex(PLANET_COLORS[it.name] ?? 0xe5e7eb);
        markerCol.push(_col.r, _col.g, _col.b);
        S.handles.set(it.id, h);

        const group = new THREE.Group();
        group.visible = false;
        S.content.add(group);
        const sys: PlanetSystem = {
          name: it.name, planetId: it.id, group, radius: r, radiusKm: PLANET_RADII_KM[it.name] ?? it.radiusKm ?? 6371,
          moons: null, moonIds: [], sats: null, satIds: [], satCapacity: 0, labels: [], shown: false,
        };
        S.systems.set(it.name, sys);
      }
    }
    if (markerIds.length) {
      // Planet markers: a few pixels wide at any distance, so a planet never vanishes when its sphere is tiny
      // (True scale, or zoomed far out). Hidden behind the sphere itself when the sphere is larger.
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(markerIds.length * 3), 3));
      geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(markerCol), 3));
      const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 6, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false }));
      pts.frustumCulled = false;
      pts.userData.ids = markerIds;
      S.content.add(pts);
      S.pickables.push(pts);
      S.markers = pts;
    }

    // ---- moons: one instanced mesh per system; Earth's Moon is a textured sphere of its own ----
    if (prefs.kinds.moon) {
      const bySystem = new Map<string, SolarItem[]>();
      for (const it of moons) {
        if (!it.system || !S.systems.has(it.system)) continue;
        const list = bySystem.get(it.system) ?? [];
        list.push(it);
        bySystem.set(it.system, list);
      }
      for (const [name, list] of bySystem) {
        const sys = S.systems.get(name)!;
        const instanced = list.filter((it) => it.name !== "Moon");
        for (const it of list.filter((m) => m.name === "Moon")) {
          // The Moon: real size relative to Earth (0.27), textured, tidally locked through its IAU orientation.
          const r = sys.radius * (1737 / sys.radiusKm);
          const root = new THREE.Group();
          const body = new THREE.Group();
          root.add(body);
          const { mesh } = texturedSphere(r, 0xc9c9c9, "Moon", () => (S.dirty = true), 32);
          mesh.userData.id = it.id;
          mesh.userData.group = sys.group;
          body.add(mesh);
          sys.group.add(root);
          S.pickables.push(mesh);
          const h: Handle = { kind: "moon", name: it.name, radius: r, root, body, bodyEnum: A.Body.Moon, mesh, system: sys };
          h.label = makeLabel(it.name, "moon");
          h.label.visible = false;
          S.moonLabelGroup.add(h.label);
          sys.labels.push(h.label);
          S.handles.set(it.id, h);
        }
        if (!instanced.length) continue;
        const mesh = new THREE.InstancedMesh(MOON_GEOMETRY, new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }), instanced.length);
        mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), sys.radius * 8);
        mesh.userData.ids = sys.moonIds;
        mesh.userData.group = sys.group;
        instanced.forEach((it, i) => {
          const known = MOON_RADII_KM[it.name];
          const r = sys.radius * Math.min(0.55, Math.max(known ? 0.03 : 0.018, (known ?? 0) / sys.radiusKm));
          sys.moonIds.push(it.id);
          _col.setHex(MOON_COLORS[it.name] ?? (known ? 0xd1d5db : 0x9ca3af));
          mesh.setColorAt(i, _col);
          _inst.makeScale(0, 0, 0);
          mesh.setMatrixAt(i, _inst);
          const h: Handle = { kind: "moon", name: it.name, radius: r, system: sys, instance: i };
          if (LABELLED_MOONS.has(it.name)) {
            h.label = makeLabel(it.name, "moon");
            h.label.visible = false;
            S.moonLabelGroup.add(h.label);
            sys.labels.push(h.label);
          }
          S.handles.set(it.id, h);
        });
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        sys.group.add(mesh);
        sys.moons = mesh;
        S.pickables.push(mesh);
      }
    }

    // ---- Earth's artificial satellites (filled in while Earth's system is shown) ----
    const earthSys = S.systems.get("Earth");
    if (earthSys && prefs.kinds.satellite) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
      geom.setDrawRange(0, 0);
      geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), earthSys.radius * 8);
      const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 2.5, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false }));
      pts.frustumCulled = false;
      pts.userData.ids = earthSys.satIds;
      pts.userData.group = earthSys.group;
      earthSys.group.add(pts);
      earthSys.sats = pts;
      S.pickables.push(pts);
    }

    // ---- everything else: one point cloud (their orbit lines are built by the next effect) ----
    const smallIds: string[] = [];
    const smallCol: number[] = [];
    for (const it of rest) {
      const kind = kindOf(it);
      if (!prefs.kinds[kind]) continue;
      const h: Handle = { kind, name: it.name, radius: 0, point: smallIds.length, hzId: it.hzId };
      smallIds.push(it.id);
      _col.setHex(KIND_COLORS[kind]);
      smallCol.push(_col.r, _col.g, _col.b);
      S.handles.set(it.id, h);
    }
    if (smallIds.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(smallIds.length * 3), 3));
      geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(smallCol), 3));
      const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 3, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false }));
      pts.frustumCulled = false;
      pts.userData.ids = smallIds;
      S.content.add(pts);
      S.pickables.unshift(pts);
      S.small = pts;
    }
    setLabelsVisible(S.labelGroup, prefs.labels);

    // Place everything for the current tick before compiling, then compile every material once (including
    // the hidden planet systems) so nothing compiles mid-zoom when a system first comes into view.
    positionAll(S, propsRef.current.items, propsRef.current.now, mode, earthQuatRef.current);
    const hidden = [...S.systems.values()].filter((s) => !s.group.visible);
    for (const s of hidden) s.group.visible = true;
    try {
      S.renderer.compile(S.scene, S.camera);
    } catch {
      /* compile is an optimisation only */
    }
    for (const s of hidden) {
      s.group.visible = false;
      s.shown = false;
    }
    S.dirty = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, prefs.scale, kindsKey, ready]);

  // Orbit and trajectory lines of the small bodies, in their own group: new orbit data (they arrive one by one
  // while the server fills its cache) only rebuilds these lines, never the planets, moons and labels.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    const scale = makeScaler(prefs.scale);
    for (const child of [...S.smallLineGroup.children]) {
      S.smallLineGroup.remove(child);
      const l = child as THREE.Line;
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    S.pickables = S.pickables.filter((o) => !o.userData.smallLine);
    for (const id of S.smallLines) S.lines.delete(id);
    S.smallLines.clear();
    if (S.hoveredLine?.userData.smallLine) S.hoveredLine = null;
    if (S.selectedLine?.userData.smallLine) S.selectedLine = null;
    for (const [id, h] of S.handles) {
      if (h.point === undefined || !h.hzId) continue;
      h.orbitLine = undefined;
      const o = orbits.get(h.hzId);
      let line: THREE.Line | null = null;
      if (o?.elements) {
        const el = o.elements;
        const path = conicPath(el, h.kind === "interstellar" || h.kind === "comet" ? 320 : 160);
        // Close only a complete ellipse: an orbit reaching beyond 300 AU (Sedna) is cut there, and closing it would draw a chord.
        const complete = el.e < 1 && (el.q * (1 + el.e)) / (1 - el.e) <= 300;
        if (path.length > 2) line = lineOf(path, KIND_COLORS[h.kind], h.kind === "asteroid" || h.kind === "neo" ? 0.16 : 0.34, complete, scale);
      } else if (o?.trail) {
        const pts = o.trail.rows.map((r) => ({ x: r[0], y: r[1], z: r[2] }));
        if (pts.length > 1) line = lineOf(pts, KIND_COLORS.probe, 0.45, false, scale);
      }
      if (!line) continue;
      line.userData.id = id;
      line.userData.smallLine = true;
      line.userData.trail = !!(o?.trail && !o.elements);
      line.visible = false;
      S.smallLineGroup.add(line);
      S.pickables.push(line);
      S.lines.set(id, line);
      S.smallLines.add(id);
      h.orbitLine = line;
    }
    S.dirty = true;
  }, [orbits, structureKey, prefs.scale, kindsKey, ready]);

  // Following is tied to the body it was started for.
  useEffect(() => {
    setFollow(false);
  }, [selectedId]);

  // Cheap toggles: no rebuild.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    for (const a of S.atmospheres) a.visible = prefs.atmospheres;
    for (const l of S.planetOrbits) l.visible = prefs.orbits;
    S.dirty = true;
  }, [prefs.atmospheres, prefs.orbits, structureKey, orbits, prefs.scale, kindsKey, ready]);

  // Small-body orbits and spacecraft trails show on demand (hovered or selected) unless switched on for all.
  // A body drawn inside a planet's system has no line: its heliocentric path would only trace the planet's.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    for (const id of S.smallLines) {
      const line = S.lines.get(id);
      if (!line) continue;
      const always = line.userData.trail ? prefs.trails : prefs.smallOrbits;
      line.visible = (always || id === selectedId || id === hoverId) && !S.handles.get(id)?.inSystem;
    }
    S.dirty = true;
  }, [prefs.smallOrbits, prefs.trails, selectedId, hoverId, structureKey, orbits, kindsKey, prefs.scale, ready, now]);

  // Move everything to its current position and orientation (every tick). Writes into existing objects only.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    positionAll(S, items, now, prefs.scale, earthQuatRef.current);
    const earthSys = S.systems.get("Earth");
    if (earthSys?.shown) updateSatellites(earthSys, prefs.kinds.satellite ? sats : [], earthQuatRef.current);
    // Follow: keep the selected body under the camera as it moves.
    if (follow && selectedId) {
      const p = S.positions.get(selectedId);
      if (p) {
        tmp.subVectors(p, S.controls.target);
        S.camera.position.add(tmp);
        S.controls.target.copy(p);
      }
    }
    S.dirty = true;
  }, [items, sats, now, prefs.scale, prefs.kinds.satellite, follow, selectedId, ready]);

  // Highlight the selected body (and its orbit) and label the hovered body or orbit.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    setLineOpacity(S.selectedLine, 1);
    S.selectedLine = (selectedId && S.lines.get(selectedId)) || null;
    setLineOpacity(S.selectedLine, 3);
    const sel = selectedId ? positionOf(S, selectedId) : undefined;
    if (sel) {
      S.highlight.position.copy(sel);
      S.highlightR = selectedId ? (S.handles.get(selectedId)?.radius ?? 0) : 0;
      S.highlight.visible = true;
    } else S.highlight.visible = false;

    setLineOpacity(S.hoveredLine, 1);
    S.hoveredLine = null;
    const it = hoverId ? propsRef.current.items.find((i) => i.id === hoverId) : undefined;
    const sat = hoverId && !it && hoverId.startsWith("sat-") ? sats.find((t) => t.id === hoverId) : undefined;
    const hitIsLine = !!(hoverId && S.hoverHit?.id === hoverId && S.lines.has(hoverId) && !S.handles.get(hoverId)?.mesh && S.hoverHit.point);
    const pos = hoverId ? (hitIsLine && S.hoverHit ? S.hoverHit.point : positionOf(S, hoverId)) : undefined;
    if ((it || sat) && pos) {
      if (it && S.lines.has(it.id)) {
        S.hoveredLine = S.lines.get(it.id) ?? null;
        setLineOpacity(S.hoveredLine, 3);
      }
      let what = "satellite";
      let dist = sat?.distanceKm ?? NaN;
      if (it) {
        const kind = kindOf(it);
        what = hitIsLine
          ? kind === "probe"
            ? "trajectory"
            : "orbit"
          : it.kind === "Star"
            ? "star"
            : kind === "moon"
              ? `moon of ${it.system ?? "?"}`
              : `${SOLAR_KINDS.find((k) => k.id === kind)?.label.replace(/s$/, "").toLowerCase() ?? ""}${kind !== "planet" && S.handles.get(it.id)?.insetOf ? ` near ${S.handles.get(it.id)?.insetOf}` : ""}`;
        dist = it.distanceKm;
      }
      S.hoverLabel.position.copy(pos);
      S.hoverLabel.element.textContent = `${it?.name ?? sat?.name} · ${what} · ${it?.id === "earth" ? "you are here" : formatDistance(dist, propsRef.current.unit)}`;
      S.hoverLabel.visible = true;
    } else S.hoverLabel.visible = false;
    S.dirty = true;
  }, [selectedId, hoverId, items, sats, ready]);

  const view = (preset: "top" | "3d" | "focus") => {
    const S = sceneRef.current;
    if (!S) return;
    if (preset === "focus") {
      // A satellite is only drawn while Earth's system is shown, so focusing on one flies to Earth first.
      const satOnly = !!selectedId && selectedId.startsWith("sat-") && !positionOf(S, selectedId);
      const p = selectedId ? (positionOf(S, selectedId) ?? (satOnly ? S.positions.get("earth") : undefined)) : undefined;
      if (!p) return;
      const h = selectedId ? S.handles.get(satOnly ? "earth" : selectedId) : undefined;
      // Planets: close enough to bring up their system. Small bodies: a short distance in the current scale.
      const dist = h?.kind === "planet" ? h.radius * 7 : h?.radius ? h.radius * 14 : h?.system || h?.inSystem ? 0.6 : S.sunR * 1.5;
      const dir = new THREE.Vector3().subVectors(S.camera.position, S.controls.target).normalize();
      if (dir.lengthSq() < 1e-6) dir.set(0.5, -0.7, 0.5).normalize();
      S.controls.target.copy(p);
      S.camera.position.copy(p).addScaledVector(dir, Math.max(0.2, dist));
    } else {
      setFollow(false);
      S.controls.target.set(0, 0, 0);
      if (preset === "top") S.camera.position.set(0, -0.5, 300);
      else S.camera.position.set(150, -190, 120);
    }
    S.controls.update();
    S.dirty = true;
  };
  const canFocus = !!selectedId && !!sceneRef.current && (!!positionOf(sceneRef.current, selectedId) || (selectedId.startsWith("sat-") && sceneRef.current.positions.has("earth")));

  return (
    <div className="solar3d" ref={wrapRef} role="application" aria-label="Solar system">
      <div className="s3d-mount" ref={mountRef} />
      <div className={`s3d-options${optionsOpen ? " open" : ""}`}>
        <button type="button" className="s3d-opt-toggle" onClick={() => setOptionsOpen((o) => !o)} aria-expanded={optionsOpen}>
          ⚙ Options {optionsOpen ? "▴" : "▾"}
        </button>
        {optionsOpen && (
          <div className="s3d-opt-body">
            <div className="menu-title">Show</div>
            {SOLAR_KINDS.map((k) => (
              <label key={k.id} className="menu-item">
                <input type="checkbox" checked={prefs.kinds[k.id]} onChange={(e) => onPrefs({ kinds: { ...prefs.kinds, [k.id]: e.target.checked } })} />
                <i className="sw" style={{ background: `#${KIND_COLORS[k.id].toString(16).padStart(6, "0")}` }} /> {k.label} <span className="count">{counts[k.id].toLocaleString()}</span>
              </label>
            ))}
            <div className="menu-hint">Moons, nearby spacecraft and Earth's satellites appear around a planet when you fly close to it (select it and press Focus).</div>
            <div className="menu-sep" />
            <label className="menu-item">
              <input type="checkbox" checked={prefs.orbits} onChange={(e) => onPrefs({ orbits: e.target.checked })} /> Planet orbits
            </label>
            <label className="menu-item" title="Off: the orbit of a small body appears when you hover or select it">
              <input type="checkbox" checked={prefs.smallOrbits} onChange={(e) => onPrefs({ smallOrbits: e.target.checked })} /> All small-body orbits
            </label>
            <label className="menu-item" title="Off: a spacecraft's path appears when you hover or select it">
              <input type="checkbox" checked={prefs.trails} onChange={(e) => onPrefs({ trails: e.target.checked })} /> Spacecraft trajectories
            </label>
            <label className="menu-item">
              <input type="checkbox" checked={prefs.atmospheres} onChange={(e) => onPrefs({ atmospheres: e.target.checked })} /> Atmospheres
            </label>
            <label className="menu-item">
              <input type="checkbox" checked={prefs.labels} onChange={(e) => onPrefs({ labels: e.target.checked })} /> Labels
            </label>
            <label className="menu-item">
              <input type="checkbox" checked={prefs.skybox} onChange={(e) => onPrefs({ skybox: e.target.checked })} /> Milky Way background
            </label>
            <div className="menu-sep" />
            <div className="menu-title">Scale</div>
            <div className="segmented" role="group" aria-label="Scale">
              <button type="button" className={prefs.scale === "log" ? "on" : ""} onClick={() => onPrefs({ scale: "log" })} title="Distances shrink logarithmically so the inner and outer system both fit">
                Compressed
              </button>
              <button type="button" className={prefs.scale === "linear" ? "on" : ""} onClick={() => onPrefs({ scale: "linear" })} title="Real distances; planets are still drawn larger than life so they stay visible">
                True
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="s3d-toolbar">
        <button type="button" onClick={() => view("top")}>Top-down</button>
        <button type="button" onClick={() => view("3d")}>3D</button>
        <button type="button" onClick={() => view("focus")} disabled={!canFocus} title="Move the camera to the selected body">
          Focus
        </button>
        <button
          type="button"
          className={follow ? "on" : ""}
          aria-pressed={follow}
          disabled={!canFocus && !follow}
          onClick={() => {
            if (!follow) view("focus");
            setFollow((f) => !f);
          }}
          title="Keep the camera on the selected body as it moves"
        >
          Follow
        </button>
      </div>
      <div className="solar-legend">
        <span>
          <i className="lg-planet" /> planet
        </span>
        <span>
          <i className="lg-probe" /> spacecraft
        </span>
        <span>
          <i className="lg-small" /> dwarf planet · asteroid · comet
        </span>
        <span>
          <i className="lg-neo" /> close-approach asteroid
        </span>
        <span className="muted">drag to orbit · wheel to zoom · right-drag to pan · hover a body or orbit to see whose it is · fly close to a planet for its moons and spacecraft</span>
      </div>
      {lost && (
        <div className="lost">
          <p>The browser reset the 3D view (it ran out of graphics memory or the GPU was interrupted).</p>
          <button type="button" onClick={() => setEpoch((e) => e + 1)}>
            Rebuild the solar system
          </button>
        </div>
      )}
    </div>
  );
}

/** Scene position of any body, including instanced moons and Earth's satellites. */
function positionOf(S: Scene, id: string): THREE.Vector3 | undefined {
  const p = S.positions.get(id);
  if (p) return p;
  const earth = S.systems.get("Earth");
  if (earth?.sats && earth.shown) {
    const i = earth.satIds.indexOf(id);
    if (i >= 0) {
      const a = earth.sats.geometry.getAttribute("position") as THREE.BufferAttribute;
      return new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)).add(earth.group.position);
    }
  }
  return undefined;
}

/** Positions, orientations and system offsets for the current tick. */
function positionAll(S: Scene, items: SolarItem[], now: number, mode: SolarPrefs["scale"], earthQuat: THREE.Quaternion): void {
  const scale = makeScaler(mode);
  const time = makeTime(now);
  orient(A.Body.Sun, time, S.sunBody.quaternion);
  const smallAttr = S.small?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const sa = smallAttr?.array as Float32Array | undefined;
  const markerAttr = S.markers?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const ma = markerAttr?.array as Float32Array | undefined;
  const pos = (id: string): THREE.Vector3 => {
    let p = S.positions.get(id);
    if (!p) {
      p = new THREE.Vector3();
      S.positions.set(id, p);
    }
    return p;
  };
  // Planets first: everything in a system is placed relative to them.
  const planetHelio = new Map<string, Vec3>();
  for (const it of items) {
    const h = S.handles.get(it.id);
    if (!h || h.kind !== "planet" || !h.root || !h.body) continue;
    planetHelio.set(h.name, it.pos);
    const p = pos(it.id);
    scale(it.pos, p);
    h.root.position.copy(p);
    h.label?.position.copy(p);
    if (h.bodyEnum !== undefined) orient(h.bodyEnum, time, h.body.quaternion);
    if (it.id === "earth") earthQuat.copy(h.body.quaternion);
    const sys = S.systems.get(h.name);
    sys?.group.position.copy(p);
    if (h.marker !== undefined && ma) {
      ma[h.marker * 3] = p.x;
      ma[h.marker * 3 + 1] = p.y;
      ma[h.marker * 3 + 2] = p.z;
    }
    if (h.orbitLine && it.orbit && it.orbit !== h.orbitSrc) {
      const attr = h.orbitLine.geometry.getAttribute("position") as THREE.BufferAttribute;
      if (attr.count === it.orbit.length + 1) {
        fillLine(attr.array as Float32Array, it.orbit, true, scale);
        attr.needsUpdate = true;
        h.orbitLine.geometry.computeBoundingSphere();
      }
      h.orbitSrc = it.orbit;
    }
  }
  const touched = new Set<THREE.InstancedMesh>();
  for (const it of items) {
    const h = S.handles.get(it.id);
    if (!h || h.kind === "planet") continue;
    const p = pos(it.id);
    const sys = it.system ? S.systems.get(it.system) : undefined;
    if (h.kind === "moon") {
      if (!h.system || !it.rel) continue;
      insetOffset(h.system, it.rel, tmp2);
      p.copy(h.system.group.position).add(tmp2);
      h.label?.position.copy(p);
      if (h.root) {
        h.root.position.copy(tmp2);
        if (h.body && h.bodyEnum !== undefined) orient(h.bodyEnum, time, h.body.quaternion);
      } else if (h.instance !== undefined && h.system.moons) {
        _scl.setScalar(h.radius);
        _inst.compose(tmp2, _quat.identity(), _scl);
        h.system.moons.setMatrixAt(h.instance, _inst);
        touched.add(h.system.moons);
      }
      continue;
    }
    // A spacecraft or flyby near a planet sits in that planet's system inset. So does anything whose place on the
    // main scale would fall inside a planet's sphere: in the log scale Earth's sphere alone covers +-0.1 AU
    // radially, Jupiter's more than an AU. Everything else stays on the main scale.
    let inset: PlanetSystem | undefined = sys && it.rel ? sys : undefined;
    let rel: Vec3 | undefined = inset ? it.rel : undefined;
    if (!inset) {
      scale(it.pos, p);
      for (const s of S.systems.values()) {
        if (p.distanceTo(s.group.position) >= s.radius * OCCLUDED) continue;
        const ph = planetHelio.get(s.name);
        if (ph) {
          inset = s;
          rel = { x: it.pos.x - ph.x, y: it.pos.y - ph.y, z: it.pos.z - ph.z };
        }
        break;
      }
    }
    if (inset && rel) {
      insetOffset(inset, rel, tmp2);
      p.copy(inset.group.position).add(tmp2);
      h.inSystem = true;
      h.insetOf = inset.name;
    } else if (p.length() < S.sunR * OCCLUDED) {
      // Inside the Sun's sphere (Parker Solar Probe near perihelion): the same inset idea, around the Sun.
      const r = Math.hypot(it.pos.x, it.pos.y, it.pos.z);
      if (r > 0) p.set(it.pos.x, it.pos.y, it.pos.z).multiplyScalar((insetRadii((r * KM_PER_AU) / SUN_RADIUS_KM) * S.sunR) / r);
      h.inSystem = false;
      h.insetOf = "the Sun";
    } else {
      h.inSystem = false;
      h.insetOf = undefined;
    }
    if (h.point !== undefined && sa) {
      sa[h.point * 3] = p.x;
      sa[h.point * 3 + 1] = p.y;
      sa[h.point * 3 + 2] = p.z;
    }
  }
  for (const m of touched) m.instanceMatrix.needsUpdate = true;
  if (smallAttr && S.small) {
    smallAttr.needsUpdate = true;
    S.small.geometry.computeBoundingSphere();
  }
  if (markerAttr && S.markers) {
    markerAttr.needsUpdate = true;
    S.markers.geometry.computeBoundingSphere();
  }
}
