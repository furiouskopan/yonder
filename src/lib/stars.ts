import { DEEP_SKY, SOLAR_REGIONS } from "../data/deepsky";
import { KM_PER_AU, KM_PER_LY, formatPeriodDays } from "./units";
import { norm } from "./search";
import type { Target } from "../types";

/** Positional rows as stored in public/data/*.json (see scripts/build_data.py for the field order). */
export type DataRow = (string | number | null)[];

const CONSTELLATIONS: Record<string, string> = {
  And: "Andromeda", Ant: "Antlia", Aps: "Apus", Aqr: "Aquarius", Aql: "Aquila", Ara: "Ara", Ari: "Aries", Aur: "Auriga",
  Boo: "Boötes", Cae: "Caelum", Cam: "Camelopardalis", Cnc: "Cancer", CVn: "Canes Venatici", CMa: "Canis Major",
  CMi: "Canis Minor", Cap: "Capricornus", Car: "Carina", Cas: "Cassiopeia", Cen: "Centaurus", Cep: "Cepheus", Cet: "Cetus",
  Cha: "Chamaeleon", Cir: "Circinus", Col: "Columba", Com: "Coma Berenices", CrA: "Corona Australis", CrB: "Corona Borealis",
  Crv: "Corvus", Crt: "Crater", Cru: "Crux", Cyg: "Cygnus", Del: "Delphinus", Dor: "Dorado", Dra: "Draco", Equ: "Equuleus",
  Eri: "Eridanus", For: "Fornax", Gem: "Gemini", Gru: "Grus", Her: "Hercules", Hor: "Horologium", Hya: "Hydra", Hyi: "Hydrus",
  Ind: "Indus", Lac: "Lacerta", Leo: "Leo", LMi: "Leo Minor", Lep: "Lepus", Lib: "Libra", Lup: "Lupus", Lyn: "Lynx", Lyr: "Lyra",
  Men: "Mensa", Mic: "Microscopium", Mon: "Monoceros", Mus: "Musca", Nor: "Norma", Oct: "Octans", Oph: "Ophiuchus", Ori: "Orion",
  Pav: "Pavo", Peg: "Pegasus", Per: "Perseus", Phe: "Phoenix", Pic: "Pictor", Psc: "Pisces", PsA: "Piscis Austrinus", Pup: "Puppis",
  Pyx: "Pyxis", Ret: "Reticulum", Sge: "Sagitta", Sgr: "Sagittarius", Sco: "Scorpius", Scl: "Sculptor", Sct: "Scutum", Ser: "Serpens",
  Sex: "Sextans", Tau: "Taurus", Tel: "Telescopium", Tri: "Triangulum", TrA: "Triangulum Australe", Tuc: "Tucana", UMa: "Ursa Major",
  UMi: "Ursa Minor", Vel: "Vela", Vir: "Virgo", Vol: "Volans", Vul: "Vulpecula",
};

const byDistance = (a: Target, b: Target): number => a.distanceKm - b.distanceKm;

/**
 * Fixed-distance targets: Solar System regions, the curated deep-sky list, naked-eye stars and
 * exoplanets, sorted by distance. Built once per dataset arrival; distances never change.
 * Star rows: name, ra, dec, ly, mag, con, spect, named. Exoplanet rows: name, host, ly, year,
 * method, radiusEarth, massEarth, periodDays, ra, dec, planets.
 */
export function buildFixedTargets(starRows: DataRow[] | null, exoRows: DataRow[] | null): Target[] {
  const out: Target[] = SOLAR_REGIONS.map((r, i) => ({
    id: `region-${i}`,
    name: r.name,
    category: "solar",
    subtitle: "Region (distance from the Sun)",
    key: norm(`${r.name} region`),
    distanceKm: r.au * KM_PER_AU,
    approx: true,
    note: r.note,
    kind: "region",
    wiki: r.wiki,
  }));

  // Curated objects first; a catalog star with the same name lends its coordinates and is skipped.
  const consumed = new Set<number>();
  const byName = new Map<string, number>();
  starRows?.forEach((s, i) => {
    if (s[7] === 1) byName.set(norm(s[0] as string), i);
  });
  DEEP_SKY.forEach((o, i) => {
    let ra = o.ra;
    let dec = o.dec;
    const j = byName.get(norm(o.name));
    if (j !== undefined && starRows) {
      consumed.add(j);
      ra ??= starRows[j][1] as number;
      dec ??= starRows[j][2] as number;
    }
    out.push({
      id: `dso-${i}`,
      name: o.name,
      category: "star",
      subtitle: o.kind,
      key: norm(`${o.name} ${o.kind}`),
      distanceKm: o.ly * KM_PER_LY,
      approx: o.approx,
      note: o.note,
      kind: o.kind,
      ra,
      dec,
      wiki: o.wiki ?? o.name,
    });
  });

  if (starRows) {
    for (let i = 0; i < starRows.length; i++) {
      if (consumed.has(i)) continue;
      const s = starRows[i];
      const name = s[0] as string;
      const conCode = s[5] as string;
      const con = CONSTELLATIONS[conCode] ?? conCode;
      const mag = s[4] as number;
      const spect = (s[6] as string) || "";
      const named = s[7] === 1;
      out.push({
        id: `hyg-${i}`,
        name,
        category: "star",
        subtitle: `Star in ${con}`,
        key: norm(`${name} star ${conCode}`),
        distanceKm: (s[3] as number) * KM_PER_LY,
        ra: s[1] as number,
        dec: s[2] as number,
        kind: "Star",
        note: `magnitude ${mag.toFixed(1)}${spect ? ` · ${spect}` : ""}`,
        facts: [
          ["Apparent magnitude", mag.toFixed(2)],
          ["Spectral type", spect || "unknown"],
          ["Constellation", con],
        ],
        wiki: named ? name : undefined,
      });
    }
  }
  if (exoRows) {
    for (let i = 0; i < exoRows.length; i++) {
      const p = exoRows[i];
      const name = p[0] as string;
      const host = p[1] as string;
      const year = p[3] as number;
      const method = p[4] as string;
      const radiusEarth = p[5] as number | null;
      const massEarth = p[6] as number | null;
      const periodDays = p[7] as number | null;
      const bits = [
        year ? `found ${year}` : "",
        radiusEarth ? `${radiusEarth.toFixed(1)}× Earth's radius` : "",
        periodDays ? `year lasts ${formatPeriodDays(periodDays)}` : "",
      ].filter(Boolean);
      out.push({
        id: `exo-${i}`,
        name,
        category: "exoplanet",
        subtitle: `Orbits ${host} · ${method}`,
        key: norm(`${name} ${host} exoplanet`),
        distanceKm: (p[2] as number) * KM_PER_LY,
        ra: (p[8] as number | null) ?? undefined,
        dec: (p[9] as number | null) ?? undefined,
        kind: "Exoplanet",
        note: bits.join(" · "),
        facts: [
          ["Host star", host],
          ["Discovered", year ? `${year} by ${method.toLowerCase()}` : method],
          ["Radius", radiusEarth ? `${radiusEarth.toFixed(2)} × Earth` : "unknown"],
          ["Mass", massEarth ? `${massEarth.toFixed(1)} × Earth` : "unknown"],
          ["Orbital period", periodDays ? formatPeriodDays(periodDays) : "unknown"],
          ["Planets in system", String((p[10] as number) || "?")],
        ],
        wiki: name,
        wiki2: host,
      });
    }
  }
  return out.sort(byDistance);
}
