// CelesTrak's satellite catalog (SATCAT): owner, launch date and site, object type and orbit
// for every catalogued object. Downloaded weekly and cached on disk.
import { readCache, writeCache } from "./cache";

export interface SatcatRecord {
  norad: number;
  type: string;
  status: string;
  owner: string;
  launched: string;
  site: string;
  period: number | null;
  inc: number | null;
  apogee: number | null;
  perigee: number | null;
  rcs: number | null;
  orbitType: string;
}

export interface SatcatFacts {
  owner: string;
  launched: string;
  site: string;
  type: string;
  status: string;
  period: number | null;
  inc: number | null;
  apogee: number | null;
  perigee: number | null;
  rcs: number | null;
}

const URL = "https://celestrak.org/pub/satcat.csv";
const TTL_MS = 7 * 24 * 3600e3;
let table: Map<number, SatcatRecord> | null = null;
let loading: Promise<Map<number, SatcatRecord>> | null = null;

export const OWNER_NAMES: Record<string, string> = {
  US: "United States", CIS: "Russia (CIS)", PRC: "China", ESA: "European Space Agency", JPN: "Japan",
  IND: "India", UK: "United Kingdom", FR: "France", GER: "Germany", IT: "Italy", CA: "Canada",
  ISRA: "Israel", SKOR: "South Korea", NKOR: "North Korea", IRAN: "Iran", BRAZ: "Brazil", ARGN: "Argentina",
  AUS: "Australia", SPN: "Spain", NETH: "Netherlands", SWED: "Sweden", NOR: "Norway", DEN: "Denmark",
  FIN: "Finland", POL: "Poland", TURK: "Turkey", UAE: "United Arab Emirates", SAUD: "Saudi Arabia",
  EGYP: "Egypt", NIG: "Nigeria", SAFR: "South Africa", INDO: "Indonesia", MALA: "Malaysia", THAI: "Thailand",
  SING: "Singapore", VTNM: "Vietnam", PAKI: "Pakistan", BGD: "Bangladesh", TWN: "Taiwan", LUXE: "Luxembourg",
  SWTZ: "Switzerland", BEL: "Belgium", AUT: "Austria", CZCH: "Czech Republic", HUN: "Hungary", GREC: "Greece",
  PORT: "Portugal", NZ: "New Zealand", CHLE: "Chile", MEX: "Mexico", COL: "Colombia", PER: "Peru",
  VENZ: "Venezuela", BOL: "Bolivia", ECU: "Ecuador", URY: "Uruguay", KAZ: "Kazakhstan", UKR: "Ukraine",
  BELA: "Belarus", AZER: "Azerbaijan", QAT: "Qatar", ISS: "International Space Station", SES: "SES",
  ORB: "ORBCOMM", GLOB: "Globalstar", IRID: "Iridium", O3B: "O3b Networks", EUTE: "Eutelsat", EUME: "EUMETSAT",
  AB: "Arabsat", ASRA: "AsiaSat", NATO: "NATO", RASC: "RascomStar", IM: "Inmarsat", ITSO: "Intelsat",
  AC: "Asia Broadcast Satellite", STCT: "Singapore / Taiwan", ESRO: "ESRO", FGER: "France / Germany",
  EUCO: "European Commission", CHBZ: "China / Brazil", ROC: "Taiwan", LTU: "Lithuania", EST: "Estonia",
  BHUT: "Bhutan", NPL: "Nepal", LKA: "Sri Lanka", MMR: "Myanmar", KEN: "Kenya", GHA: "Ghana", ETH: "Ethiopia",
  RWA: "Rwanda", SDN: "Sudan", ALG: "Algeria", MA: "Morocco", TUN: "Tunisia", ANG: "Angola", JOR: "Jordan",
  KWT: "Kuwait", BHR: "Bahrain", IRAQ: "Iraq", ARM: "Armenia", TKM: "Turkmenistan", PRY: "Paraguay",
  CRI: "Costa Rica", GUAT: "Guatemala", PHL: "Philippines", MNG: "Mongolia", SVN: "Slovenia", SVK: "Slovakia",
  BGR: "Bulgaria", ROM: "Romania", SRB: "Serbia", HRV: "Croatia", ISL: "Iceland", IRL: "Ireland", MDA: "Moldova",
  MAC: "Macedonia", LAOS: "Laos", KHM: "Cambodia", UZB: "Uzbekistan", KGZ: "Kyrgyzstan", TJK: "Tajikistan",
  MUS: "Mauritius", SEN: "Senegal", TZA: "Tanzania", UGA: "Uganda", ZWE: "Zimbabwe", MCO: "Monaco",
  OM: "Oman", LBN: "Lebanon", CUBA: "Cuba", DOM: "Dominican Republic", JAM: "Jamaica", PAN: "Panama", TTO: "Trinidad and Tobago",
};

export const SITE_NAMES: Record<string, string> = {
  AFETR: "Cape Canaveral, USA", AFWTR: "Vandenberg, USA", KSCUT: "Kennedy Space Center, USA", WLPIS: "Wallops Island, USA",
  KODAK: "Kodiak, USA", TYMSC: "Baikonur, Kazakhstan", PLMSC: "Plesetsk, Russia", KYMSC: "Kapustin Yar, Russia",
  VOSTO: "Vostochny, Russia", SVOBO: "Svobodny, Russia", DLS: "Dombarovsky, Russia", XICLF: "Xichang, China",
  JSC: "Jiuquan, China", TAISC: "Taiyuan, China", WSC: "Wenchang, China", YSLA: "Yellow Sea platform, China",
  FRGUI: "Kourou, French Guiana", SRILR: "Sriharikota, India", TANSC: "Tanegashima, Japan", KSCUT2: "Uchinoura, Japan",
  SEAL: "Sea Launch platform", NSC: "Naro, South Korea", SMTS: "Semnan, Iran", YAVNE: "Palmachim, Israel",
  RLLB: "Mahia, New Zealand", HGSTR: "Hammaguira, Algeria", WOMRA: "Woomera, Australia", SNMLP: "San Marco platform, Kenya",
  ERAS: "Pegasus air launch", VOLC: "Volcano", SUBL: "Submarine launch", CAS: "Air launch",
};

export const TYPE_NAMES: Record<string, string> = { PAY: "Payload", "R/B": "Rocket body", DEB: "Debris", UNK: "Unknown" };

export const STATUS_NAMES: Record<string, string> = {
  "+": "Operational", P: "Partially operational", B: "Backup / standby", S: "Spare", X: "Extended mission",
  D: "Decayed", "?": "Unknown", "": "Unknown",
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export function parseSatcat(text: string): SatcatRecord[] {
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "");
  const col = (name: string) => header.indexOf(name);
  const c = {
    norad: col("NORAD_CAT_ID"), type: col("OBJECT_TYPE"), status: col("OPS_STATUS_CODE"), owner: col("OWNER"),
    launch: col("LAUNCH_DATE"), site: col("LAUNCH_SITE"), decay: col("DECAY_DATE"), period: col("PERIOD"),
    inc: col("INCLINATION"), apogee: col("APOGEE"), perigee: col("PERIGEE"), rcs: col("RCS"), orbit: col("ORBIT_TYPE"),
  };
  if (c.norad < 0) throw new Error("unexpected SATCAT header");
  const out: SatcatRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const p = parseCsvLine(lines[i]);
    const norad = Number(p[c.norad]);
    if (!Number.isFinite(norad) || p[c.decay]) continue; // objects that re-entered are never tracked here
    out.push({
      norad, type: p[c.type], status: p[c.status], owner: p[c.owner], launched: p[c.launch], site: p[c.site],
      period: num(p[c.period]), inc: num(p[c.inc]), apogee: num(p[c.apogee]), perigee: num(p[c.perigee]),
      rcs: num(p[c.rcs]), orbitType: p[c.orbit],
    });
  }
  return out;
}

export async function getSatcat(): Promise<Map<number, SatcatRecord>> {
  if (table) return table;
  if (loading) return loading;
  loading = (async () => {
    const cached = readCache<SatcatRecord[]>("satcat");
    let rows = cached && Date.now() - cached.savedAt < TTL_MS ? cached.data : null;
    if (!rows) {
      try {
        const res = await fetch(URL, { headers: { "User-Agent": "Yonder/0.2 (live distance dashboard)" }, signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rows = parseSatcat(await res.text());
        writeCache("satcat", rows);
        console.log(`[satcat] ${rows.length} objects in orbit`);
      } catch (err) {
        if (!cached) throw err;
        console.warn(`[satcat] using stale cache: ${(err as Error).message}`);
        rows = cached.data;
      }
    }
    table = new Map(rows.map((r) => [r.norad, r]));
    return table;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export function satcatFacts(r: SatcatRecord): SatcatFacts {
  return {
    owner: OWNER_NAMES[r.owner] ?? r.owner,
    launched: r.launched,
    site: SITE_NAMES[r.site] ?? r.site,
    type: TYPE_NAMES[r.type] ?? r.type,
    status: STATUS_NAMES[r.status] ?? r.status,
    period: r.period,
    inc: r.inc,
    apogee: r.apogee,
    perigee: r.perigee,
    rcs: r.rcs,
  };
}
