import { useCallback, useEffect, useState } from "react";
import type { CustomPlace } from "../types";

const LS_KEY = "yonder:custom-places";

export type PlacesStatus = "loading" | "server" | "local";

/** The user's own places: saved through the server when it is reachable, otherwise in browser storage. */
export function useCustomPlaces() {
  const [places, setPlaces] = useState<CustomPlace[]>([]);
  const [status, setStatus] = useState<PlacesStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/custom-places")
      .then((r) => (r.ok ? (r.json() as Promise<{ places: CustomPlace[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (cancelled) return;
        setPlaces(j.places);
        setStatus("server");
      })
      .catch(() => {
        if (cancelled) return;
        try {
          const raw = localStorage.getItem(LS_KEY);
          setPlaces(raw ? (JSON.parse(raw) as CustomPlace[]) : []);
        } catch {
          setPlaces([]);
        }
        setStatus("local");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: CustomPlace[]) => {
      setPlaces(next);
      if (status === "server") {
        try {
          const r = await fetch("/api/custom-places", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ places: next }),
          });
          const j = (await r.json().catch(() => ({}))) as { places?: CustomPlace[]; error?: string };
          if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          if (j.places) setPlaces(j.places);
          setError(null);
        } catch (e) {
          setError((e as Error).message);
        }
      } else {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
      }
    },
    [status],
  );

  const add = useCallback(
    (p: Omit<CustomPlace, "id">) => save([...places, { ...p, id: `p${Date.now().toString(36)}` }]),
    [places, save],
  );
  const remove = useCallback((id: string) => save(places.filter((p) => p.id !== id)), [places, save]);

  return { places, add, remove, status, error };
}
