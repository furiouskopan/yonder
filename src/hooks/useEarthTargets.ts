import { useMemo } from "react";
import type { Category, CustomPlace, Origin, Target } from "../types";
import type { StaticData } from "./useStaticData";
import type { PoiRow } from "./usePoi";
import { LANDMARKS } from "../data/landmarks";
import { EARTH_RADIUS_KM, antipode, haversineKm } from "../lib/geo";
import { formatPopulation } from "../lib/units";
import { norm } from "../lib/search";

const AIRPORT_TYPES: Record<string, string> = {
  large_airport: "Major airport",
  medium_airport: "Airport",
  small_airport: "Airfield",
  heliport: "Heliport",
  seaplane_base: "Seaplane base",
  balloonport: "Balloonport",
};

/** Every Earth-bound target with its distance from the origin, sorted nearest first.
 *  Recomputed only when the origin or the datasets change. */
export function useEarthTargets(origin: Origin, data: StaticData | null, custom: CustomPlace[], pois: PoiRow[]): Target[] {
  return useMemo(() => {
    const out: Target[] = [];
    const { lat: olat, lon: olon } = origin;
    const push = (t: Omit<Target, "distanceKm"> & { lat: number; lon: number }) => {
      out.push({ ...t, distanceKm: haversineKm(olat, olon, t.lat, t.lon) } as Target);
    };

    if (data) {
      const names = data.countryNames;
      const capitalCCs = new Set<string>();
      data.cities.forEach((c, i) => {
        const country = names[c.cc] ?? c.cc;
        const category: Category = c.capital ? "capital" : "city";
        if (c.capital) capitalCCs.add(c.cc);
        push({
          id: `city-${i}`,
          name: c.name,
          category,
          subtitle: c.capital ? `Capital of ${country}` : country,
          key: c.key,
          lat: c.lat,
          lon: c.lon,
          note: c.pop > 0 ? `pop. ${formatPopulation(c.pop)}` : undefined,
          kind: category,
          wiki: `${c.name}, ${country}`,
          wiki2: c.name,
        });
      });
      for (const k of data.countries) {
        if (capitalCCs.has(k.cc)) continue;
        push({
          id: `cap-${k.cc}`,
          name: k.capital,
          category: "capital",
          subtitle: `Capital of ${k.name}`,
          key: norm(`${k.capital} ${k.name}`),
          lat: k.lat,
          lon: k.lon,
          note: k.continent,
          kind: "capital",
          wiki: `${k.capital}, ${k.name}`,
          wiki2: k.capital,
        });
      }
      data.towns.forEach((c, i) => {
        const country = names[c.cc] ?? c.cc;
        push({
          id: `town-${i}`,
          name: c.name,
          category: "town",
          subtitle: country,
          key: c.key,
          lat: c.lat,
          lon: c.lon,
          note: c.pop > 0 ? `pop. ${formatPopulation(c.pop)}` : undefined,
          kind: "town",
          wiki: `${c.name}, ${country}`,
          wiki2: c.name,
        });
      });
      data.airports.forEach((a, i) => {
        const country = names[a.cc] ?? a.cc;
        const codes = [a.iata, a.icao].filter(Boolean).join(" / ");
        push({
          id: `apt-${i}`,
          name: a.name,
          category: "airport",
          subtitle: `${AIRPORT_TYPES[a.type] ?? a.type}${codes ? ` · ${codes}` : ""}`,
          key: a.key,
          lat: a.lat,
          lon: a.lon,
          note: [a.municipality, country].filter(Boolean).join(", ") + (a.scheduled ? " · scheduled flights" : ""),
          kind: a.type,
          facts: [
            ["Codes", codes || "none"],
            ["Location", [a.municipality, country].filter(Boolean).join(", ")],
            ["Scheduled service", a.scheduled ? "yes" : "no"],
          ],
          wiki: a.name,
          wiki2: `${a.name} ${a.municipality}`,
        });
      });
    }

    LANDMARKS.forEach((l, i) =>
      push({ id: `lm-${i}`, name: l.name, category: "landmark", subtitle: l.kind, key: norm(`${l.name} ${l.kind}`), lat: l.lat, lon: l.lon, note: l.note, kind: l.kind, wiki: l.name }),
    );
    pois.forEach((p) =>
      push({
        id: `poi-${p.id}`,
        name: p.name,
        category: "poi",
        subtitle: p.kind,
        key: norm(`${p.name} ${p.kind}`),
        lat: p.lat,
        lon: p.lon,
        note: p.ele !== undefined ? `elevation ${Math.round(p.ele)} m` : undefined,
        kind: p.kind,
        facts: [...(p.ele !== undefined ? [["Elevation", `${Math.round(p.ele)} m`] as [string, string]] : []), ...(p.website ? [["Website", p.website] as [string, string]] : [])],
        wiki: p.wiki ?? (p.wikidata ? `wikidata:${p.wikidata}` : undefined) ?? p.name,
        wiki2: p.wiki || p.wikidata ? p.name : undefined,
      }),
    );
    for (const p of custom) push({ id: `custom-${p.id}`, name: p.name, category: "custom", subtitle: "My place", key: norm(p.name), lat: p.lat, lon: p.lon, note: p.note, kind: "custom", wiki: p.name });

    // Computed points
    const ap = antipode(olat, olon);
    push({ id: "antipode", name: "Antipode", category: "landmark", subtitle: "Computed", key: "antipode computed opposite", lat: ap.lat, lon: ap.lon, note: "The farthest surface point from you", kind: "computed", wiki: "Antipodes" });
    out.push({ id: "earth-center", name: "Centre of the Earth", category: "landmark", subtitle: "Computed", key: "centre center of the earth computed", distanceKm: EARTH_RADIUS_KM, note: "Straight down", kind: "computed", wiki: "Earth's inner core" });
    out.push({ id: "karman", name: "Kármán line (edge of space)", category: "landmark", subtitle: "Computed", key: "karman line edge of space computed", distanceKm: 100, note: "Straight up", kind: "computed", wiki: "Kármán line" });

    out.sort((a, b) => a.distanceKm - b.distanceKm);
    return out;
  }, [origin.lat, origin.lon, data, custom, pois]);
}
