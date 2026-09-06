// 3D globe with every tracked satellite orbiting in real time (globe.gl on three.js).
import { useEffect, useRef, useState } from "react";
import Globe from "globe.gl";
import * as THREE from "three";
import type { Origin, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { formatDistance, type Unit } from "../lib/units";

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
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onOriginChange: (lat: number, lon: number) => void;
}

const EARTH_R = 6371;
type GlobeT = InstanceType<typeof Globe>;

interface Layer {
  points: THREE.Points;
  ids: string[];
}

interface Item {
  id: string;
  lat: number;
  lng: number;
  altKm: number;
  color: THREE.Color;
}

function makeLayer(size: number): Layer {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(0), 3));
  const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  return { points, ids: [] };
}

function fillLayer(layer: Layer, globe: GlobeT, items: Item[]): void {
  const n = items.length;
  const geom = layer.points.geometry;
  let pos = geom.getAttribute("position") as THREE.BufferAttribute;
  let col = geom.getAttribute("color") as THREE.BufferAttribute;
  if (pos.count !== n) {
    pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    geom.setAttribute("position", pos);
    geom.setAttribute("color", col);
  }
  const pa = pos.array as Float32Array;
  const ca = col.array as Float32Array;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const c = globe.getCoords(it.lat, it.lng, it.altKm / EARTH_R);
    pa[i * 3] = c.x;
    pa[i * 3 + 1] = c.y;
    pa[i * 3 + 2] = c.z;
    ca[i * 3] = it.color.r;
    ca[i * 3 + 1] = it.color.g;
    ca[i * 3 + 2] = it.color.b;
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geom.computeBoundingSphere();
  layer.ids = items.map((i) => i.id);
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

export default function GlobeView(props: Props) {
  const { origin, earthRows, sats, aircraft, selected, hoverId, track, trackHeightKm, unit, dark } = props;
  const divRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeT | null>(null);
  const layersRef = useRef<{ sats: Layer; earth: Layer; air: Layer } | null>(null);
  const highlightRef = useRef<THREE.Mesh | null>(null);
  const byIdRef = useRef(new Map<string, Target>());
  const lastPickRef = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; id: string } | null>(null);

  // Create the globe once.
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const globe = new Globe(el, { animateIn: false, rendererConfig: { antialias: true, alpha: true } });
    globe
      .globeImageUrl(dark ? "/textures/earth-night.jpg" : "/textures/earth-day.jpg")
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
    globe.pointOfView({ lat: origin.lat, lng: origin.lon, altitude: 2.2 }, 0);
    const controls = globe.controls() as unknown as { enableDamping: boolean; dampingFactor: number; autoRotate: boolean; zoomSpeed: number };
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.autoRotate = false;
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

    // Picking against the point layers.
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.4 };
    const mouse = new THREE.Vector2();
    const dom = globe.renderer().domElement;
    let last = 0;
    const pick = (ev: PointerEvent | MouseEvent): string | null => {
      const L = layersRef.current;
      if (!L) return null;
      const rect = dom.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, globe.camera() as THREE.Camera);
      const hits = raycaster.intersectObjects([L.sats.points, L.air.points, L.earth.points], false);
      for (const h of hits) {
        const layer = h.object === L.sats.points ? L.sats : h.object === L.air.points ? L.air : L.earth;
        if (h.index !== undefined && layer.ids[h.index]) return layer.ids[h.index];
      }
      return null;
    };
    const onMove = (ev: PointerEvent) => {
      const t = performance.now();
      if (t - last < 40) return;
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
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("click", onClick);
    dom.addEventListener("pointerleave", onLeave);
    const ro = new ResizeObserver(() => globe.width(el.clientWidth).height(el.clientHeight));
    ro.observe(el);
    setReady(true);
    return () => {
      ro.disconnect();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("click", onClick);
      dom.removeEventListener("pointerleave", onLeave);
      globe._destructor();
      globeRef.current = null;
      layersRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    globeRef.current?.globeImageUrl(dark ? "/textures/earth-night.jpg" : "/textures/earth-day.jpg");
  }, [dark]);

  // Origin marker and label; fly there when it moves.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !ready) return;
    globe.pointsData([{ lat: origin.lat, lng: origin.lon, color: "#ef4444", alt: 0.01, r: 0.45 }]);
    globe.labelsData([{ lat: origin.lat, lng: origin.lon, text: origin.name }]);
    globe.pointOfView({ lat: origin.lat, lng: origin.lon }, 900);
  }, [origin.lat, origin.lon, origin.name, ready]);

  useEffect(() => {
    const globe = globeRef.current;
    const L = layersRef.current;
    if (!globe || !L || !ready) return;
    const items: Item[] = [];
    for (const t of sats) {
      if (t.subLat === undefined || t.subLon === undefined) continue;
      byIdRef.current.set(t.id, t);
      items.push({ id: t.id, lat: t.subLat, lng: t.subLon, altKm: t.heightKm ?? 400, color: color((t.altDeg ?? -1) >= 0 ? "#22d3ee" : "#0e7490") });
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
      byIdRef.current.set(t.id, t);
      items.push({ id: t.id, lat: t.lat, lng: t.lon, altKm: 8, color: color(CATEGORY_BY_ID[t.category].color) });
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
      byIdRef.current.set(t.id, t);
      items.push({ id: t.id, lat: t.lat, lng: t.lon, altKm: Math.max(2, t.heightKm ?? 0), color: color("#eab308") });
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
    globe.pathsData(track && track.length > 1 ? [{ pts: track.map(([la, lo]) => [la, lo, trackHeightKm / EARTH_R]) }] : []);
  }, [track, trackHeightKm, ready]);

  const tipTarget = tip ? byIdRef.current.get(tip.id) : undefined;
  const hoverTarget = !tip && hoverId ? byIdRef.current.get(hoverId) : undefined;

  return (
    <div className="globe" ref={divRef}>
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
      <div className="globe-legend">
        <span><i style={{ background: "#22d3ee" }} /> satellite above your horizon</span>
        <span><i style={{ background: "#0e7490" }} /> below</span>
        <span><i style={{ background: "#eab308" }} /> aircraft</span>
        <span className="muted">drag to rotate · wheel to zoom · click a dot for details</span>
      </div>
    </div>
  );
}
