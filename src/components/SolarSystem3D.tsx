// Interactive solar system on three.js: rotate, zoom and pan, real orbit shapes, hover and click.
// The scene is built when the set of bodies (or the scale or the orbit data) changes; the
// once-a-second position update only writes into existing meshes and buffers.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Vec3 } from "../types";
import type { OrbitInfo } from "../lib/orbits";
import { conicPath } from "../lib/orbits";
import { formatDistance, type Unit } from "../lib/units";

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
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

type ScaleMode = "log" | "linear";
const R_MIN = 0.05;
const R_MAX = 300;
const RADIUS = 110;

const PLANET_COLORS: Record<string, number> = {
  Mercury: 0x9ca3af, Venus: 0xf5deb3, Earth: 0x3b82f6, Mars: 0xef4444, Jupiter: 0xd4a373,
  Saturn: 0xe9d8a6, Uranus: 0x7dd3fc, Neptune: 0x6366f1, Pluto: 0xa78bfa,
};
const KIND_COLORS: Record<string, number> = {
  probe: 0xec4899, dwarf: 0xf97316, tno: 0xfb923c, centaur: 0xfdba74, asteroid: 0xf59e0b,
  comet: 0x38bdf8, interstellar: 0x22d3ee, neo: 0xef4444,
};

type Scaler = (v: Vec3, out: THREE.Vector3) => THREE.Vector3;

function makeScaler(mode: ScaleMode): Scaler {
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

function isPlanet(it: SolarItem): boolean {
  return it.id === "earth" || it.kind === "Planet" || it.kind === "Dwarf planet";
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
  return new THREE.Line(geom, new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity }));
}

/** Per-body handles into the scene so positions can be updated without rebuilding anything. */
interface Handle {
  mesh?: THREE.Mesh;
  label?: CSS2DObject;
  orbitLine?: THREE.Line;
  orbitSrc?: Vec3[];
  point?: number; // index into the small-body point cloud
}

interface Scene {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  overlay: THREE.Group;
  pickables: THREE.Object3D[];
  pointIds: string[];
  small: THREE.Points | null;
  handles: Map<string, Handle>;
  positions: Map<string, THREE.Vector3>;
  highlight: THREE.Mesh;
  hoverLabel: CSS2DObject;
  dirty: boolean;
  raf: number;
}

export default function SolarSystem3D({ items, orbits, selectedId, hoverId, unit, onSelect, onHover }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const propsRef = useRef({ items, onSelect, onHover, unit });
  propsRef.current = { items, onSelect, onHover, unit };
  const [scaleMode, setScaleMode] = useState<ScaleMode>("log");
  const [ready, setReady] = useState(false);
  // The scene structure depends only on which bodies exist, not on where they are.
  const structureKey = useMemo(() => items.map((i) => i.id).join("\n"), [items]);

  // Scene setup, once.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.domElement.className = "s3d-canvas";
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.setSize(el.clientWidth, el.clientHeight);
    labels.domElement.className = "s3d-labels";
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(1, el.clientHeight), 0.1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(150, -190, 120);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 8;
    controls.maxDistance = 1200;
    controls.zoomSpeed = 0.9;

    // Star field
    const starGeom = new THREE.BufferGeometry();
    const starPos = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = 2000;
      const s = Math.sqrt(1 - u * u);
      starPos[i * 3] = r * s * Math.cos(th);
      starPos[i * 3 + 1] = r * s * Math.sin(th);
      starPos[i * 3 + 2] = r * u;
    }
    starGeom.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeom, new THREE.PointsMaterial({ color: 0x94a3b8, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.6 })));

    // Sun
    const sun = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 24), new THREE.MeshBasicMaterial({ color: 0xfbbf24 }));
    sun.name = "sun";
    scene.add(sun);
    scene.add(makeLabel("Sun", "planet"));
    scene.add(new THREE.PointLight(0xffffff, 2, 0, 0));
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const content = new THREE.Group();
    const overlay = new THREE.Group();
    scene.add(content, overlay);
    const highlight = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.9, 40), new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
    highlight.visible = false;
    overlay.add(highlight);
    const hoverLabel = makeLabel("", "hover");
    hoverLabel.visible = false;
    overlay.add(hoverLabel);

    const S: Scene = {
      renderer, labels, scene, camera, controls, content, overlay,
      pickables: [], pointIds: [], small: null, handles: new Map(), positions: new Map(),
      highlight, hoverLabel, dirty: true, raf: 0,
    };
    sceneRef.current = S;

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 2.2 };
    const mouse = new THREE.Vector2();
    const pick = (ev: MouseEvent): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(S.pickables, false);
      for (const h of hits) {
        if (h.object instanceof THREE.Points) {
          if (h.index !== undefined && S.pointIds[h.index]) return S.pointIds[h.index];
        } else if (h.object.userData.id) return h.object.userData.id as string;
      }
      return null;
    };
    let last = 0;
    const onMove = (ev: PointerEvent) => {
      const t = performance.now();
      if (t - last < 40) return;
      last = t;
      propsRef.current.onHover(pick(ev));
    };
    const onClick = (ev: MouseEvent) => {
      const id = pick(ev);
      if (id) propsRef.current.onSelect(id);
    };
    const onLeave = () => propsRef.current.onHover(null);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("pointerleave", onLeave);

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
      const moved = controls.update();
      if (moved || S.dirty) {
        S.dirty = false;
        renderer.render(scene, camera);
        labels.render(scene, camera);
      }
    };
    loop();
    setReady(true);

    return () => {
      cancelAnimationFrame(S.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      renderer.dispose();
      el.innerHTML = "";
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build the scene content when the set of bodies, the orbit data or the scale changes.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    const scale = makeScaler(scaleMode);
    for (const child of [...S.content.children]) {
      S.content.remove(child);
      const obj = child as THREE.Mesh | THREE.Line | THREE.Points;
      if ("geometry" in obj && obj.geometry) obj.geometry.dispose();
      if ("material" in obj && obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
      if (child instanceof CSS2DObject) child.element.remove();
    }
    S.pickables = [];
    S.handles.clear();
    S.positions.clear();
    S.small = null;

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
      S.content.add(lbl);
    }

    const current = propsRef.current.items;
    const smallIds: string[] = [];
    const smallCol: number[] = [];
    const c = new THREE.Color();
    for (const it of current) {
      const h: Handle = {};
      if (isPlanet(it)) {
        const r = it.radiusKm ? Math.min(2.4, Math.max(0.8, (Math.log10(it.radiusKm) - 2.5) * 0.9)) : 1;
        h.mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 20), new THREE.MeshBasicMaterial({ color: PLANET_COLORS[it.name] ?? 0xe5e7eb }));
        h.mesh.userData.id = it.id;
        S.content.add(h.mesh);
        S.pickables.push(h.mesh);
        h.label = makeLabel(it.id === "earth" ? "Earth (you are here)" : it.name, "planet");
        S.content.add(h.label);
        if (it.orbit) {
          h.orbitLine = lineOf(it.orbit, PLANET_COLORS[it.name] ?? 0x64748b, 0.45, true, scale);
          h.orbitSrc = it.orbit;
          S.content.add(h.orbitLine);
        }
      } else {
        h.point = smallIds.length;
        smallIds.push(it.id);
        c.setHex(KIND_COLORS[it.kind] ?? 0xf97316);
        smallCol.push(c.r, c.g, c.b);
        const o = it.hzId ? orbits.get(it.hzId) : undefined;
        if (o?.elements) {
          const path = conicPath(o.elements, it.kind === "interstellar" || it.kind === "comet" ? 320 : 160);
          if (path.length > 2) S.content.add(lineOf(path, KIND_COLORS[it.kind] ?? 0xf97316, it.kind === "asteroid" || it.kind === "neo" ? 0.12 : 0.3, o.elements.e < 1, scale));
        } else if (o?.trail) {
          const pts = o.trail.rows.map((r) => ({ x: r[0], y: r[1], z: r[2] }));
          if (pts.length > 1) S.content.add(lineOf(pts, KIND_COLORS.probe, 0.45, false, scale));
        }
      }
      S.handles.set(it.id, h);
    }
    if (smallIds.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(smallIds.length * 3), 3));
      geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(smallCol), 3));
      const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 2.6, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false }));
      pts.frustumCulled = false;
      S.content.add(pts);
      S.pickables.push(pts);
      S.small = pts;
    }
    S.pointIds = smallIds;
    S.dirty = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, orbits, scaleMode, ready]);

  // Move everything to its current position (every tick). Writes into existing objects only.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    const scale = makeScaler(scaleMode);
    const posAttr = S.small?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const arr = posAttr?.array as Float32Array | undefined;
    for (const it of items) {
      const h = S.handles.get(it.id);
      if (!h) continue;
      let p = S.positions.get(it.id);
      if (!p) {
        p = new THREE.Vector3();
        S.positions.set(it.id, p);
      }
      scale(it.pos, p);
      if (h.mesh) {
        h.mesh.position.copy(p);
        h.label?.position.copy(p);
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
  }, [items, scaleMode, ready]);

  // Highlight the selected body and label the hovered one.
  useEffect(() => {
    const S = sceneRef.current;
    if (!S || !ready) return;
    const sel = selectedId ? S.positions.get(selectedId) : undefined;
    if (sel) {
      S.highlight.position.copy(sel);
      S.highlight.lookAt(S.camera.position);
      S.highlight.visible = true;
    } else S.highlight.visible = false;
    const hov = hoverId ? S.positions.get(hoverId) : undefined;
    const it = hoverId ? propsRef.current.items.find((i) => i.id === hoverId) : undefined;
    if (hov && it) {
      S.hoverLabel.position.copy(hov);
      S.hoverLabel.element.textContent = `${it.name} · ${it.id === "earth" ? "you are here" : formatDistance(it.distanceKm, propsRef.current.unit)}`;
      S.hoverLabel.visible = true;
    } else S.hoverLabel.visible = false;
    S.dirty = true;
  }, [selectedId, hoverId, items, ready]);

  const view = (preset: "top" | "3d") => {
    const S = sceneRef.current;
    if (!S) return;
    if (preset === "top") S.camera.position.set(0, -0.5, 300);
    else S.camera.position.set(150, -190, 120);
    S.controls.target.set(0, 0, 0);
    S.controls.update();
    S.dirty = true;
  };

  return (
    <div className="solar3d" ref={wrapRef} role="application" aria-label="Solar system">
      <div className="s3d-toolbar">
        <button type="button" onClick={() => view("top")}>Top-down</button>
        <button type="button" onClick={() => view("3d")}>3D</button>
        <button type="button" className={scaleMode === "log" ? "on" : ""} onClick={() => setScaleMode((m) => (m === "log" ? "linear" : "log"))} title="Compressed: distances shrink logarithmically so the inner and outer system both fit. True: real proportions.">
          {scaleMode === "log" ? "Compressed scale" : "True scale"}
        </button>
      </div>
      <div className="solar-legend">
        <span><i className="lg-planet" /> planet</span>
        <span><i className="lg-probe" /> spacecraft</span>
        <span><i className="lg-small" /> dwarf planet · asteroid · comet</span>
        <span><i className="lg-neo" /> close-approach asteroid</span>
        <span className="muted">drag to orbit · wheel to zoom · right-drag to pan · click for details</span>
      </div>
    </div>
  );
}
