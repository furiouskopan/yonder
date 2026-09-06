// 2D map on Leaflet. The map is created once; later effects diff marker sets by id so satellite and
// aircraft markers move instead of being recreated. Circle markers are drawn on a canvas renderer
// (one element for all of them) rather than as individual SVG paths, and tooltips are functions
// evaluated only when shown, so the per-second update touches no DOM.
import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Origin, Target } from "../types";
import { CATEGORY_BY_ID } from "../types";
import { antipode, greatCirclePath, normalizeLon, splitAtDateline } from "../lib/geo";
import { formatDistance, formatLightTime, type Unit } from "../lib/units";
import { noteOf } from "../lib/target";
import { describeQuery, fetchDescription } from "../hooks/useDescription";

interface Props {
  origin: Origin;
  onOriginChange: (lat: number, lon: number, name?: string) => void;
  pinOnClick: boolean;
  earthRows: Target[];
  satRows: Target[];
  airRows: Target[];
  selected: Target | null;
  hoverId: string | null;
  track: [number, number][] | null;
  unit: Unit;
  basemap: string;
  dark: boolean;
  onBasemap: (id: string) => void;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}

interface Basemap {
  label: string;
  url: string;
  labelsUrl?: string; // a second tile layer with place names, drawn above the base
  attribution: string;
  maxZoom: number;
  subdomains?: string;
}

export const BASEMAPS: Record<string, Basemap> = {
  // CARTO's free tiles started returning "API KEY REQUIRED" watermarks; Esri's canvases need no key.
  dark: {
    label: "Dark",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    labelsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors",
    maxZoom: 16,
  },
  light: {
    label: "Light",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    labelsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors",
    maxZoom: 16,
  },
  osm: {
    label: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  satellite: {
    label: "Satellite imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxZoom: 19,
  },
  terrain: {
    label: "Terrain",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: 'Map data &copy; OpenStreetMap contributors, SRTM · style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxZoom: 17,
  },
};

const SAT_UP = "#06b6d4";
const SAT_DOWN = "#0e7490";
const PLANE_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#eab308" stroke="#1f2937" stroke-width="0.7" d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>';

const radiusFor = (t: Target): number => (t.category === "satellite" ? 4 : t.category === "city" || t.category === "town" ? 3 : t.category === "airport" ? 3.5 : 5);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function popupContent(t: Target, unit: Unit, onSelect: (id: string) => void, onOrigin: (t: Target) => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "popup";
  const canOrigin = t.lat !== undefined && CATEGORY_BY_ID[t.category].realm === "earth";
  const note = noteOf(t) ?? "";
  el.innerHTML =
    `<div class="popup-title">${esc(t.name)}</div>` +
    `<div class="popup-sub">${esc(t.subtitle ?? "")}</div>` +
    `<div class="popup-dist">${esc(formatDistance(t.distanceKm, unit))} · ${esc(formatLightTime(t.distanceKm))}</div>` +
    `<div class="popup-desc muted">${t.category === "aircraft" ? esc(note) : "Looking up a description…"}</div>` +
    `<div class="popup-actions"><button type="button" data-act="details">Details</button>${canOrigin ? '<button type="button" data-act="origin">Set as origin</button>' : ""}</div>`;
  el.querySelector('[data-act="details"]')?.addEventListener("click", () => onSelect(t.id));
  el.querySelector('[data-act="origin"]')?.addEventListener("click", () => onOrigin(t));
  const spec = describeQuery(t);
  if (spec) {
    fetchDescription(spec)
      .then((d) => {
        const box = el.querySelector(".popup-desc");
        if (!box) return;
        if (!d.title || !d.extract) {
          box.textContent = note || "No description found.";
          return;
        }
        const text = d.extract.length > 260 ? `${d.extract.slice(0, 257).trimEnd()}…` : d.extract;
        box.innerHTML = `${d.thumbnail ? `<img src="${esc(d.thumbnail.source)}" alt="">` : ""}<span>${esc(text)}</span>`;
        box.classList.remove("muted");
      })
      .catch(() => {
        const box = el.querySelector(".popup-desc");
        if (box) box.textContent = note;
      });
  }
  return el;
}

export default function MapView(props: Props) {
  const { origin, earthRows, satRows, airRows, selected, hoverId, track, unit, basemap, dark } = props;
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const originRef = useRef<L.Marker | null>(null);
  const baseLayers = useRef<Record<string, L.Layer>>({});
  const layers = useRef<{ earth: L.LayerGroup; sats: L.LayerGroup; air: L.LayerGroup; track: L.LayerGroup; focus: L.LayerGroup } | null>(null);
  const earthMarkers = useRef(new Map<string, L.CircleMarker>());
  const satMarkers = useRef(new Map<string, L.CircleMarker>());
  const satUp = useRef(new Map<string, boolean>());
  const airMarkers = useRef(new Map<string, L.Marker>());
  const airSvg = useRef(new Map<string, SVGElement>());
  /** Latest Target per marker id; tooltips and popups read from here so they always show current numbers. */
  const latest = useRef(new Map<string, Target>());
  const highlighted = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const tipFor = (id: string) => () => {
    const t = latest.current.get(id);
    if (!t) return "";
    const u = propsRef.current.unit;
    const extra = t.category === "satellite" ? ` · ${Math.round(t.heightKm ?? 0)} km up` : t.category === "aircraft" ? ` · ${noteOf(t) ?? ""}` : "";
    return `${t.name} · ${formatDistance(t.distanceKm, u)}${extra}`;
  };

  const openPopup = (id: string, fallback: Target, latlng: L.LatLngExpression) => {
    const map = mapRef.current;
    if (!map) return;
    const p = propsRef.current;
    const t = latest.current.get(id) ?? fallback;
    L.popup({ maxWidth: 340, className: "yonder-popup" })
      .setLatLng(latlng)
      .setContent(popupContent(t, p.unit, (tid) => p.onSelect(tid), (tt) => p.onOriginChange(tt.lat!, tt.lon!, tt.name)))
      .openOn(map);
  };

  const switchBase = (id: string) => {
    const map = mapRef.current;
    const bases = baseLayers.current;
    if (!map || !bases[id] || map.hasLayer(bases[id])) return;
    for (const l of Object.values(bases)) if (map.hasLayer(l)) map.removeLayer(l);
    bases[id].addTo(map);
  };

  // Create the map once.
  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const map = L.map(el, { worldCopyJump: true, minZoom: 1, zoomControl: true, preferCanvas: true }).setView([origin.lat, origin.lon], 3);
    const bases: Record<string, L.Layer> = {};
    const control: Record<string, L.Layer> = {};
    for (const [id, b] of Object.entries(BASEMAPS)) {
      const opts = { maxZoom: b.maxZoom, subdomains: b.subdomains ?? "abc", updateWhenIdle: true, keepBuffer: 3 };
      const base = L.tileLayer(b.url, { ...opts, attribution: b.attribution });
      bases[id] = b.labelsUrl ? L.layerGroup([base, L.tileLayer(b.labelsUrl, { ...opts, pane: "shadowPane" })]) : base;
      control[b.label] = bases[id];
    }
    baseLayers.current = bases;
    const initial = basemap !== "auto" && bases[basemap] ? basemap : dark ? "dark" : "light";
    bases[initial].addTo(map);

    const earth = L.layerGroup().addTo(map);
    const trackL = L.layerGroup().addTo(map);
    const sats = L.layerGroup().addTo(map);
    const air = L.layerGroup().addTo(map);
    const focus = L.layerGroup().addTo(map);
    layers.current = { earth, sats, air, track: trackL, focus };
    L.control.layers(control, { Places: earth, Satellites: sats, Aircraft: air, "Ground track": trackL }, { position: "topright" }).addTo(map);
    map.on("baselayerchange", (e: L.LayersControlEvent) => {
      const id = Object.entries(bases).find(([, layer]) => layer === e.layer)?.[0];
      if (id) propsRef.current.onBasemap(id);
    });

    const icon = L.divIcon({ className: "origin-pin", html: "<div class='origin-pin-dot'></div>", iconSize: [18, 18], iconAnchor: [9, 9] });
    const marker = L.marker([origin.lat, origin.lon], { icon, draggable: true, zIndexOffset: 1000, title: "Origin (drag to move)" }).addTo(map);
    marker.on("dragend", () => {
      const p = marker.getLatLng();
      propsRef.current.onOriginChange(p.lat, normalizeLon(p.lng));
    });
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (propsRef.current.pinOnClick) propsRef.current.onOriginChange(e.latlng.lat, normalizeLon(e.latlng.lng));
    });
    originRef.current = marker;
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      earthMarkers.current.clear();
      satMarkers.current.clear();
      satUp.current.clear();
      airMarkers.current.clear();
      airSvg.current.clear();
      latest.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    originRef.current?.setLatLng([origin.lat, origin.lon]);
  }, [origin.lat, origin.lon]);

  // Earth targets shown on the map (nearest first; stable between origin changes).
  useEffect(() => {
    const layer = layers.current?.earth;
    if (!layer) return;
    layer.clearLayers();
    for (const id of earthMarkers.current.keys()) latest.current.delete(id);
    earthMarkers.current.clear();
    for (const t of earthRows) {
      if (t.lat === undefined || t.lon === undefined) continue;
      const color = CATEGORY_BY_ID[t.category].color;
      const m = L.circleMarker([t.lat, t.lon], { radius: radiusFor(t), color, fillColor: color, fillOpacity: 0.85, weight: 1 });
      latest.current.set(t.id, t);
      m.bindTooltip(tipFor(t.id));
      m.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        openPopup(t.id, t, e.latlng);
      });
      m.on("mouseover", () => propsRef.current.onHover(t.id));
      m.on("mouseout", () => propsRef.current.onHover(null));
      layer.addLayer(m);
      earthMarkers.current.set(t.id, m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earthRows]);

  // Satellite ground points, updated every second; markers are reused and restyled only when they cross the horizon.
  useEffect(() => {
    const layer = layers.current?.sats;
    if (!layer) return;
    const seen = new Set<string>();
    for (const t of satRows) {
      if (t.subLat === undefined || t.subLon === undefined) continue;
      seen.add(t.id);
      latest.current.set(t.id, t);
      const up = (t.altDeg ?? -1) >= 0;
      let m = satMarkers.current.get(t.id);
      if (!m) {
        m = L.circleMarker([t.subLat, t.subLon], { radius: 4, color: SAT_UP, fillColor: up ? SAT_UP : SAT_DOWN, fillOpacity: 0.9, weight: 1 });
        m.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          openPopup(t.id, t, e.latlng);
        });
        m.on("mouseover", () => propsRef.current.onHover(t.id));
        m.on("mouseout", () => propsRef.current.onHover(null));
        m.bindTooltip(tipFor(t.id));
        layer.addLayer(m);
        satMarkers.current.set(t.id, m);
        satUp.current.set(t.id, up);
      } else {
        m.setLatLng([t.subLat, t.subLon]);
        if (satUp.current.get(t.id) !== up) {
          m.setStyle({ fillColor: up ? SAT_UP : SAT_DOWN });
          satUp.current.set(t.id, up);
        }
      }
    }
    for (const [id, m] of satMarkers.current) {
      if (!seen.has(id)) {
        layer.removeLayer(m);
        satMarkers.current.delete(id);
        satUp.current.delete(id);
        latest.current.delete(id);
      }
    }
  }, [satRows]);

  // Aircraft: rotated plane icons, dead-reckoned every second.
  useEffect(() => {
    const layer = layers.current?.air;
    if (!layer) return;
    const seen = new Set<string>();
    for (const t of airRows) {
      if (t.lat === undefined || t.lon === undefined) continue;
      seen.add(t.id);
      latest.current.set(t.id, t);
      let m = airMarkers.current.get(t.id);
      if (!m) {
        const icon = L.divIcon({ className: "plane-icon", html: PLANE_SVG, iconSize: [20, 20], iconAnchor: [10, 10] });
        m = L.marker([t.lat, t.lon], { icon, zIndexOffset: 500 });
        m.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          openPopup(t.id, t, e.latlng);
        });
        m.on("mouseover", () => propsRef.current.onHover(t.id));
        m.on("mouseout", () => propsRef.current.onHover(null));
        m.bindTooltip(tipFor(t.id));
        layer.addLayer(m);
        airMarkers.current.set(t.id, m);
        const svg = m.getElement()?.querySelector("svg");
        if (svg) airSvg.current.set(t.id, svg);
      } else {
        m.setLatLng([t.lat, t.lon]);
      }
      const svg = airSvg.current.get(t.id);
      if (svg) svg.style.transform = `rotate(${t.heading ?? 0}deg)`;
    }
    for (const [id, m] of airMarkers.current) {
      if (!seen.has(id)) {
        layer.removeLayer(m);
        airMarkers.current.delete(id);
        airSvg.current.delete(id);
        latest.current.delete(id);
      }
    }
  }, [airRows]);

  // Hover sync from the table.
  useEffect(() => {
    const style = (id: string | null, on: boolean) => {
      if (!id) return;
      const cm = earthMarkers.current.get(id) ?? satMarkers.current.get(id);
      const t = latest.current.get(id);
      if (cm && t) cm.setStyle({ weight: on ? 3 : 1, radius: on ? 8 : radiusFor(t) });
      const am = airMarkers.current.get(id);
      am?.getElement()?.classList.toggle("hovered", on);
    };
    style(highlighted.current, false);
    style(hoverId, true);
    highlighted.current = hoverId;
  }, [hoverId]);

  // Selected target: great-circle line, plus the antipode marker.
  useEffect(() => {
    const layer = layers.current?.focus;
    if (!layer) return;
    layer.clearLayers();
    const ap = antipode(origin.lat, origin.lon);
    L.circleMarker([ap.lat, ap.lon], { radius: 5, color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.5, weight: 1, dashArray: "2 2" }).bindTooltip("Antipode of your origin").addTo(layer);
    if (!selected) return;
    const lat = selected.lat ?? selected.subLat;
    const lon = selected.lon ?? selected.subLon;
    if (lat === undefined || lon === undefined) return;
    if (selected.lat !== undefined && CATEGORY_BY_ID[selected.category].realm === "earth") {
      for (const seg of splitAtDateline(greatCirclePath(origin.lat, origin.lon, lat, lon))) L.polyline(seg, { color: "#f59e0b", weight: 2.5, opacity: 0.9 }).addTo(layer);
    } else {
      L.polyline([[origin.lat, origin.lon], [lat, lon]], { color: "#f59e0b", weight: 1.5, opacity: 0.7, dashArray: "4 4" }).addTo(layer);
    }
    L.circleMarker([lat, lon], { radius: 9, color: "#f59e0b", fillOpacity: 0.2, weight: 2 }).bindTooltip(`${selected.name} · ${formatDistance(selected.distanceKm, unit)}`).addTo(layer);
  }, [selected, origin.lat, origin.lon, unit]);

  // Pan to a newly selected target.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected) return;
    const lat = selected.lat ?? selected.subLat;
    const lon = selected.lon ?? selected.subLon;
    if (lat === undefined || lon === undefined) return;
    map.fitBounds(L.latLngBounds([origin.lat, origin.lon], [lat, lon]).pad(0.25), { maxZoom: 9, animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Ground track of the selected satellite (or the ISS).
  useEffect(() => {
    const layer = layers.current?.track;
    if (!layer) return;
    layer.clearLayers();
    if (!track || track.length < 2) return;
    for (const seg of splitAtDateline(track)) L.polyline(seg, { color: SAT_UP, weight: 1.5, opacity: 0.7, dashArray: "4 4" }).addTo(layer);
  }, [track]);

  // Basemap chosen elsewhere (restored preference), or the theme changed while on "auto".
  useEffect(() => {
    if (basemap === "auto") switchBase(dark ? "dark" : "light");
    else switchBase(basemap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, dark]);

  return <div className="map" ref={divRef} role="application" aria-label="Map" />;
}
