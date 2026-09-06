import { useEffect, useState } from "react";
import { norm } from "../lib/search";

export interface PlaceRow {
  name: string;
  cc: string;
  lat: number;
  lon: number;
  pop: number;
  capital: boolean;
  key: string;
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

export interface AirportRow {
  name: string;
  type: string;
  iata: string;
  icao: string;
  lat: number;
  lon: number;
  cc: string;
  municipality: string;
  scheduled: boolean;
  key: string;
}

export interface ExoRow {
  name: string;
  host: string;
  ly: number;
  year: number;
  method: string;
  radiusEarth: number | null;
  massEarth: number | null;
  periodDays: number | null;
  ra: number | null;
  dec: number | null;
  planets: number;
  key: string;
}

export interface StarRow {
  name: string;
  ra: number;
  dec: number;
  ly: number;
  mag: number;
  con: string;
  spect: string;
  named: boolean;
  key: string;
}

export interface StaticData {
  cities: PlaceRow[];
  towns: PlaceRow[];
  countries: CountryRow[];
  countryNames: Record<string, string>;
  airports: AirportRow[];
  exoplanets: ExoRow[];
  stars: StarRow[];
}

export type DatasetName = "cities" | "towns" | "airports" | "exoplanets" | "stars";

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

type Row = (string | number)[];

export function useStaticData(): { data: StaticData | null; loading: DatasetName[]; error: string | null } {
  const [data, setData] = useState<StaticData | null>(null);
  const [loading, setLoading] = useState<DatasetName[]>(["cities", "towns", "airports", "exoplanets", "stars"]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const done = (name: DatasetName) => setLoading((l) => l.filter((x) => x !== name));

    (async () => {
      try {
        const [c, k] = await Promise.all([
          getJson<{ rows: Row[] }>("/data/cities.json"),
          getJson<{ names: Record<string, string>; countries: CountryRow[] }>("/data/countries.json"),
        ]);
        if (cancelled) return;
        const names = k.names;
        const cities: PlaceRow[] = c.rows.map((r) => ({
          name: r[0] as string,
          cc: r[1] as string,
          lat: r[2] as number,
          lon: r[3] as number,
          pop: r[4] as number,
          capital: r[5] === 1,
          key: norm(`${r[0]} ${names[r[1] as string] ?? r[1]}`),
        }));
        setData({ cities, towns: [], countries: k.countries, countryNames: names, airports: [], exoplanets: [], stars: [] });
        done("cities");

        // The big optional datasets load afterwards and appear as they arrive.
        void getJson<{ rows: Row[] }>("/data/places.json")
          .then((p) => {
            if (cancelled) return;
            const towns: PlaceRow[] = p.rows.map((r) => ({
              name: r[0] as string,
              cc: r[1] as string,
              lat: r[2] as number,
              lon: r[3] as number,
              pop: r[4] as number,
              capital: false,
              key: norm(`${r[0]} ${names[r[1] as string] ?? r[1]}`),
            }));
            setData((d) => (d ? { ...d, towns } : d));
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("towns"));

        void getJson<{ rows: Row[] }>("/data/airports.json")
          .then((a) => {
            if (cancelled) return;
            const airports: AirportRow[] = a.rows.map((r) => ({
              name: r[0] as string,
              type: r[1] as string,
              iata: r[2] as string,
              icao: r[3] as string,
              lat: r[4] as number,
              lon: r[5] as number,
              cc: r[6] as string,
              municipality: r[7] as string,
              scheduled: r[8] === 1,
              key: norm(`${r[0]} ${r[2]} ${r[3]} ${r[7]} ${names[r[6] as string] ?? r[6]}`),
            }));
            setData((d) => (d ? { ...d, airports } : d));
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("airports"));

        void getJson<{ rows: Row[] }>("/data/exoplanets.json")
          .then((x) => {
            if (cancelled) return;
            const exoplanets: ExoRow[] = x.rows.map((r) => ({
              name: r[0] as string,
              host: r[1] as string,
              ly: r[2] as number,
              year: r[3] as number,
              method: r[4] as string,
              radiusEarth: (r[5] as number | null) ?? null,
              massEarth: (r[6] as number | null) ?? null,
              periodDays: (r[7] as number | null) ?? null,
              ra: (r[8] as number | null) ?? null,
              dec: (r[9] as number | null) ?? null,
              planets: r[10] as number,
              key: norm(`${r[0]} ${r[1]} exoplanet`),
            }));
            setData((d) => (d ? { ...d, exoplanets } : d));
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("exoplanets"));

        void getJson<{ rows: Row[] }>("/data/stars.json")
          .then((s) => {
            if (cancelled) return;
            const stars: StarRow[] = s.rows.map((r) => ({
              name: r[0] as string,
              ra: r[1] as number,
              dec: r[2] as number,
              ly: r[3] as number,
              mag: r[4] as number,
              con: r[5] as string,
              spect: r[6] as string,
              named: r[7] === 1,
              key: norm(`${r[0]} star ${r[5]}`),
            }));
            setData((d) => (d ? { ...d, stars } : d));
          })
          .catch((e: Error) => console.warn(e.message))
          .finally(() => done("stars"));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}
