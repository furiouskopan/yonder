import { DEEP_SKY, SOLAR_REGIONS } from "../data/deepsky";
import { KM_PER_AU, KM_PER_LY, formatPeriodDays } from "./units";
import { norm } from "./search";
import type { Target } from "../types";
import type { StaticData } from "../hooks/useStaticData";

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

/** Fixed-distance targets: the curated deep-sky list, naked-eye stars, exoplanets and Solar System regions. */
export function buildFixedTargets(data: StaticData | null): Target[] {
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
  data?.stars.forEach((s, i) => {
    if (s.named) byName.set(norm(s.name), i);
  });
  DEEP_SKY.forEach((o, i) => {
    let ra = o.ra;
    let dec = o.dec;
    const j = byName.get(norm(o.name));
    if (j !== undefined && data) {
      consumed.add(j);
      ra ??= data.stars[j].ra;
      dec ??= data.stars[j].dec;
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

  if (data) {
    data.stars.forEach((s, i) => {
      if (consumed.has(i)) return;
      const con = CONSTELLATIONS[s.con] ?? s.con;
      out.push({
        id: `hyg-${i}`,
        name: s.name,
        category: "star",
        subtitle: `Star in ${con}`,
        key: s.key,
        distanceKm: s.ly * KM_PER_LY,
        ra: s.ra,
        dec: s.dec,
        kind: "Star",
        note: `magnitude ${s.mag.toFixed(1)}${s.spect ? ` · ${s.spect}` : ""}`,
        facts: [
          ["Apparent magnitude", s.mag.toFixed(2)],
          ["Spectral type", s.spect || "unknown"],
          ["Constellation", con],
        ],
        wiki: s.named ? s.name : undefined,
      });
    });
    data.exoplanets.forEach((p, i) => {
      const bits = [
        p.year ? `found ${p.year}` : "",
        p.radiusEarth ? `${p.radiusEarth.toFixed(1)}× Earth's radius` : "",
        p.periodDays ? `year lasts ${formatPeriodDays(p.periodDays)}` : "",
      ].filter(Boolean);
      out.push({
        id: `exo-${i}`,
        name: p.name,
        category: "exoplanet",
        subtitle: `Orbits ${p.host} · ${p.method}`,
        key: p.key,
        distanceKm: p.ly * KM_PER_LY,
        ra: p.ra ?? undefined,
        dec: p.dec ?? undefined,
        kind: "Exoplanet",
        note: bits.join(" · "),
        facts: [
          ["Host star", p.host],
          ["Discovered", p.year ? `${p.year} by ${p.method.toLowerCase()}` : p.method],
          ["Radius", p.radiusEarth ? `${p.radiusEarth.toFixed(2)} × Earth` : "unknown"],
          ["Mass", p.massEarth ? `${p.massEarth.toFixed(1)} × Earth` : "unknown"],
          ["Orbital period", p.periodDays ? formatPeriodDays(p.periodDays) : "unknown"],
          ["Planets in system", String(p.planets || "?")],
        ],
        wiki: p.name,
        wiki2: p.host,
      });
    });
  }
  return out;
}
