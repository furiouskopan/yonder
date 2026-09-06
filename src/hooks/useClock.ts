import { useEffect, useState } from "react";

/** Current time in ms, updated on the second boundary. */
export function useClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const t = Date.now();
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, intervalMs - (t % intervalMs));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [intervalMs]);
  return now;
}
