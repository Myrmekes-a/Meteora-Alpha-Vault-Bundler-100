import { NextRequest, NextResponse } from "next/server";
import { getMongoDb } from "@/lib/mongo";
import { CHART_HISTORY_COLLECTION, type ChartHistoryEntry } from "@/lib/chartHistory";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

type OhlcvBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type CandleLike = {
  unixTime?: number;
  time?: number;
  t?: number;
  open?: number;
  o?: number;
  high?: number;
  h?: number;
  low?: number;
  l?: number;
  close?: number;
  c?: number;
};

type CodexBarsResponse = {
  data?: {
    getBars?: {
      o?: number[];
      h?: number[];
      l?: number[];
      c?: number[];
      t?: number[];
      volume?: number[];
    };
  };
  errors?: Array<{ message?: string }>;
};

let codexTokenCache: { token: string | null; timestamp: number } = {
  token: null,
  timestamp: 0,
};
const CODEX_TOKEN_TTL_MS = 4 * 60 * 1000;

type PoolEventDoc = {
  event?: {
    eventType?: string;
    type?: string;
    amountA?: number | string;
    amountB?: number | string;
    timestamp?: number | string;
  };
  createdAt?: string;
};

type ChartHistoryDoc = ChartHistoryEntry;

function buildSyntheticCandles(basePrice: number, count: number, spacingSec = 60): OhlcvBar[] {
  const now = Math.floor(Date.now() / 1000);
  const bars: OhlcvBar[] = [];
  let prevClose = basePrice;
  for (let i = count - 1; i >= 0; i--) {
    const t = now - i * spacingSec;
    const wave = Math.sin(t / 37) * 0.0009 + Math.cos(t / 73) * 0.0006;
    const drift = (Math.sin(t / 131) + Math.cos(t / 97)) * 0.0002;
    const nextClose = Math.max(basePrice * 0.9, prevClose * (1 + wave + drift));
    const open = prevClose;
    const close = nextClose;
    const wick = Math.max(basePrice * 0.0004, Math.abs(close - open) * 0.55);
    const high = Math.max(open, close) + wick;
    const low = Math.max(basePrice * 0.0000001, Math.min(open, close) - wick);
    bars.push({ time: t, open, high, low, close });
    prevClose = close;
  }
  return bars;
}

function toBase64FromArrayBuffer(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}

async function getCodexAuthToken(): Promise<string | null> {
  try {
    if (
      codexTokenCache.token &&
      Date.now() - codexTokenCache.timestamp < CODEX_TOKEN_TTL_MS
    ) {
      return codexTokenCache.token;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const rounded = nowSec - (nowSec % 300);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(rounded))
    );
    const challenge = toBase64FromArrayBuffer(digest);
    const tokenRes = await fetch(
      `https://d2gndqco47nwa6.cloudfront.net?challenge=${encodeURIComponent(challenge)}`,
      { cache: "no-store" }
    );
    if (!tokenRes.ok) return null;
    const token = (await tokenRes.text()).trim();
    if (!token || token.toLowerCase().includes("failed challenge")) return null;

    codexTokenCache = { token, timestamp: Date.now() };
    return token;
  } catch {
    return null;
  }
}

function codexResolutionFromType(type: "1m" | "5m" | "15m"): string {
  if (type === "5m") return "5";
  if (type === "15m") return "15";
  return "1";
}

async function fetchCodexBarsForAddress(address: string): Promise<OhlcvBar[]> {
  const token = await getCodexAuthToken();
  if (!token) return [];

  const now = Math.floor(Date.now() / 1000);
  const attempts: Array<{ type: "1m" | "5m" | "15m"; from: number }> = [
    { type: "1m", from: now - 60 * 60 },
    { type: "5m", from: now - 24 * 60 * 60 },
    { type: "15m", from: now - 7 * 24 * 60 * 60 },
  ];

  let firstNonEmpty: OhlcvBar[] = [];
  for (const attempt of attempts) {
    const resolution = codexResolutionFromType(attempt.type);
    const symbol = `${address}:1399811149`;
    const query = `query ChartData {
      getBars(
        symbol: "${symbol}"
        from: ${attempt.from}
        to: ${now}
        resolution: "${resolution}"
      ) {
        o
        h
        l
        c
        t
        volume
      }
    }`;

    const res = await fetch("https://graph.codex.io/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    if (!res.ok) continue;
    const payload = (await res.json()) as CodexBarsResponse;
    if (payload?.errors?.length) continue;
    const barsNode = payload?.data?.getBars;
    if (!barsNode) continue;

    const len = barsNode.t?.length ?? 0;
    if (!len) continue;
    const arr: OhlcvBar[] = [];
    for (let i = 0; i < len; i++) {
      const t = Number(barsNode.t?.[i] ?? 0);
      const o = Number(barsNode.o?.[i] ?? 0);
      const h = Number(barsNode.h?.[i] ?? 0);
      const l = Number(barsNode.l?.[i] ?? 0);
      const c = Number(barsNode.c?.[i] ?? 0);
      if (!t || !o || !h || !l || !c) continue;
      arr.push({ time: Math.floor(t), open: o, high: h, low: l, close: c });
    }
    arr.sort((a, b) => a.time - b.time);
    if (arr.length === 0) continue;
    if (firstNonEmpty.length === 0) firstNonEmpty = arr;
    if (hasPriceVariation(arr)) return arr;
  }
  return firstNonEmpty;
}

async function fetchBirdeyePrice(address: string, apiKey: string): Promise<number | null> {
  try {
    const url =
      `https://public-api.birdeye.so/defi/token_overview` +
      `?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
        accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const overview = data?.data ?? data ?? null;
    const price = Number(overview?.price ?? overview?.priceUsd ?? "");
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch {
    return null;
  }
}

function toBigIntSafe(v: string | number | bigint | null | undefined, fallback = 0n): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string" && v.trim().length > 0) return BigInt(v.trim());
    return fallback;
  } catch {
    return fallback;
  }
}

function decimalFromRaw(raw: bigint, decimals: number): number {
  if (decimals < 0) return 0;
  return Number(raw) / 10 ** decimals;
}

async function fallbackPriceFromLaunchState(apiKey: string): Promise<number | null> {
  try {
    const db = await getMongoDb();
    const [settingsDoc, tokenMintDoc, poolOutputDoc] = await Promise.all([
      db.collection("settings").findOne({ recordKey: "ui-settings" }) as Promise<{ values?: Record<string, string> } | null>,
      db.collection("artifacts").findOne({ kind: "token-mint-output" }, { sort: { updatedAt: -1 } }) as Promise<{ payload?: { tokenDecimals?: number } } | null>,
      db.collection("artifacts").findOne({ kind: "pool-output" }, { sort: { updatedAt: -1 } }) as Promise<{ payload?: { quoteMintType?: "WSOL" | "USDC" } } | null>,
    ]);
    const settings = settingsDoc?.values ?? {};
    const quoteType = (poolOutputDoc?.payload?.quoteMintType ?? settings.QUOTE_MINT_TYPE ?? "WSOL").toUpperCase();
    const tokenADecimals = Number(settings.TOKEN_DECIMALS ?? tokenMintDoc?.payload?.tokenDecimals ?? 6);
    const quoteDecimals = quoteType === "USDC" ? 6 : 9;
    const tokenARaw = toBigIntSafe(settings.TOKEN_A_INPUT_AMOUNT_RAW, 0n);
    const tokenBRaw = toBigIntSafe(settings.TOKEN_B_INPUT_AMOUNT_RAW, 0n);
    if (tokenARaw <= 0n || tokenBRaw <= 0n) return null;
    const tokenA = decimalFromRaw(tokenARaw, tokenADecimals);
    const tokenB = decimalFromRaw(tokenBRaw, quoteDecimals);
    if (!Number.isFinite(tokenA) || !Number.isFinite(tokenB) || tokenA <= 0 || tokenB <= 0) return null;
    const priceInQuote = tokenB / tokenA;
    if (quoteType === "USDC") return priceInQuote;
    const solUsd = await fetchBirdeyePrice("So11111111111111111111111111111111111111112", apiKey);
    if (!solUsd || solUsd <= 0) return null;
    const priceUsd = priceInQuote * solUsd;
    return Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null;
  } catch {
    return null;
  }
}

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  const marker = path.join("src", "commands", "token-mint.ts");
  if (fs.existsSync(path.join(cwd, marker))) return cwd;
  const parent = path.resolve(cwd, "..");
  if (fs.existsSync(path.join(parent, marker))) return parent;
  return cwd;
}

function readRootEnvBirdeyeKey(): string | null {
  try {
    const envPath = path.join(resolveProjectRoot(), ".env");
    if (!fs.existsSync(envPath)) return null;
    const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
    const key = parsed.BIRDEYE_API_KEY?.trim();
    return key || null;
  } catch {
    return null;
  }
}

function toBars(input: unknown): OhlcvBar[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((x) => {
      const c = x as CandleLike;
      const t = Number(c.unixTime ?? c.time ?? c.t ?? 0);
      const o = Number(c.open ?? c.o ?? 0);
      const h = Number(c.high ?? c.h ?? 0);
      const l = Number(c.low ?? c.l ?? 0);
      const cl = Number(c.close ?? c.c ?? 0);
      if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) {
        return null;
      }
      if (t <= 0 || o <= 0 || h <= 0 || l <= 0 || cl <= 0) return null;
      return { time: Math.floor(t), open: o, high: h, low: l, close: cl } satisfies OhlcvBar;
    })
    .filter((v): v is OhlcvBar => Boolean(v))
    .sort((a, b) => a.time - b.time);
}

function hasPriceVariation(bars: OhlcvBar[]): boolean {
  if (bars.length < 2) return false;
  const first = bars[0].close;
  for (let i = 1; i < bars.length; i++) {
    if (Math.abs(bars[i].close - first) > 1e-18) return true;
    if (Math.abs(bars[i].high - bars[i].low) > 1e-18) return true;
  }
  return false;
}

function toTsSec(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string" && v.trim().length > 0) {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) return Math.floor(asNum);
    const asDate = Date.parse(v);
    if (Number.isFinite(asDate) && asDate > 0) return Math.floor(asDate / 1000);
  }
  return null;
}

async function fetchSolUsdPublic(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const n = Number(data?.solana?.usd ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function makeMinuteCandles(points: Array<{ ts: number; priceUsd: number; volumeUsd: number }>): OhlcvBar[] {
  if (points.length === 0) return [];
  const buckets = new Map<number, OhlcvBar>();
  for (const p of points) {
    const t = Math.floor(p.ts / 60) * 60;
    const prev = buckets.get(t);
    if (!prev) {
      buckets.set(t, {
        time: t,
        open: p.priceUsd,
        high: p.priceUsd,
        low: p.priceUsd,
        close: p.priceUsd,
        volume: p.volumeUsd,
      });
      continue;
    }
    prev.high = Math.max(prev.high, p.priceUsd);
    prev.low = Math.min(prev.low, p.priceUsd);
    prev.close = p.priceUsd;
    prev.volume = (prev.volume ?? 0) + p.volumeUsd;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function fetchBarsFromDbHistory(address: string): Promise<OhlcvBar[]> {
  try {
    const db = await getMongoDb();
    const [settingsDoc, launchStateDoc] = await Promise.all([
      db.collection("settings").findOne({ recordKey: "ui-settings" }) as Promise<{ values?: Record<string, string> } | null>,
      db.collection("launch_states").findOne({}, { sort: { updatedAt: -1 } }) as Promise<{ poolAddress?: string; createdAt?: string } | null>,
    ]);
    const currentPool = (launchStateDoc?.poolAddress ?? "").trim();
    if (!currentPool) return [];
    if (currentPool !== address.trim()) return [];

    const quoteType = String(settingsDoc?.values?.QUOTE_MINT_TYPE ?? "WSOL").toUpperCase();
    const solUsd = quoteType === "USDC" ? 1 : (await fetchSolUsdPublic()) ?? 0;
    if (quoteType !== "USDC" && solUsd <= 0) return [];

    const sinceTs = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const rows = (await db
      .collection("pool_events")
      .find({})
      .sort({ createdAt: 1 })
      .limit(6000)
      .toArray()) as PoolEventDoc[];

    const points: Array<{ ts: number; priceUsd: number; volumeUsd: number }> = [];
    for (const row of rows) {
      const evt = row?.event ?? {};
      const type = String(evt.eventType ?? evt.type ?? "").toLowerCase();
      if (!(type.includes("buy") || type.includes("sell") || type.includes("swap"))) continue;
      const amountA = Number(evt.amountA ?? 0);
      const amountB = Number(evt.amountB ?? 0);
      if (!Number.isFinite(amountA) || !Number.isFinite(amountB) || amountA <= 0 || amountB <= 0) continue;

      const ts =
        toTsSec(evt.timestamp) ??
        toTsSec(row.createdAt) ??
        0;
      if (!ts || ts < sinceTs) continue;

      const priceNative = amountB / amountA;
      if (!Number.isFinite(priceNative) || priceNative <= 0) continue;
      const priceUsd = quoteType === "USDC" ? priceNative : priceNative * solUsd;
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

      const volumeUsd = quoteType === "USDC" ? amountB : amountB * solUsd;
      points.push({ ts, priceUsd, volumeUsd: Number.isFinite(volumeUsd) ? volumeUsd : 0 });
    }

    const bars = makeMinuteCandles(points);
    return bars.filter(
      (b) =>
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close) &&
        b.open > 0 &&
        b.high > 0 &&
        b.low > 0 &&
        b.close > 0
    );
  } catch {
    return [];
  }
}

async function ensureChartHistoryIndexes(): Promise<void> {
  const db = await getMongoDb();
  const c = db.collection(CHART_HISTORY_COLLECTION);
  await Promise.all([
    c.createIndex({ recordKey: 1, resolution: 1, time: 1 }, { unique: true }),
    c.createIndex({ recordKey: 1, time: -1 }),
  ]);
}

async function upsertChartHistoryBars(
  address: string,
  bars: OhlcvBar[],
  source: "codex" | "pool-events"
): Promise<void> {
  if (bars.length === 0) return;
  const db = await getMongoDb();
  const c = db.collection(CHART_HISTORY_COLLECTION);
  const sorted = [...bars].sort((a, b) => a.time - b.time);
  const latest = (await c.findOne(
    { recordKey: address, resolution: "1m" },
    { sort: { time: -1 } }
  )) as Partial<ChartHistoryDoc> | null;
  let prevClose = Number(latest?.close ?? 0);
  let prevTime = Number(latest?.time ?? 0);
  const epsilon = 1e-18;
  const nowIso = new Date().toISOString();
  const ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown>; upsert: boolean } }> = [];
  for (const b of sorted) {
    const samePrice =
      prevClose > 0 && Math.abs(b.close - prevClose) <= Math.max(epsilon, prevClose * 1e-8);
    const newerThanPrev = b.time > prevTime;
    // Only persist materially changed candles; skip repeated same-price bars.
    if (samePrice && newerThanPrev) {
      prevTime = b.time;
      continue;
    }
    ops.push({
      updateOne: {
        filter: { recordKey: address, resolution: "1m", time: b.time },
        update: {
          $set: {
            recordKey: address,
            resolution: "1m",
            time: b.time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume ?? 0,
            source,
            updatedAt: nowIso,
          } satisfies Partial<ChartHistoryDoc>,
          $setOnInsert: { createdAt: nowIso },
        },
        upsert: true,
      },
    });
    prevClose = b.close;
    prevTime = b.time;
  }
  if (ops.length > 0) {
    await c.bulkWrite(ops, { ordered: false });
  }
}

async function fetchChartHistoryBars(address: string): Promise<OhlcvBar[]> {
  try {
    await ensureChartHistoryIndexes();
    const db = await getMongoDb();
    const rows = (await db
      .collection(CHART_HISTORY_COLLECTION)
      .find({ recordKey: address, resolution: "1m" })
      .sort({ time: 1 })
      .limit(3000)
      .toArray()) as Array<Partial<ChartHistoryDoc>>;
    return rows
      .map((r) => ({
        time: Number(r.time ?? 0),
        open: Number(r.open ?? 0),
        high: Number(r.high ?? 0),
        low: Number(r.low ?? 0),
        close: Number(r.close ?? 0),
        volume: Number(r.volume ?? 0),
      }))
      .filter(
        (b) =>
          Number.isFinite(b.time) &&
          Number.isFinite(b.open) &&
          Number.isFinite(b.high) &&
          Number.isFinite(b.low) &&
          Number.isFinite(b.close) &&
          b.time > 0 &&
          b.open > 0 &&
          b.high > 0 &&
          b.low > 0 &&
          b.close > 0
      );
  } catch {
    return [];
  }
}

function sanitizeDistinctBars(bars: OhlcvBar[]): OhlcvBar[] {
  if (bars.length <= 1) return bars;
  const sorted = [...bars].sort((a, b) => a.time - b.time);

  // Filter obvious outliers that commonly come from mixed-source spikes.
  const filtered: OhlcvBar[] = [];
  let rolling = sorted[0].close;
  for (const b of sorted) {
    const close = b.close;
    const ratio = rolling > 0 ? close / rolling : 1;
    const isExtreme = ratio > 8 || ratio < 1 / 8;
    if (filtered.length > 5 && isExtreme) {
      continue;
    }
    filtered.push(b);
    // Smooth rolling baseline to avoid overreacting to one bar.
    rolling = rolling * 0.7 + close * 0.3;
  }
  if (filtered.length <= 1) return filtered;

  // Remove consecutive duplicates (same close) to keep only changed price points.
  const out: OhlcvBar[] = [];
  const epsilon = 1e-18;
  for (const b of filtered) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(b);
      continue;
    }
    const sameClose = Math.abs(b.close - prev.close) <= Math.max(epsilon, prev.close * 1e-8);
    if (sameClose) continue;
    out.push(b);
  }
  // Ensure at least one latest point remains for chart marker/header.
  if (out.length === 0 && filtered.length > 0) return [filtered[filtered.length - 1]!];
  return out;
}

async function getBirdeyeApiKey(): Promise<string | null> {
  try {
    const db = await getMongoDb();
    const doc = (await db.collection("settings").findOne({ recordKey: "ui-settings" })) as
      | { values?: Record<string, string> }
      | null;
    const fromDb = doc?.values?.BIRDEYE_API_KEY?.trim();
    if (fromDb) return fromDb;
  } catch {
    // ignore and fallback to process env
  }
  const fromEnv = process.env.BIRDEYE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return readRootEnvBirdeyeKey();
}

async function resolveTokenFallbackForAddress(address: string): Promise<string | null> {
  try {
    const db = await getMongoDb();
    const state = (await db
      .collection("launch_states")
      .findOne({}, { sort: { updatedAt: -1 } })) as
      | { poolAddress?: string; tokenMint?: string; tokenMintAddress?: string }
      | null;
    if (!state) return null;
    if ((state.poolAddress ?? "").trim() !== address.trim()) return null;
    return state.tokenMint ?? state.tokenMintAddress ?? null;
  } catch {
    return null;
  }
}

async function fetchBarsForAddress(address: string, apiKey: string): Promise<{ bars: OhlcvBar[]; source: string | null }> {
  const now = Math.floor(Date.now() / 1000);
  const attempts: Array<{ type: string; from: number }> = [
    { type: "1m", from: now - 60 * 60 },          // 1h
    { type: "5m", from: now - 24 * 60 * 60 },     // 24h
    { type: "15m", from: now - 7 * 24 * 60 * 60 } // 7d
  ];

  let firstNonEmpty: OhlcvBar[] | null = null;
  for (const attempt of attempts) {
    const url =
      `https://public-api.birdeye.so/defi/ohlcv` +
      `?address=${encodeURIComponent(address)}&type=${attempt.type}&time_from=${attempt.from}&time_to=${now}`;
    const res = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
        accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) continue;
    const data = await res.json();
    const rawItems = data?.data?.items ?? data?.data?.candles ?? data?.items ?? data?.candles ?? [];
    const bars = toBars(rawItems);
    if (bars.length === 0) continue;
    if (!firstNonEmpty) firstNonEmpty = bars;
    if (hasPriceVariation(bars)) {
      return { bars, source: "birdeye" };
    }
  }
  if (firstNonEmpty && firstNonEmpty.length > 0) {
    return { bars: firstNonEmpty, source: "birdeye" };
  }
  return { bars: [], source: null };
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.trim();
  if (!address) {
    return NextResponse.json({ bars: [], error: "missing address" }, { status: 400 });
  }

  try {
    const fallbackToken = await resolveTokenFallbackForAddress(address);
    const codexPrimary = await fetchCodexBarsForAddress(address);
    if (codexPrimary.length > 0) {
      await upsertChartHistoryBars(address, codexPrimary, "codex");
    }
    if (fallbackToken && fallbackToken !== address) {
      const codexSecondary = await fetchCodexBarsForAddress(fallbackToken);
      if (codexSecondary.length > 0) {
        await upsertChartHistoryBars(address, codexSecondary, "codex");
      }
    }

    // Ingest on-chain swap events into chart history as well.
    const eventBars = await fetchBarsFromDbHistory(address);
    if (eventBars.length > 0) {
      await upsertChartHistoryBars(address, eventBars, "pool-events");
    }

    // Frontend only reads DB-backed chart history.
    const historyBars = sanitizeDistinctBars(await fetchChartHistoryBars(address));
    return NextResponse.json({
      bars: historyBars,
      source: "db-trades",
    });
  } catch (e) {
    return NextResponse.json({ bars: [], error: String(e) });
  }
}

