// Short descriptions from Wikipedia (REST summary API) with a search fallback, cached on disk.
import { readCache, writeCache } from "./cache";

export interface Described {
  title: string | null;
  extract?: string;
  description?: string;
  thumbnail?: { source: string; width: number; height: number };
  url?: string;
  lang?: string;
}

const HEADERS = { "User-Agent": "Yonder/0.2 (personal desktop dashboard)", Accept: "application/json" };
const memory = new Map<string, Described>();
let loaded = false;
let dirty = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  const c = readCache<Record<string, Described>>("describe");
  if (c) for (const [k, v] of Object.entries(c.data)) memory.set(k, v);
}

export function flushDescriptions(): void {
  if (!dirty) return;
  dirty = false;
  writeCache("describe", Object.fromEntries(memory));
}
setInterval(flushDescriptions, 60_000).unref();

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface Summary {
  type?: string;
  title?: string;
  extract?: string;
  description?: string;
  thumbnail?: { source: string; width: number; height: number };
  content_urls?: { desktop?: { page?: string } };
}

async function summary(title: string, lang: string): Promise<Described | null> {
  const j = await getJson<Summary>(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}?redirect=true`);
  if (!j?.title || j.type === "disambiguation" || !j.extract) return null;
  return { title: j.title, extract: j.extract, description: j.description, thumbnail: j.thumbnail, url: j.content_urls?.desktop?.page, lang };
}

async function search(q: string, lang: string): Promise<string | null> {
  const j = await getJson<{ query?: { search?: { title: string }[] } }>(
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json`,
  );
  return j?.query?.search?.[0]?.title ?? null;
}

async function wikidataTitle(qid: string, lang: string): Promise<string | null> {
  const j = await getJson<{ entities?: Record<string, { sitelinks?: Record<string, { title: string }> }> }>(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=${lang}wiki&format=json`,
  );
  return j?.entities?.[qid]?.sitelinks?.[`${lang}wiki`]?.title ?? null;
}

async function englishTitle(title: string, lang: string): Promise<string | null> {
  const j = await getJson<{ query?: { pages?: Record<string, { langlinks?: { "*": string }[] }> } }>(
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=en&titles=${encodeURIComponent(title)}&redirects=1&format=json`,
  );
  const pages = j?.query?.pages ?? {};
  for (const p of Object.values(pages)) if (p.langlinks?.[0]?.["*"]) return p.langlinks[0]["*"];
  return null;
}

async function resolve(q: string, lang: string): Promise<Described | null> {
  const text = q.trim();
  let m = /^wikidata:(Q\d+)$/i.exec(text);
  if (m) {
    const t = await wikidataTitle(m[1], lang);
    return t ? summary(t, lang) : null;
  }
  m = /^([a-z]{2,3}):(.+)$/i.exec(text);
  if (m && !/^https?$/i.test(m[1])) {
    const srcLang = m[1].toLowerCase();
    const title = m[2].trim();
    if (srcLang === lang) return summary(title, lang);
    const en = await englishTitle(title, srcLang);
    return (en ? await summary(en, lang) : null) ?? summary(title, srcLang);
  }
  const direct = await summary(text, lang);
  if (direct) return direct;
  const found = await search(text, lang);
  return found ? summary(found, lang) : null;
}

/** Describe `q`; if nothing is found, try `fallback`. Results (including misses) are cached. */
export async function describe(q: string, fallback?: string, lang = "en"): Promise<Described> {
  load();
  const key = `${lang}:${q.trim().toLowerCase()}|${(fallback ?? "").trim().toLowerCase()}`;
  const hit = memory.get(key);
  if (hit) return hit;
  let result = (await resolve(q, lang)) ?? (fallback ? await resolve(fallback, lang) : null) ?? { title: null };
  if (!result.title) result = { title: null };
  memory.set(key, result);
  dirty = true;
  return result;
}
