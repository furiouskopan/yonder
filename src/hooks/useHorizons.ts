import { useEffect, useRef, useState } from "react";
import type { BodyTable, HorizonsResponse } from "../lib/horizons";

/** Vector tables from the server. Polls quickly while the server is still filling its cache. */
export function useHorizons(): { tables: BodyTable[]; pending: number; error: string | null } {
  const [tables, setTables] = useState<BodyTable[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const signature = useRef("");

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = async () => {
      try {
        const r = await fetch("/api/horizons");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as HorizonsResponse;
        if (cancelled) return;
        // Keep the previous array when nothing changed, so memos keyed on it (target bases) are not redone.
        const sig = j.bodies.map((b) => `${b.id}:${b.status}@${b.fetchedAt ?? ""}`).join("|");
        if (sig !== signature.current) {
          signature.current = sig;
          setTables(j.bodies);
        }
        setPending(j.pending);
        setError(null);
        timer = window.setTimeout(load, j.pending > 0 || j.refreshing ? 20_000 : 10 * 60_000);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        timer = window.setTimeout(load, 30_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return { tables, pending, error };
}
