import { useEffect, useState } from "react";
import type { Target } from "../types";

export interface Described {
  title: string | null;
  extract?: string;
  description?: string;
  thumbnail?: { source: string; width: number; height: number };
  url?: string;
  lang?: string;
}

export interface DescriptionState {
  id: string | null;
  status: "idle" | "loading" | "ready" | "none" | "error";
  data: Described | null;
}

const cache = new Map<string, Promise<Described>>();

export function describeQuery(t: Target): { q: string; fallback?: string } | null {
  if (t.category === "aircraft") return null;
  const q = t.wiki ?? t.name;
  return { q, fallback: t.wiki2 };
}

export function fetchDescription(spec: { q: string; fallback?: string }): Promise<Described> {
  const key = `${spec.q}|${spec.fallback ?? ""}`;
  let p = cache.get(key);
  if (!p) {
    const qs = new URLSearchParams({ q: spec.q });
    if (spec.fallback) qs.set("fallback", spec.fallback);
    p = fetch(`/api/describe?${qs.toString()}`).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Described;
    });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

export function useDescription(target: Target | null): DescriptionState {
  const [state, setState] = useState<DescriptionState>({ id: null, status: "idle", data: null });
  const id = target?.id ?? null;
  const spec = target ? describeQuery(target) : null;
  const specKey = spec ? `${spec.q}|${spec.fallback ?? ""}` : "";

  useEffect(() => {
    if (!id) {
      setState({ id: null, status: "idle", data: null });
      return;
    }
    if (!spec) {
      setState({ id, status: "none", data: null });
      return;
    }
    let cancelled = false;
    setState({ id, status: "loading", data: null });
    fetchDescription(spec)
      .then((d) => {
        if (cancelled) return;
        setState({ id, status: d.title ? "ready" : "none", data: d.title ? d : null });
      })
      .catch(() => {
        if (!cancelled) setState({ id, status: "error", data: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, specKey]);

  return state;
}
