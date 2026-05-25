import { NextResponse } from "next/server";
import { getMongoDb } from "@/lib/mongo";
import { CHART_HISTORY_COLLECTION } from "@/lib/chartHistory";
import type { PoolStats } from "@/lib/types";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

type LaunchStateDoc = {
  poolAddress?: string;
  tokenMint?: string;
  tokenMintAddress?: string;
  updatedAt?: string;
};

type TokenMintArtifact = {
  tokenName?: string;
  tokenSymbol?: string;
  imageIpfsUrl?: string;
  tokenMint?: string;
  tokenDecimals?: number;
  tokenInitialSupplyRaw?: string;
  createdAt?: string;
};

type PoolOutputArtifact = {
  poolAddress?: string;
  quoteMintType?: "WSOL" | "USDC";
  createdAt?: string;
};

type SettingsDoc = {
  values?: Record<string, string>;
};

type BirdeyeTokenOverview = {
  price?: number | string;
  priceUsd?: number | string;
  v24hUSD?: number | string;
  volume24h?: number | string;
  liquidity?: number | string;
  liquidityUsd?: number | string;
  marketCap?: number | string;
  mc?: number | string;
  fdv?: number | string;
  priceChange24hPercent?: number | string;
  priceChange24h?: number | string;
  symbol?: string;
  name?: string;
  logoURI?: string;
  logoUrl?: string;
};

type Codex24hStats = {
  buys24h: number;
  sells24h: number;
  buyVolume: number;
  sellVolume: number;
};

type DbTradeStats = {
  lastPriceUsd: number | null;
  volume24h: number;
  buys24h: number;
  sells24h: number;
};

async function fetchLatestChartHistoryPrice(recordKey: string | null): Promise<number | null> {
  if (!recordKey) return null;
  try {
    const db = await getMongoDb();
    const row = (await db
      .collection(CHART_HISTORY_COLLECTION)
      .findOne({ recordKey, resolution: "1m" }, { sort: { time: -1 } })) as
      | { close?: number }
      | null;
    const n = Number(row?.close ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

let codexTokenCache: { token: string | null; ts: number } = { token: null, ts: 0 };

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

function toNumberSafe(v: string | number | null | undefined, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v ?? "");
  return Number.isFinite(n) ? n : fallback;
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

function withFallbackStats(
  partial: Partial<PoolStats>,
  fallbackName: string,
  fallbackSymbol: string,
  fallbackImageUrl?: string
): PoolStats {
  return {
    priceUsd: partial.priceUsd ?? "0",
    priceNative: partial.priceNative ?? "0",
    volume24h: partial.volume24h ?? 0,
    marketCap: partial.marketCap ?? 0,
    liquidity: partial.liquidity ?? 0,
    priceChange24h: partial.priceChange24h ?? 0,
    buys24h: partial.buys24h ?? 0,
    sells24h: partial.sells24h ?? 0,
    fdv: partial.fdv ?? 0,
    symbol: partial.symbol ?? fallbackSymbol,
    name: partial.name ?? fallbackName,
    imageUrl: partial.imageUrl ?? fallbackImageUrl,
  };
}

async function getLatestLaunchState(): Promise<LaunchStateDoc | null> {
  try {
    const db = await getMongoDb();
    const doc = await db.collection("launch_states").findOne({}, { sort: { updatedAt: -1 } });
    return doc as LaunchStateDoc | null;
  } catch {
    return null;
  }
}

async function getLatestTokenMintArtifact(): Promise<TokenMintArtifact | null> {
  try {
    const db = await getMongoDb();
    const doc = await db
      .collection("artifacts")
      .findOne({ kind: "token-mint-output" }, { sort: { updatedAt: -1 } });
    return (doc?.payload as TokenMintArtifact | undefined) ?? null;
  } catch {
    return null;
  }
}

async function getLatestPoolOutputArtifact(): Promise<PoolOutputArtifact | null> {
  try {
    const db = await getMongoDb();
    const doc = await db
      .collection("artifacts")
      .findOne({ kind: "pool-output" }, { sort: { updatedAt: -1 } });
    return (doc?.payload as PoolOutputArtifact | undefined) ?? null;
  } catch {
    return null;
  }
}

async function getMergedSettings(): Promise<Record<string, string>> {
  try {
    const db = await getMongoDb();
    const doc = (await db
      .collection("settings")
      .findOne({ recordKey: "ui-settings" })) as SettingsDoc | null;
    return doc?.values ?? {};
  } catch {
    return {};
  }
}

function asNumber(...vals: Array<unknown>): number | null {
  for (const v of vals) {
    const n = Number(v ?? "");
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function asString(...vals: Array<unknown>): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function toTsSec(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    const d = Date.parse(v);
    if (Number.isFinite(d) && d > 0) return Math.floor(d / 1000);
  }
  return null;
}

function getBirdeyeApiKey(settings: Record<string, string>): string | null {
  const fromDb = settings.BIRDEYE_API_KEY?.trim();
  if (fromDb) return fromDb;
  const fromEnv = process.env.BIRDEYE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return readRootEnvBirdeyeKey();
}

function getRpcUrl(settings: Record<string, string>): string {
  const fromDb = settings.RPC_URL?.trim();
  if (fromDb) return fromDb;
  const fromEnv = process.env.RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  const clusterRaw = (settings.CLUSTER?.trim() || process.env.CLUSTER?.trim() || "devnet").toLowerCase();
  const cluster = clusterRaw === "mainnet" ? "mainnet-beta" : clusterRaw;
  return clusterApiUrl(cluster as "devnet" | "mainnet-beta" | "testnet");
}

async function fetchBirdeyeOverview(
  tokenAddress: string,
  apiKey: string
): Promise<BirdeyeTokenOverview | null> {
  try {
    const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(tokenAddress)}`;
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
    return (data?.data ?? data ?? null) as BirdeyeTokenOverview | null;
  } catch {
    return null;
  }
}

async function getCodexAuthToken(): Promise<string | null> {
  try {
    if (codexTokenCache.token && Date.now() - codexTokenCache.ts < 4 * 60 * 1000) {
      return codexTokenCache.token;
    }
    const now = Math.floor(Date.now() / 1000);
    const rounded = now - (now % 300);
    const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(rounded)));
    const challenge = Buffer.from(new Uint8Array(hashBuf)).toString("base64");
    const r = await fetch(
      `https://d2gndqco47nwa6.cloudfront.net?challenge=${encodeURIComponent(challenge)}`,
      { cache: "no-store" }
    );
    if (!r.ok) return null;
    const token = (await r.text()).trim();
    if (!token || token.includes("Failed challenge")) return null;
    codexTokenCache = { token, ts: Date.now() };
    return token;
  } catch {
    return null;
  }
}

async function fetchCodex24hStats(poolAddress: string): Promise<Codex24hStats | null> {
  const jwt = await getCodexAuthToken();
  if (!jwt) return null;
  const pairId = `${poolAddress}:1399811149`;
  const query = `query GetDetailedStats($pairId: String!, $tokenOfInterest: TokenOfInterest, $statsType: TokenPairStatisticsType) {
    getDetailedStats(pairId: $pairId, tokenOfInterest: $tokenOfInterest, statsType: $statsType) {
      stats_day1 {
        buyVolume { currentValue }
        sellVolume { currentValue }
        buys { currentValue }
        sells { currentValue }
      }
    }
  }`;
  try {
    const r = await fetch("https://graph.codex.io/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        operationName: "GetDetailedStats",
        query,
        variables: {
          pairId,
          tokenOfInterest: "token1",
          statsType: "FILTERED",
        },
      }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const payload = await r.json();
    const s = payload?.data?.getDetailedStats?.stats_day1;
    if (!s) return null;
    return {
      buys24h: Number(s?.buys?.currentValue ?? 0) || 0,
      sells24h: Number(s?.sells?.currentValue ?? 0) || 0,
      buyVolume: Number(s?.buyVolume?.currentValue ?? 0) || 0,
      sellVolume: Number(s?.sellVolume?.currentValue ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

async function getSolUsd(apiKey: string | null): Promise<number | null> {
  if (apiKey) {
    const solOverview = await fetchBirdeyeOverview(
      "So11111111111111111111111111111111111111112",
      apiKey
    );
    const fromBirdeye = asNumber(solOverview?.price, solOverview?.priceUsd);
    if (fromBirdeye) return fromBirdeye;
  }
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

async function fetchDbTradeStats(params: {
  quoteMintType: "WSOL" | "USDC";
  solUsd: number | null;
}): Promise<DbTradeStats | null> {
  try {
    const db = await getMongoDb();
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const rows = (await db
      .collection("pool_events")
      .find({})
      .sort({ createdAt: 1 })
      .limit(6000)
      .toArray()) as Array<{
      event?: {
        eventType?: string;
        type?: string;
        amountA?: number | string;
        amountB?: number | string;
        timestamp?: number | string;
      };
      createdAt?: string;
    }>;

    let lastPriceUsd: number | null = null;
    let volume24h = 0;
    let buys24h = 0;
    let sells24h = 0;
    for (const row of rows) {
      const e = row?.event ?? {};
      const t = String(e.eventType ?? e.type ?? "").toLowerCase();
      const isBuy = t.includes("buy");
      const isSell = t.includes("sell");
      const isSwap = t.includes("swap");
      if (!isBuy && !isSell && !isSwap) continue;

      const ts = toTsSec(e.timestamp) ?? toTsSec(row.createdAt) ?? 0;
      if (!ts || ts < since) continue;
      const amountA = Number(e.amountA ?? 0);
      const amountB = Number(e.amountB ?? 0);
      if (!Number.isFinite(amountA) || !Number.isFinite(amountB) || amountA <= 0 || amountB <= 0) continue;
      const priceNative = amountB / amountA;
      const quoteUsd = params.quoteMintType === "USDC" ? 1 : (params.solUsd ?? 0);
      if (quoteUsd <= 0) continue;
      const priceUsd = priceNative * quoteUsd;
      if (Number.isFinite(priceUsd) && priceUsd > 0) lastPriceUsd = priceUsd;
      const volUsd = amountB * quoteUsd;
      if (Number.isFinite(volUsd) && volUsd > 0) volume24h += volUsd;
      if (isBuy) buys24h += 1;
      if (isSell) sells24h += 1;
    }

    return { lastPriceUsd, volume24h, buys24h, sells24h };
  } catch {
    return null;
  }
}

async function fetchOnchainStats(params: {
  rpcUrl: string;
  poolAddress: string;
  quoteMintType: "WSOL" | "USDC";
  solUsd: number | null;
}): Promise<Partial<PoolStats>> {
  try {
    const connection = new Connection(params.rpcUrl, "confirmed");
    const cpAmm = new CpAmm(connection);
    const poolState = await cpAmm._program.account.pool.fetch(new PublicKey(params.poolAddress));
    const [tokenA, tokenB, supply] = await Promise.all([
      connection.getTokenAccountBalance(poolState.tokenAVault),
      connection.getTokenAccountBalance(poolState.tokenBVault),
      connection.getTokenSupply(poolState.tokenAMint),
    ]);
    const a = Number(tokenA.value.uiAmountString ?? "0");
    const b = Number(tokenB.value.uiAmountString ?? "0");
    const s = Number(supply.value.uiAmountString ?? "0");
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return {};
    const priceNative = b / a;
    const quoteUsd = params.quoteMintType === "USDC" ? 1 : (params.solUsd && params.solUsd > 0 ? params.solUsd : 1);
    const priceUsd = priceNative * quoteUsd;
    return {
      priceNative: String(priceNative),
      priceUsd: String(priceUsd),
      liquidity: b * quoteUsd * 2,
      marketCap: s > 0 ? s * priceUsd : 0,
    };
  } catch {
    return {};
  }
}

async function buildLaunchDerivedStats(
  tokenMintArtifact: TokenMintArtifact | null,
  poolOutputArtifact: PoolOutputArtifact | null,
  settings: Record<string, string>,
  apiKey: string | null
): Promise<Partial<PoolStats>> {
  const quoteMintType = (poolOutputArtifact?.quoteMintType ?? settings.QUOTE_MINT_TYPE ?? "WSOL").toUpperCase();
  const tokenADecimals = toNumberSafe(settings.TOKEN_DECIMALS, tokenMintArtifact?.tokenDecimals ?? 6);
  const quoteDecimals = quoteMintType === "USDC" ? 6 : 9;
  const tokenAInputRaw = toBigIntSafe(settings.TOKEN_A_INPUT_AMOUNT_RAW, 0n);
  const tokenBInputRaw = toBigIntSafe(settings.TOKEN_B_INPUT_AMOUNT_RAW, 0n);
  const tokenSupplyRaw = toBigIntSafe(
    settings.TOKEN_INITIAL_SUPPLY_RAW,
    toBigIntSafe(tokenMintArtifact?.tokenInitialSupplyRaw, 0n)
  );
  if (tokenAInputRaw <= 0n || tokenBInputRaw <= 0n) return {};

  const tokenAAmount = decimalFromRaw(tokenAInputRaw, tokenADecimals);
  const tokenBAmount = decimalFromRaw(tokenBInputRaw, quoteDecimals);
  if (tokenAAmount <= 0 || tokenBAmount <= 0) return {};

  const priceInQuote = tokenBAmount / tokenAAmount;
  const solUsd = quoteMintType === "WSOL" ? await getSolUsd(apiKey) : null;
  const priceUsd = quoteMintType === "USDC" ? priceInQuote : (solUsd ? priceInQuote * solUsd : 0);
  const quoteUsd = quoteMintType === "USDC" ? tokenBAmount : (solUsd ? tokenBAmount * solUsd : 0);
  const supply = decimalFromRaw(tokenSupplyRaw, tokenADecimals);
  const marketCap = supply > 0 && priceUsd > 0 ? supply * priceUsd : 0;

  return {
    priceUsd: priceUsd > 0 ? String(priceUsd) : "0",
    priceNative: String(priceInQuote),
    liquidity: quoteUsd > 0 ? quoteUsd : 0,
    marketCap: marketCap > 0 ? marketCap : 0,
  };
}

export async function GET() {
  try {
    const [settings, launchState, tokenMintArtifact, poolOutputArtifact] = await Promise.all([
      getMergedSettings(),
      getLatestLaunchState(),
      getLatestTokenMintArtifact(),
      getLatestPoolOutputArtifact(),
    ]);
    const apiKey = getBirdeyeApiKey(settings);
    const launchDerived = await buildLaunchDerivedStats(
      tokenMintArtifact,
      poolOutputArtifact,
      settings,
      apiKey
    );
    const tokenAddress =
      launchState?.tokenMint ??
      launchState?.tokenMintAddress ??
      tokenMintArtifact?.tokenMint ??
      null;
    const fallbackName = tokenMintArtifact?.tokenName ?? "";
    const fallbackSymbol = tokenMintArtifact?.tokenSymbol ?? "";
    const fallbackImageUrl = tokenMintArtifact?.imageIpfsUrl ?? undefined;

    const quoteMintType =
      ((poolOutputArtifact?.quoteMintType ?? settings.QUOTE_MINT_TYPE ?? "WSOL").toUpperCase() as "WSOL" | "USDC");
    const poolAddress = launchState?.poolAddress ?? poolOutputArtifact?.poolAddress ?? null;
    const solUsd = await getSolUsd(apiKey);
    const onchain = poolAddress
      ? await fetchOnchainStats({
          rpcUrl: getRpcUrl(settings),
          poolAddress,
          quoteMintType,
          solUsd,
        })
      : {};
    const dbTrades = await fetchDbTradeStats({ quoteMintType, solUsd });
    const [codex, chartHistoryPrice] = await Promise.all([
      poolAddress ? fetchCodex24hStats(poolAddress) : Promise.resolve(null),
      fetchLatestChartHistoryPrice(poolAddress),
    ]);

    if (!tokenAddress) {
      return NextResponse.json(
        withFallbackStats(
          {
            ...launchDerived,
            ...onchain,
            priceUsd:
              chartHistoryPrice && chartHistoryPrice > 0
                ? String(chartHistoryPrice)
                : dbTrades?.lastPriceUsd && dbTrades.lastPriceUsd > 0
                  ? String(dbTrades.lastPriceUsd)
                  : (onchain.priceUsd ?? launchDerived.priceUsd ?? "0"),
            volume24h:
              dbTrades && dbTrades.volume24h > 0
                ? dbTrades.volume24h
                : codex
                  ? codex.buyVolume + codex.sellVolume
                  : launchDerived.volume24h,
            buys24h:
              dbTrades && dbTrades.buys24h > 0
                ? dbTrades.buys24h
                : codex?.buys24h ?? launchDerived.buys24h ?? 0,
            sells24h:
              dbTrades && dbTrades.sells24h > 0
                ? dbTrades.sells24h
                : codex?.sells24h ?? launchDerived.sells24h ?? 0,
          },
          fallbackName,
          fallbackSymbol,
          fallbackImageUrl
        )
      );
    }

    const overview = apiKey ? await fetchBirdeyeOverview(tokenAddress, apiKey) : null;
    if (!overview) {
      return NextResponse.json(
        withFallbackStats(
          {
            ...launchDerived,
            ...onchain,
            priceUsd:
              chartHistoryPrice && chartHistoryPrice > 0
                ? String(chartHistoryPrice)
                : dbTrades?.lastPriceUsd && dbTrades.lastPriceUsd > 0
                  ? String(dbTrades.lastPriceUsd)
                  : (onchain.priceUsd ?? launchDerived.priceUsd ?? "0"),
            volume24h:
              dbTrades && dbTrades.volume24h > 0
                ? dbTrades.volume24h
                : codex
                  ? codex.buyVolume + codex.sellVolume
                  : launchDerived.volume24h,
            buys24h:
              dbTrades && dbTrades.buys24h > 0
                ? dbTrades.buys24h
                : codex?.buys24h ?? launchDerived.buys24h ?? 0,
            sells24h:
              dbTrades && dbTrades.sells24h > 0
                ? dbTrades.sells24h
                : codex?.sells24h ?? launchDerived.sells24h ?? 0,
          },
          fallbackName,
          fallbackSymbol,
          fallbackImageUrl
        )
      );
    }

    const stats = withFallbackStats(
      {
        ...launchDerived,
        ...onchain,
        priceUsd: String(
          chartHistoryPrice && chartHistoryPrice > 0
            ? chartHistoryPrice
            : dbTrades?.lastPriceUsd && dbTrades.lastPriceUsd > 0
              ? dbTrades.lastPriceUsd
              : (asNumber(onchain.priceUsd, overview.price, overview.priceUsd) ?? launchDerived.priceUsd ?? "0")
        ),
        priceNative:
          quoteMintType === "USDC"
            ? String(asNumber(onchain.priceNative, overview.price, overview.priceUsd) ?? launchDerived.priceNative ?? "0")
            : String(asNumber(onchain.priceNative, launchDerived.priceNative) ?? "0"),
        volume24h:
          dbTrades && dbTrades.volume24h > 0
            ? dbTrades.volume24h
            : codex
              ? codex.buyVolume + codex.sellVolume
              : (asNumber(overview.v24hUSD, overview.volume24h) ?? launchDerived.volume24h ?? 0),
        marketCap: asNumber(onchain.marketCap, overview.marketCap, overview.mc) ?? launchDerived.marketCap ?? 0,
        liquidity: asNumber(onchain.liquidity, overview.liquidityUsd, overview.liquidity) ?? launchDerived.liquidity ?? 0,
        priceChange24h:
          Number(overview.priceChange24hPercent ?? overview.priceChange24h ?? launchDerived.priceChange24h ?? 0),
        buys24h:
          dbTrades && dbTrades.buys24h > 0
            ? dbTrades.buys24h
            : codex?.buys24h ?? launchDerived.buys24h ?? 0,
        sells24h:
          dbTrades && dbTrades.sells24h > 0
            ? dbTrades.sells24h
            : codex?.sells24h ?? launchDerived.sells24h ?? 0,
        fdv: asNumber(overview.fdv, overview.marketCap, overview.mc) ?? launchDerived.marketCap ?? 0,
        symbol: asString(overview.symbol) ?? fallbackSymbol,
        name: asString(overview.name) ?? fallbackName,
        imageUrl: asString(overview.logoURI, overview.logoUrl) ?? fallbackImageUrl,
      },
      fallbackName,
      fallbackSymbol,
      fallbackImageUrl
    );

    return NextResponse.json(stats);
  } catch {
    return NextResponse.json(withFallbackStats({}, "Token", "—"));
  }
}
