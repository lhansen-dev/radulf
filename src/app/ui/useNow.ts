"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Returns the current time (Date.now()) and re-renders every `intervalMs`
 * milliseconds while `active` is `true`. When `active` becomes `false` the
 * interval is cleared and the value stays constant.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (active) {
      intervalRef.current = setInterval(() => setNow(Date.now()), intervalMs);
    } else {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, intervalMs]);

  return now;
}