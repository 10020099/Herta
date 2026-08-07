import { useEffect, useState } from "react";

/**
 * A coarse "now" clock (epoch ms) that re-renders the consumer every
 * `intervalMs`. Relative timestamps ("just now" → "1 min ago" → …) only stay
 * fresh if something re-renders them; this is that something. The interval is
 * deliberately coarse (the finest granularity shown is one minute), so the
 * background churn is negligible.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
