// Loads the offline bundles in public/data/ and turns them straight into Target objects.
// Rows are positional arrays (see scripts/build_data.py); no intermediate row objects are kept,
// so each place exists exactly once in memory. Conversion runs in slices between frames so a
// 200k-row file does not freeze the page while it is being processed.
import { useEffect, useState } from "react";
import type { Target } from "../types";
import { norm } from "../lib/search";
import { buildFixedTargets, type DataRow } from "../lib/stars";

export interface StaticData {
  /** Cities, capitals, towns and airports in catalogue order. `distanceKm` is NaN until useEarthTargets assigns it in place. */
  earth: Target[];
  /** Stars, deep-sky objects, exoplanets and Solar System regions, sorted by distance. */
  fixed: Target[];
  countryNames: Record<string, string>;
}

export interface CountryRow {
  cc: string;
  name: string;
  capital: string;
  lat: number;
  lon: number;
  pop: number;
  continent: string;
}

export type DatasetName = "cities" | "towns" | "airports" | "exoplanets" | "stars";

const AIRPORT_TYPES: Record<string, string> = {
  large_airport: "Major airport",
  medium_airport: "Airport",
  small_airport: "Airfield",
  heliport: "Heliport",
  seaplane_base: "Seaplane base",
  balloonport: "Balloonport",
};

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

const yieldToMain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Map rows to targets in slices so the UI keeps responding while big datasets are converted. */
async function mapChunked<T>(rows: DataRow[], fn: (r: DataRow, i: number) => T, alive: () => boolean, chunk = 12_000): Promise<T[]> {
  const out = new Array<T>(rows.length);
  for (let i = 0; i < rows.length; i += chunk) {
    if (!alive()) return out;
    const end = Math.min(rows.length, i + chunk);
    for (let k = i; k < end; k++) out[k] = fn(rows[k], k);
    if (end < rows.length) await yieldToMain();
  }
  return out;
}

interface Countries {
  names: Record<string, string>;
  keys: Record<string, string>; // normalised country name per code, so 300k rows do not re-normalise it
  countries: CountryRow[];
}

// Cities and towns share a shape: name, cc, lat, lon, pop[, capital]
function placeTarget(r: DataRow, id: string, capital: boolean, c: Countries): Target {
  const name = r[0] as string;
  const cc = r[1] as string;
  const country = c.names[cc] ?? cc;
  return {
    id,
    name,
    category: capital ? "capital" : id.startsWith("town") ? "town" : "city",
    subtitle: capital ? `Capital of ${country}` : country,
    key: `${norm(name)} ${c.keys[cc] ?? norm(cc)}`,
    distanceKm: NaN,
    lat: r[2] as number,
    lon: r[3] as number,
    pop: (r[4] as number) || undefined,
  };
}

// name, type, iata, icao, lat, lon, cc, municipality, scheduled
function airportTarget(r: DataRow, i: number, c: Countries): Target {
  const name = r[0] as string;
  const type = r[1] as string;
  const iata = r[2] as string;
  const icao = r[3] as string;
  const cc = r[6] as string;
  const muni = r[7] as string;
  const country = c.names[cc] ?? cc;
  const codes = iata && icao ? `${iata} / ${icao}` : iata || icao;
  const label = AIRPORT_TYPES[type] ?? type;
  return {
    id: `apt-${i}`,
    name,
    category: "airport",
    subtitle: codes ? `${label} · ${codes}` : label,
    key: `${norm(`${name} ${iata} ${icao} ${muni}`)} ${c.keys[cc] ?? norm(cc)}`,
    distanceKm: NaN,
    lat: r[4] as number,
    lon: r[5] as number,
    kind: type,
    note: `${muni ? `${muni}, ${country}` : country}${r[8] === 1 ? " · scheduled flights" : ""}`,
  };
}

export function useStaticData(): { data: StaticData | null; loading: DatasetName[]; error: string | null } {
  const [data, setData] = useState<StaticData | null>(null);
  const [loading, setLoading] = useState<DatasetName[]>(["cities", "towns", "airports", "exoplanets", "stars"]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const alive = () => live;
    const done = (name: DatasetName) => setLoading((l) => l.filter((x) => x !== name));
    const patch = (fn: (d: StaticData) => StaticData) => setData((d) => (d ? fn(d) : d));

    (async () => {
      try {
        const [c, k] = await Promise.all([
          getJson<{ rows: DataRow[] }>("/data/cities.json"),
          getJson<{ names: Record<string, string>; countries: CountryRow[] }>("/data/countries.json"),
        ]);
        if (!live) return;
        const countries: Countries = { names: k.names, keys: Object.fromEntries(Object.entries(k.names).map(([cc, n]) => [cc, norm(n)])), countries: k.countries };
        const capitalCCs = new Set<string>();
        const cities = await mapChunked(
          c.rows,
          (r, i) => {
            const capital = r[5] === 1;
            if (capital) capitalCCs.add(r[1] as string);
            return placeTarget(r, `city-${i}`, capital, countries);
          },
          alive,
        );
        if (!live) return;
        // Countries whose capital is smaller than 15,000 people still get a capital row.
        for (const ct of k.countries) {
          if (capitalCCs.has(ct.cc)) continue;
          cities.push({
            id: `cap-${ct.cc}`,
            name: ct.capital,
            category: "capital",
            subtitle: `Capital of ${ct.name}`,
            key: `${norm(ct.capital)} ${countries.keys[ct.cc] ?? ""}`,
            distanceKm: NaN,
            lat: ct.lat,
            lon: ct.lon,
            note: ct.continent,
          });
        }
        setData({ earth: cities, fixed: buildFixedTargets(null, null), countryNames: k.names });
        done("cities");

        // The big optional datasets load afterwards and appear as they arrive.
        void getJson<{ rows: DataRow[] }>("/data/places.json")
          .then(async (p) => {
            const towns = await mapChunked(p.rows, (r, i) => placeTarget(r, `town-${i}`, false, countries), alive);
            if (live) patch((d) => ({ ...d, earth: d.earth.concat(towns) }));
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("towns"));

        void getJson<{ rows: DataRow[] }>("/data/airports.json")
          .then(async (a) => {
            const airports = await mapChunked(a.rows, (r, i) => airportTarget(r, i, countries), alive);
            if (live) patch((d) => ({ ...d, earth: d.earth.concat(airports) }));
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("airports"));

        let starRows: DataRow[] | null = null;
        let exoRows: DataRow[] | null = null;
        const rebuildFixed = () => patch((d) => ({ ...d, fixed: buildFixedTargets(starRows, exoRows) }));
        void getJson<{ rows: DataRow[] }>("/data/exoplanets.json")
          .then((x) => {
            if (!live) return;
            exoRows = x.rows;
            rebuildFixed();
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("exoplanets"));
        void getJson<{ rows: DataRow[] }>("/data/stars.json")
          .then((s) => {
            if (!live) return;
            starRows = s.rows;
            rebuildFixed();
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("stars"));
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return { data, loading, error };
}
