import bs58 from "bs58";

export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key]?.trim() || defaultValue;
}

export function getRequiredEnv(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

export function parseWalletSecret(raw: string): Uint8Array {
  const t = raw.trim();
  if (t.startsWith("[")) return Uint8Array.from(JSON.parse(t) as number[]);
  if (t.includes(",")) return Uint8Array.from(t.split(",").map((x) => Number(x.trim())));
  return bs58.decode(t);
}

export function inferCluster(rpc: string): "devnet" | "mainnet-beta" {
  return rpc.toLowerCase().includes("mainnet") ? "mainnet-beta" : "devnet";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v));
  } catch {
    return [];
  }
}
