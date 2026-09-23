import { useEffect, useState } from "react";
import { getEnvironment } from "../lib/api";

/** True once `active` has lasted longer than the environment's slow threshold. */
export function useSlow(active: boolean): { slow: boolean; seconds: number } {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => setElapsed(Date.now() - started), 250);
    return () => window.clearInterval(t);
  }, [active]);
  const threshold = getEnvironment()?.slow_notice_after_ms ?? 3000;
  return { slow: active && elapsed >= threshold, seconds: Math.floor(elapsed / 1000) };
}
