import { useEffect, useState } from "react";

/** Current time in ms, updated on the second boundary. When `running` is false the value freezes and nothing ticks. */
export function useClock(intervalMs = 1000, running = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
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
  }, [intervalMs, running]);
  return now;
}
