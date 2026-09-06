// Interactive solar system on three.js: textured, lit planets with real axial tilts and rotation,
// Saturn's rings, the Milky Way behind, real orbit shapes for small bodies and spacecraft trails.
// Hover a body or an orbit to see whose it is; click for details. The scene is built when the set
// of bodies, the orbit data, the filters or the scale change; the once-a-second update only writes
// positions into existing meshes and buffers.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import * as A from "astronomy-engine";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Vec3 } from "../types";
import type { OrbitInfo } from "../lib/orbits";
import { conicPath } from "../lib/orbits";
import { formatDistance, type Unit } from "../lib/units";
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
}

interface Props {
  items: SolarItem[];
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

const PLANET_COLORS: Record<string, number> = {
  Mercury: 0x9ca3af, Venus: 0xf5deb3, Earth: 0x3b82f6, Mars: 0xef4444, Jupiter: 0xd4a373,
  Saturn: 0xe9d8a6, Uranus: 0x7dd3fc, Neptune: 0x6366f1, Pluto: 0xa78bfa,
};
const KIND_COLORS: Record<SolarKind, number> = {
  planet: 0x3b82f6, probe: 0xec4899, dwarf: 0xf97316, tno: 0xfb923c, centaur: 0xfdba74, asteroid: 0xf59e0b,
  comet: 0x38bdf8, interstellar: 0x22d3ee, neo: 0xef4444,
};
const TEXTURES: Record<string, string> = {
  Sun: "sun", Mercury: "mercury", Venus: "venus_atmosphere", Earth: "earth_daymap", Mars: "mars",
  Jupiter: "jupiter", Saturn: "saturn", Uranus: "uranus", Neptune: "neptune",
};
// Axial tilt (degrees) and sidereal rotation period (hours; negative = retrograde).
const TILT_DEG: Record<string, number> = { Mercury: 0.03, Venus: 177.4, Earth: 23.44, Mars: 25.19, Jupiter: 3.13, Saturn: 26.73, Uranus: 97.77, Neptune: 28.32, Pluto: 122.5 };
const SPIN_HOURS: Record<string, number> = { Mercury: 1407.6, Venus: -5832.5, Earth: 23.934, Mars: 24.62, Jupiter: 9.93, Saturn: 10.66, Uranus: -17.24, Neptune: 16.11, Pluto: -153.3 };

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

export function kindOf(it: SolarItem): SolarKind {
  if (it.id === "earth" || it.kind === "Planet" || it.kind === "Dwarf planet") return "planet";
  return (it.kind in KIND_COLORS ? it.kind : "asteroid") as SolarKind;
}

function makeLabel(text: string, cls: string): CSS2DObject {
  const div = document.createElement("div");
  div.className = `s3d-label ${cls}`;
  div.textContent = text;
  return new CSS2DObject(div);
}

const tmp = new THREE.Vector3();

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
function loadTexture(file: string): Promise<THREE.Texture> {
  let p = texCache.get(file);
  if (!p) {
    p = new Promise<THREE.Texture>((resolve, reject) =>
      loader.load(
        `/textures/planets/${file}`,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          resolve(t);
        },
        undefined,
        reject,
      ),
    );
    p.catch(() => texCache.delete(file));
    texCache.set(file, p);
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
  return glowTexture;
}

/** Ring geometry whose texture coordinate runs radially, so a 1-D ring strip maps correctly. */
function ringGeometry(inner: number, outer: number): THREE.RingGeometry {
  const geom = new THREE.RingGeometry(inner, outer, 96, 1);
  const pos = geom.getAttribute("position") as THREE.BufferAttribute;
  const uv = geom.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - inner) / (outer - inner), 0.5);
  }
  uv.needsUpdate = true;
  return geom;
}

/** Per-body handles into the scene so positions can be updated without rebuilding anything. */
interface Handle {
  root?: THREE.Object3D; // tilt group (planets)
  spin?: THREE.Object3D; // rotated about the polar axis every tick
  mesh?: THREE.Mesh;
  label?: CSS2DObject;
  orbitLine?: THREE.Line;
  orbitSrc?: Vec3[];
  point?: number; // index into the small-body point cloud
  radius: number;
}

interface Scene {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  labelGroup: THREE.Group;
  overlay: THREE.Group;
  skybox: THREE.Mesh;
  stars: THREE.Points;
  pickables: THREE.Object3D[];
  pointIds: string[];
  small: THREE.Points | null;
  handles: Map<string, Handle>;
  positions: Map<string, THREE.Vector3>;
  lines: Map<string, THREE.Line>;
  highlight: THREE.Mesh;
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

export default function SolarSystem3D({ items, orbits, selectedId, hoverId, unit, now, prefs, onPrefs, onSelect, onHover }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const propsRef = useRef({ items, onSelect, onHover, unit });
  propsRef.current = { items, onSelect, onHover, unit };
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const kindsKey = SOLAR_KINDS.map((k) => (prefs.kinds[k.id] ? "1" : "0")).join("");
  // The scene structure depends only on which bodies exist (and which are shown), not on where they are.
  const structureKey = useMemo(() => items.map((i) => i.id).join("\n"), [items]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(SOLAR_KINDS.map((k) => [k.id, 0])) as Record<SolarKind, number>;
    for (const it of items) c[kindOf(it)]++;
    return c;
  }, [items]);

  // Scene setup (again after a lost context).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.domElement.className = "s3d-canvas";
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.setSize(el.clientWidth, el.clientHeight);
    labels.domElement.className = "s3d-labels";
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(1, el.clientHeight), 0.05, 6000);
    camera.up.set(0, 0, 1);
    camera.position.set(150, -190, 120);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.5;
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

    // Sun: textured sphere plus an additive glow sprite; lights everything else.
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xffd36e });
    const sun = new THREE.Mesh(new THREE.SphereGeometry(2.4, 32, 32), sunMat);
    sun.name = "sun";
    scene.add(sun);
    loadTexture("sun.jpg")
      .then((t) => {
        sunMat.map = t;
        sunMat.color.set(0xffffff);
        sunMat.needsUpdate = true;
        S.dirty = true;
      })
      .catch(() => {});
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlow(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.set(14, 14, 1);
    scene.add(glow);
    scene.add(makeLabel("Sun", "planet"));
    scene.add(new THREE.PointLight(0xfff4e0, 2.4, 0, 0));
    scene.add(new THREE.AmbientLight(0xffffff, 0.32));

    const content = new THREE.Group();
    const labelGroup = new THREE.Group();
    const overlay = new THREE.Group();
    scene.add(content, labelGroup, overlay);
    const highlight = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.9, 40), new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
    highlight.visible = false;
    overlay.add(highlight);
    const hoverLabel = makeLabel("", "hover");
    hoverLabel.visible = false;
    overlay.add(hoverLabel);

    const S: Scene = {
      renderer, labels, scene, camera, controls, content, labelGroup, overlay, skybox, stars,
      pickables: [], pointIds: [], small: null, handles: new Map(), positions: new Map(), lines: new Map(),
      highlight, hoverLabel, hoverHit: null, hoveredLine: null, selectedLine: null, dirty: true, raf: 0,
    };
    sceneRef.current = S;

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 2.2 };
    raycaster.params.Line = { threshold: 1.1 };
    const mouse = new THREE.Vector2();
    const pick = (ev: MouseEvent): { id: string; point: THREE.Vector3 } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(S.pickables, false);
      // Bodies win over orbit lines when both are under the cursor.
      let lineHit: { id: string; point: THREE.Vector3 } | null = null;
      for (const h of hits) {
        if (h.object instanceof THREE.Points) {
          if (h.index !== undefined && S.pointIds[h.index]) return { id: S.pointIds[h.index], point: h.point };
        } else if (h.object instanceof THREE.Line) {
          if (!lineHit && h.object.userData.id) lineHit = { id: h.object.userData.id as string, point: h.point };
        } else if (h.object.userData.id) return { id: h.object.userData.id as string, point: h.point };
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
    const onClick = (ev: MouseEvent) => {
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
    renderer.domElement.addEventListener("pointermove", onMove);
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

    const loop = () => {
      S.raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const moved = controls.update();
      if (moved || S.dirty) {
        S.dirty = false;
        glow.scale.setScalar(Math.max(8, Math.min(40, camera.position.length() * 0.08)));
        renderer.render(scene, camera);
        labels.render(scene, camera);
      }
    };
    loop();
    setLost(false);
    setReady(true);

    return () => {
      cancelAnimationFrame(S.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      controls.dispose();
      renderer.dispose();
      el.innerHTML = "";
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
    S.dirty = true;
  }, [prefs.skybox, prefs.labels, ready]);

  // Build the scene content when the set of bodies, the orbit data, the filters or the scale changes.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    const scale = makeScaler(prefs.scale);
    const disposeChildren = (g: THREE.Group) => {
      for (const child of [...g.children]) {
        g.remove(child);
        child.traverse((o) => {
          const obj = o as THREE.Mesh | THREE.Line | THREE.Points;
          if ("geometry" in obj && obj.geometry) obj.geometry.dispose();
          if ("material" in obj && obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
        });
        if (child instanceof CSS2DObject) child.element.remove();
      }
    };
    disposeChildren(S.content);
    disposeChildren(S.labelGroup);
    S.pickables = [];
    S.handles.clear();
    S.positions.clear();
    S.lines.clear();
    S.small = null;
    S.hoveredLine = null;
    S.selectedLine = null;

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
    const smallIds: string[] = [];
    const smallCol: number[] = [];
    const c = new THREE.Color();
    for (const it of current) {
      const kind = kindOf(it);
      if (!prefs.kinds[kind]) continue;
      const h: Handle = { radius: 0 };
      if (kind === "planet") {
        const r = it.radiusKm ? Math.min(2.6, Math.max(0.9, (Math.log10(it.radiusKm) - 2.4) * 0.95)) : 1;
        h.radius = r;
        const mat = new THREE.MeshStandardMaterial({ color: PLANET_COLORS[it.name] ?? 0xe5e7eb, roughness: 0.95, metalness: 0 });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 28), mat);
        mesh.rotation.x = Math.PI / 2; // texture poles along +z
        mesh.userData.id = it.id;
        const spin = new THREE.Group();
        spin.add(mesh);
        const tilt = new THREE.Group();
        tilt.rotation.x = -(TILT_DEG[it.name] ?? 0) * D2R;
        tilt.add(spin);
        const file = TEXTURES[it.name];
        if (file) {
          loadTexture(`${file}.jpg`)
            .then((t) => {
              mat.map = t;
              mat.color.set(0xffffff);
              mat.needsUpdate = true;
              S.dirty = true;
            })
            .catch(() => {});
        }
        if (it.name === "Saturn") {
          const ringMat = new THREE.MeshBasicMaterial({ color: 0xd9c9a3, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false });
          const ring = new THREE.Mesh(ringGeometry(r * 1.25, r * 2.3), ringMat);
          ring.userData.id = it.id;
          tilt.add(ring);
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
        h.root = tilt;
        h.spin = spin;
        h.mesh = mesh;
        S.content.add(tilt);
        S.pickables.push(mesh);
        h.label = makeLabel(it.id === "earth" ? "Earth (you are here)" : it.name, "planet");
        S.labelGroup.add(h.label);
        if (it.orbit && prefs.orbits) {
          h.orbitLine = lineOf(it.orbit, PLANET_COLORS[it.name] ?? 0x64748b, 0.45, true, scale);
          h.orbitLine.userData.id = it.id;
          h.orbitSrc = it.orbit;
          S.content.add(h.orbitLine);
          S.pickables.push(h.orbitLine);
          S.lines.set(it.id, h.orbitLine);
        }
      } else {
        h.point = smallIds.length;
        smallIds.push(it.id);
        c.setHex(KIND_COLORS[kind]);
        smallCol.push(c.r, c.g, c.b);
        const o = it.hzId ? orbits.get(it.hzId) : undefined;
        let line: THREE.Line | null = null;
        if (o?.elements && prefs.orbits) {
          const path = conicPath(o.elements, kind === "interstellar" || kind === "comet" ? 320 : 160);
          if (path.length > 2) line = lineOf(path, KIND_COLORS[kind], kind === "asteroid" || kind === "neo" ? 0.14 : 0.32, o.elements.e < 1, scale);
        } else if (o?.trail && prefs.trails) {
          const pts = o.trail.rows.map((r) => ({ x: r[0], y: r[1], z: r[2] }));
          if (pts.length > 1) line = lineOf(pts, KIND_COLORS.probe, 0.45, false, scale);
        }
        if (line) {
          line.userData.id = it.id;
          S.content.add(line);
          S.pickables.push(line);
          S.lines.set(it.id, line);
          h.orbitLine = line;
        }
      }
      S.handles.set(it.id, h);
    }
    if (smallIds.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(smallIds.length * 3), 3));
      geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(smallCol), 3));
      const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 3, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false }));
      pts.frustumCulled = false;
      S.content.add(pts);
      S.pickables.unshift(pts);
      S.small = pts;
    }
    S.pointIds = smallIds;
    S.dirty = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, orbits, prefs.scale, prefs.orbits, prefs.trails, kindsKey, ready]);

  // Move everything to its current position and spin the planets (every tick). Writes into existing objects only.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    const scale = makeScaler(prefs.scale);
    const posAttr = S.small?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const arr = posAttr?.array as Float32Array | undefined;
    const gast = A.SiderealTime(makeTime(now)) * 15 * D2R; // Greenwich sidereal angle, radians
    for (const it of items) {
      const h = S.handles.get(it.id);
      if (!h) continue;
      let p = S.positions.get(it.id);
      if (!p) {
        p = new THREE.Vector3();
        S.positions.set(it.id, p);
      }
      scale(it.pos, p);
      if (h.root && h.spin) {
        h.root.position.copy(p);
        h.label?.position.copy(p);
        const hours = SPIN_HOURS[it.name];
        h.spin.rotation.z = it.id === "earth" ? gast : hours ? ((now / 3600e3 / hours) * Math.PI * 2) % (Math.PI * 2) : 0;
        if (h.orbitLine && it.orbit && it.orbit !== h.orbitSrc) {
          const attr = h.orbitLine.geometry.getAttribute("position") as THREE.BufferAttribute;
          if (attr.count === it.orbit.length + 1) {
            fillLine(attr.array as Float32Array, it.orbit, true, scale);
            attr.needsUpdate = true;
            h.orbitLine.geometry.computeBoundingSphere();
          }
          h.orbitSrc = it.orbit;
        }
      } else if (h.point !== undefined && arr) {
        arr[h.point * 3] = p.x;
        arr[h.point * 3 + 1] = p.y;
        arr[h.point * 3 + 2] = p.z;
      }
    }
    if (posAttr && S.small) {
      posAttr.needsUpdate = true;
      S.small.geometry.computeBoundingSphere();
    }
    S.dirty = true;
  }, [items, now, prefs.scale, ready]);

  // Highlight the selected body (and its orbit) and label the hovered body or orbit.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    setLineOpacity(S.selectedLine, 1);
    S.selectedLine = (selectedId && S.lines.get(selectedId)) || null;
    setLineOpacity(S.selectedLine, 3);
    const sel = selectedId ? S.positions.get(selectedId) : undefined;
    if (sel) {
      S.highlight.position.copy(sel);
      S.highlight.lookAt(S.camera.position);
      S.highlight.visible = true;
    } else S.highlight.visible = false;

    setLineOpacity(S.hoveredLine, 1);
    S.hoveredLine = null;
    const it = hoverId ? propsRef.current.items.find((i) => i.id === hoverId) : undefined;
    const onLine = hoverId && S.hoverHit?.id === hoverId && S.lines.has(hoverId) && !S.pickables.some((o) => o.userData.id === hoverId && !(o instanceof THREE.Line));
    const pos = hoverId ? (S.hoverHit?.id === hoverId && S.lines.has(hoverId) && !(S.handles.get(hoverId)?.mesh) ? S.hoverHit.point : S.positions.get(hoverId)) : undefined;
    if (it && pos) {
      if (S.lines.has(it.id)) {
        S.hoveredLine = S.lines.get(it.id) ?? null;
        setLineOpacity(S.hoveredLine, 3);
      }
      const kind = kindOf(it);
      const what = onLine ? (kind === "probe" ? "trajectory" : "orbit") : SOLAR_KINDS.find((k) => k.id === kind)?.label.replace(/s$/, "").toLowerCase() ?? "";
      S.hoverLabel.position.copy(S.hoverHit?.id === it.id && S.hoverHit ? S.hoverHit.point : pos);
      S.hoverLabel.element.textContent = `${it.name} · ${what} · ${it.id === "earth" ? "you are here" : formatDistance(it.distanceKm, propsRef.current.unit)}`;
      S.hoverLabel.visible = true;
    } else S.hoverLabel.visible = false;
    S.dirty = true;
  }, [selectedId, hoverId, items, ready]);

  const view = (preset: "top" | "3d" | "focus" | "reset") => {
    const S = sceneRef.current;
    if (!S) return;
    if (preset === "focus") {
      const p = selectedId ? S.positions.get(selectedId) : undefined;
      if (!p) return;
      const h = selectedId ? S.handles.get(selectedId) : undefined;
      const dist = Math.max(4, (h?.radius ?? 0.5) * 7);
      const dir = new THREE.Vector3().subVectors(S.camera.position, S.controls.target).normalize();
      if (dir.lengthSq() < 1e-6) dir.set(0.5, -0.7, 0.5).normalize();
      S.controls.target.copy(p);
      S.camera.position.copy(p).addScaledVector(dir, dist);
    } else {
      S.controls.target.set(0, 0, 0);
      if (preset === "top") S.camera.position.set(0, -0.5, 300);
      else S.camera.position.set(150, -190, 120);
    }
    S.controls.update();
    S.dirty = true;
  };

  return (
    <div className="solar3d" ref={wrapRef} role="application" aria-label="Solar system">
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
                <i className="sw" style={{ background: `#${KIND_COLORS[k.id].toString(16).padStart(6, "0")}` }} /> {k.label} <span className="count">{counts[k.id]}</span>
              </label>
            ))}
            <div className="menu-sep" />
            <label className="menu-item">
              <input type="checkbox" checked={prefs.orbits} onChange={(e) => onPrefs({ orbits: e.target.checked })} /> Orbit paths
            </label>
            <label className="menu-item">
              <input type="checkbox" checked={prefs.trails} onChange={(e) => onPrefs({ trails: e.target.checked })} /> Spacecraft trajectories
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
              <button type="button" className={prefs.scale === "linear" ? "on" : ""} onClick={() => onPrefs({ scale: "linear" })} title="Real proportions (planet sizes stay exaggerated)">
                True
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="s3d-toolbar">
        <button type="button" onClick={() => view("top")}>Top-down</button>
        <button type="button" onClick={() => view("3d")}>3D</button>
        <button type="button" onClick={() => view("focus")} disabled={!selectedId || !sceneRef.current?.positions.has(selectedId)} title="Move the camera to the selected body">
          Focus
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
        <span className="muted">drag to orbit · wheel to zoom · right-drag to pan · hover an orbit to see whose it is · click for details</span>
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
