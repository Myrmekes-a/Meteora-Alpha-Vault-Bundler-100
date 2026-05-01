"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { LaunchState } from "./types";

interface LaunchStateCtx {
  launchState: LaunchState | null;
  /** Manually trigger an immediate re-fetch (call after a step completes). */
  refresh: () => void;
}

const LaunchStateContext = createContext<LaunchStateCtx>({
  launchState: null,
  refresh: () => {},
});

export function LaunchStateProvider({ children }: { children: React.ReactNode }) {
  const [launchState, setLaunchState] = useState<LaunchState | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/launch-state");
      if (!res.ok) {
        setLaunchState(null);
        return;
      }
      const data = await res.json();
      if (data && typeof data === "object" && "phase" in data) {
        setLaunchState(data as LaunchState);
      } else {
        setLaunchState(null);
      }
    } catch {
      setLaunchState(null);
    }
  }, []);

  // Initial load immediately, then poll every 20 s.
  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <LaunchStateContext.Provider value={{ launchState, refresh: load }}>
      {children}
    </LaunchStateContext.Provider>
  );
}

export function useLaunchState(): LaunchStateCtx {
  return useContext(LaunchStateContext);
}
