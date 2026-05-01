import type {
  LaunchState,
  PoolStats,
  DistributionWallet,
  PoolEvent,
  EnvSettings,
  ActionResult,
} from "./types";

const BASE = "";

export async function fetchLaunchState(): Promise<LaunchState | null> {
  const res = await fetch(`${BASE}/api/launch-state`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchPoolStats(): Promise<PoolStats | null> {
  const res = await fetch(`${BASE}/api/pool-stats`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchBundlers(): Promise<DistributionWallet[]> {
  const res = await fetch(`${BASE}/api/bundlers`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchPoolEvents(limit = 50): Promise<PoolEvent[]> {
  const res = await fetch(`${BASE}/api/pool-events?limit=${limit}`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchSettings(): Promise<EnvSettings> {
  const res = await fetch(`${BASE}/api/settings`);
  if (!res.ok) return {};
  return res.json();
}

export async function saveSettings(
  updates: { key: string; value: string }[]
): Promise<boolean> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  return res.ok;
}

export async function triggerAction(action: string): Promise<ActionResult> {
  const res = await fetch(`${BASE}/api/actions/${action}`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { success: false, ...(err as object) } as ActionResult;
  }
  return res.json();
}
