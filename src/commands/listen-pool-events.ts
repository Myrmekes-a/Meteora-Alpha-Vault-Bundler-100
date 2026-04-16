import "dotenv/config";

import bs58 from "bs58";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  subscribe,
  CommitmentLevel,
  type LaserstreamConfig,
  type SubscribeRequest,
} from "helius-laserstream";
import { spawn } from "node:child_process";
import { getEnvOrDefault, getRequiredEnv } from "../lib/utils";
import { appendPoolEvent, getDistributionWalletsByKey, getLaunchStateByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const recentReplicatorBySig = new Map<string, number>();
let replicatorInFlight = false;
let lastReplicatorTriggeredAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSellThenBuy(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/commands/sell-then-buy.ts"], {
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: false,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`src/commands/sell-then-buy.ts exited ${code}`));
    });
  });
}

async function getPoolAddress(): Promise<string> {
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const state = await getLaunchStateByKey(statePath);
  if (!state) {
    throw new Error(
      `Pool address not found in Mongo launch state. Ensure launch state exists for key: ${statePath}`
    );
  }
  if (!state.poolAddress) {
    throw new Error(`poolAddress missing in Mongo launch state for key: ${statePath}`);
  }
  return state.poolAddress;
}

/** LaserStream transaction meta - raw format from Yellowstone/proto */
type LaserStreamMeta = {
  preTokenBalances?: Array<{ accountIndex?: number; account_index?: number; mint?: string; owner?: string; uiTokenAmount?: { uiAmount?: number; amount?: string }; ui_token_amount?: { ui_amount?: number; amount?: string } }>;
  postTokenBalances?: Array<{ accountIndex?: number; account_index?: number; mint?: string; owner?: string; uiTokenAmount?: { uiAmount?: number; amount?: string }; ui_token_amount?: { ui_amount?: number; amount?: string } }>;
  logMessages?: string[];
  log_messages?: string[];
  loadedWritableAddresses?: Uint8Array[] | Buffer[];
  loadedReadonlyAddresses?: Uint8Array[] | Buffer[];
  loaded_writable_addresses?: Uint8Array[] | Buffer[];
  loaded_readonly_addresses?: Uint8Array[] | Buffer[];
  innerInstructions?: Array<{ index?: number; instructions?: Array<{ programIdIndex?: number; accounts?: number[]; accountsKeyIndexes?: number[] }> }>;
  inner_instructions?: Array<{ index?: number; instructions?: Array<{ program_id_index?: number; accounts?: Uint8Array | Buffer }> }>;
};

/** Normalize update to { rawTx, meta, slot, sig } - handles LaserStream gRPC structure (camelCase + snake_case) */
function normalizeTxUpdate(update: Record<string, unknown>): {
  rawTx: { message?: { account_keys?: Buffer[]; accountKeys?: Buffer[] }; signatures?: Buffer[] };
  meta: LaserStreamMeta;
  slot: number;
  sig: string;
} | null {
  const txWrapper = update.transaction as Record<string, unknown> | undefined;
  if (!txWrapper || typeof txWrapper !== "object") return null;
  const txInfo = (txWrapper.transaction ?? txWrapper) as Record<string, unknown> | undefined;
  if (!txInfo || typeof txInfo !== "object") return null;
  let rawTx = (txInfo.transaction ?? txInfo) as Record<string, unknown>;
  if (rawTx && typeof rawTx === "object" && "transaction" in rawTx && !("message" in rawTx)) {
    rawTx = (rawTx.transaction as Record<string, unknown>) ?? rawTx;
  }
  const meta = (txInfo.meta ?? (rawTx as { meta?: LaserStreamMeta }).meta ?? {}) as LaserStreamMeta;
  const slot = Number(txWrapper.slot ?? update.slot ?? 0);
  const sigBytes = (txInfo.signature ?? (rawTx.signatures as Buffer[])?.[0]) as Buffer | undefined;
  const sig = sigBytes?.length ? bs58.encode(Buffer.from(sigBytes)) : "unknown";
  return { rawTx: rawTx as { message?: { account_keys?: Buffer[]; accountKeys?: Buffer[] }; signatures?: Buffer[] }, meta, slot, sig };
}

/** Extract message (with account_keys) from various LaserStream nesting shapes */
function getTxMessage(rawTx: Record<string, unknown>): Record<string, unknown> {
  const inner = rawTx.transaction ?? rawTx;
  if (inner && typeof inner === "object") {
    const out = (inner as Record<string, unknown>).message ?? inner;
    return out as Record<string, unknown>;
  }
  const out = (rawTx as { message?: unknown }).message ?? rawTx;
  return out as Record<string, unknown>;
}

/** Check if targetAccount appears in inner instructions. Resolves account indices using full account list. */
function poolInInnerInstructions(
  meta: LaserStreamMeta,
  allAccounts: string[],
  targetAccount: string
): boolean {
  const inners = meta.innerInstructions ?? meta.inner_instructions ?? [];
  for (const g of inners) {
    const ixs = g.instructions ?? [];
    for (const ix of ixs) {
      let acctIdxs: number[] = [];
      const raw = ix.accounts ?? (ix as { accountsKeyIndexes?: number[] }).accountsKeyIndexes;
      if (Array.isArray(raw)) acctIdxs = raw;
      else if (raw && typeof raw === "object" && "length" in raw) {
        const buf = Buffer.isBuffer(raw) ? raw : new Uint8Array(raw);
        for (let i = 0; i < buf.length; i++) acctIdxs.push(buf[i]!);
      }
      for (const idx of acctIdxs) {
        if (allAccounts[idx] === targetAccount) return true;
      }
    }
  }
  return false;
}

/** Build account list from LaserStream raw tx (account_keys bytes + loaded addresses) */
function getAccountKeysFromLaserStream(
  txMsg: { accountKeys?: Uint8Array[] | Buffer[]; account_keys?: Uint8Array[] | Buffer[] },
  meta: LaserStreamMeta
): string[] {
  const rawKeys = txMsg.accountKeys ?? txMsg.account_keys ?? [];
  const arr = Array.isArray(rawKeys) ? rawKeys : [];
  const staticKeys = arr.map((b) =>
    Buffer.isBuffer(b) ? bs58.encode(b) : bs58.encode(b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer))
  );
  const loadedWr = meta.loadedWritableAddresses ?? meta.loaded_writable_addresses ?? [];
  const loadedRd = meta.loadedReadonlyAddresses ?? meta.loaded_readonly_addresses ?? [];
  const toB58 = (b: Uint8Array | Buffer) =>
    Buffer.isBuffer(b) ? bs58.encode(b) : bs58.encode(b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer));
  return [...staticKeys, ...loadedWr.map(toB58), ...loadedRd.map(toB58)];
}

/** Parse LaserStream tx data locally - no RPC. Returns eventType + swap amounts. */
function parseLaserStreamTx(
  txUpdate: {
    transaction?: Record<string, unknown>;
    meta?: LaserStreamMeta;
  },
  tokenAVault: string,
  tokenBVault: string,
  opts?: { tokenAMint?: string; tokenBMint?: string; poolAddress?: string }
): { eventType: string; amountA: number; amountB: number } {
  const tx = txUpdate.transaction;
  const meta = txUpdate.meta ?? {};
  const msg = tx && typeof tx === "object" ? getTxMessage(tx as Record<string, unknown>) : {};
  const accts = getAccountKeysFromLaserStream(msg as { accountKeys?: Buffer[]; account_keys?: Buffer[] }, meta);
  const idxA = accts.indexOf(tokenAVault);
  const idxB = accts.indexOf(tokenBVault);

  type BalEntry = {
    accountIndex?: number;
    account_index?: number;
    uiTokenAmount?: { uiAmount?: number; amount?: string; decimals?: number; uiAmountString?: string };
    ui_token_amount?: { ui_amount?: number; amount?: string; decimals?: number; ui_amount_string?: string };
  };
  const pre: BalEntry[] =
    meta.preTokenBalances ?? (meta as { pre_token_balances?: BalEntry[] }).pre_token_balances ?? [];
  const post: BalEntry[] =
    meta.postTokenBalances ?? (meta as { post_token_balances?: BalEntry[] }).post_token_balances ?? [];
  const getIdx = (b: BalEntry) => b.accountIndex ?? b.account_index ?? -1;
  const getUiAmt = (b: BalEntry): number => {
    const ui = b.uiTokenAmount?.uiAmount ?? b.ui_token_amount?.ui_amount;
    if (ui != null && !Number.isNaN(ui)) return ui;
    const uiStr = b.uiTokenAmount?.uiAmountString ?? b.ui_token_amount?.ui_amount_string;
    if (uiStr) {
      const parsed = parseFloat(uiStr);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const amtStr = b.uiTokenAmount?.amount ?? b.ui_token_amount?.amount;
    const dec = b.uiTokenAmount?.decimals ?? b.ui_token_amount?.decimals ?? 6;
    if (amtStr) {
      const parsed = parseFloat(amtStr) / Math.pow(10, dec);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  };

  const preMap = new Map(pre.map((b) => [getIdx(b), getUiAmt(b)]));
  const postMap = new Map(post.map((b) => [getIdx(b), getUiAmt(b)]));
  let deltaA = idxA >= 0 ? (postMap.get(idxA) ?? 0) - (preMap.get(idxA) ?? 0) : 0;
  let deltaB = idxB >= 0 ? (postMap.get(idxB) ?? 0) - (preMap.get(idxB) ?? 0) : 0;

  // Fallback: when one or both vault deltas are zero, aggregate balance deltas by mint
  // using the known tokenA/tokenB mints. This fixes cases where routed swaps don't
  // touch the vaults directly but balances still change for those mints.
  if ((deltaA === 0 || deltaB === 0) && opts?.tokenAMint && opts?.tokenBMint) {
    const deltaByMint = new Map<string, number>();
    const allIdx = new Set([...pre.map(getIdx), ...post.map(getIdx)]);
    for (const idx of allIdx) {
      if (idx < 0) continue;
      const d = (postMap.get(idx) ?? 0) - (preMap.get(idx) ?? 0);
      if (d === 0) continue;
      const entry = post.find((b) => getIdx(b) === idx) ?? pre.find((b) => getIdx(b) === idx);
      const mint = (entry as { mint?: string })?.mint ?? "";
      if (mint) deltaByMint.set(mint, (deltaByMint.get(mint) ?? 0) + d);
    }
    deltaA = deltaByMint.get(opts.tokenAMint) ?? 0;
    deltaB = deltaByMint.get(opts.tokenBMint) ?? 0;
  }

  let eventType = "TX";
  if (deltaA > 0 && deltaB < 0) eventType = "Sell";
  else if (deltaA < 0 && deltaB > 0) eventType = "Buy";
  else if (deltaA > 0 && deltaB > 0) eventType = "Add";
  else if (deltaA < 0 && deltaB < 0) eventType = "Remove";

  // If logs clearly indicate a swap route but both deltas have the same sign,
  // prefer labeling as a generic Swap instead of Add/Remove to avoid misclassification.
  const sameSign =
    (deltaA > 0 && deltaB > 0) ||
    (deltaA < 0 && deltaB < 0);
  if (sameSign && isSwapTx(meta)) {
    eventType = "Swap";
  }

  const amountA = Math.abs(deltaA);
  const amountB = Math.abs(deltaB);
  return { eventType, amountA, amountB };
}

/** Detect swap/liquidity-related txs from log messages */
function isSwapTx(meta: LaserStreamMeta): boolean {
  const logs = meta.logMessages ?? meta.log_messages ?? [];
  const swapPatterns = [
    "Instruction: Swap",
    "Instruction: SwapV2",
    "Instruction: SharedAccountsRoute",
    "Instruction: Route",
    "Instruction: SwapBaseIn",
    "Instruction: SwapBaseOut",
    "Instruction: RemoveLiquidity",
    "Instruction: AddLiquidity",
  ];
  return logs.some((log) =>
    swapPatterns.some((p) => typeof log === "string" && log.includes(p))
  );
}

type BalEntryFull = {
  accountIndex?: number;
  account_index?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { uiAmount?: number; amount?: string; decimals?: number; uiAmountString?: string };
  ui_token_amount?: { ui_amount?: number; amount?: string; decimals?: number; ui_amount_string?: string };
};

/** Parse any swap by token balance deltas. Uses sum per mint; for multi-hop (net≈0) uses max |delta|. */
function parseGenericSwap(meta: LaserStreamMeta): {
  eventType: string;
  amountA: number;
  amountB: number;
  mintA?: string;
  mintB?: string;
} {
  const pre: BalEntryFull[] =
    meta.preTokenBalances ?? (meta as { pre_token_balances?: BalEntryFull[] }).pre_token_balances ?? [];
  const post: BalEntryFull[] =
    meta.postTokenBalances ?? (meta as { post_token_balances?: BalEntryFull[] }).post_token_balances ?? [];
  const getIdx = (b: BalEntryFull) => b.accountIndex ?? b.account_index ?? -1;
  const getUiAmt = (b: BalEntryFull): number => {
    const ui = b.uiTokenAmount?.uiAmount ?? b.ui_token_amount?.ui_amount;
    if (ui != null && !Number.isNaN(ui)) return ui;
    const uiStr = b.uiTokenAmount?.uiAmountString ?? b.ui_token_amount?.ui_amount_string;
    if (uiStr) {
      const parsed = parseFloat(uiStr);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const amtStr = b.uiTokenAmount?.amount ?? b.ui_token_amount?.amount;
    const dec = b.uiTokenAmount?.decimals ?? b.ui_token_amount?.decimals ?? 6;
    if (amtStr) {
      const parsed = parseFloat(amtStr) / Math.pow(10, dec);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  };

  const preMap = new Map(pre.map((b) => [getIdx(b), getUiAmt(b)]));
  const postMap = new Map(post.map((b) => [getIdx(b), getUiAmt(b)]));
  const sumByMint = new Map<string, number>();
  const maxByMint = new Map<string, number>();
  const signByMint = new Map<string, number>();
  const allIdx = new Set([...pre.map(getIdx), ...post.map(getIdx)]);

  for (const idx of allIdx) {
    if (idx < 0) continue;
    const d = (postMap.get(idx) ?? 0) - (preMap.get(idx) ?? 0);
    if (d === 0) continue;
    const entry = post.find((b) => getIdx(b) === idx) ?? pre.find((b) => getIdx(b) === idx);
    const mint = (entry as { mint?: string })?.mint ?? "";
    if (!mint) continue;
    sumByMint.set(mint, (sumByMint.get(mint) ?? 0) + d);
    const prevMax = maxByMint.get(mint) ?? 0;
    if (Math.abs(d) > Math.abs(prevMax)) {
      maxByMint.set(mint, d);
      signByMint.set(mint, d > 0 ? 1 : -1);
    }
  }

  const useMax = (sum: number) => Math.abs(sum) < 1e-10;
  const entries = [...sumByMint.keys()].map((mint) => {
    const sum = sumByMint.get(mint) ?? 0;
    const maxVal = maxByMint.get(mint) ?? 0;
    const amt = useMax(sum) ? Math.abs(maxVal) : Math.abs(sum);
    const sign = useMax(sum) ? (signByMint.get(mint) ?? 0) : (sum > 0 ? 1 : -1);
    return { mint, amt, sign };
  });
  const sorted = entries.filter((e) => e.amt > 0).sort((a, b) => b.amt - a.amt);
  const [first, second] = sorted;
  const deltaA = first ? first.sign * first.amt : 0;
  const deltaB = second ? second.sign * second.amt : 0;

  let eventType = "Swap";
  if (deltaA > 0 && deltaB < 0) eventType = "Sell";
  else if (deltaA < 0 && deltaB > 0) eventType = "Buy";
  else if (deltaA > 0 && deltaB > 0) eventType = "Add";
  else if (deltaA < 0 && deltaB < 0) eventType = "Remove";

  return {
    eventType,
    amountA: first?.amt ?? 0,
    amountB: second?.amt ?? 0,
    mintA: first?.mint,
    mintB: second?.mint,
  };
}

/** Parse RPC getParsedTransaction format - fallback when gRPC parse returns TX */
function parseRpcParsedTx(
  parsed: {
    meta?: {
      preTokenBalances?: Array<{ accountIndex: number; uiTokenAmount?: { uiAmount?: number }; mint?: string }>;
      postTokenBalances?: Array<{ accountIndex: number; uiTokenAmount?: { uiAmount?: number }; mint?: string }>;
      loadedWritableAddresses?: string[];
      loadedReadonlyAddresses?: string[];
      loadedAddresses?: { writable?: string[]; readonly?: string[] };
    };
    transaction?: { message?: { accountKeys?: Array<{ pubkey: string | { toBase58?: () => string } }> } };
  },
  tokenAVault: string,
  tokenBVault: string
): { eventType: string; amountA: number; amountB: number } {
  const meta = parsed.meta ?? {};
  const msg = parsed.transaction?.message ?? {};
  const toPubkey = (k: { pubkey: string | { toBase58?: () => string } }) =>
    typeof k.pubkey === "string" ? k.pubkey : (k.pubkey as { toBase58: () => string }).toBase58?.() ?? String(k.pubkey);
  const staticKeys = (msg.accountKeys ?? []).map(toPubkey);
  const loadedWr =
    meta.loadedAddresses?.writable ?? meta.loadedWritableAddresses ?? [];
  const loadedRd =
    meta.loadedAddresses?.readonly ?? meta.loadedReadonlyAddresses ?? [];
  const allAccts = [
    ...staticKeys,
    ...(Array.isArray(loadedWr) ? loadedWr : []),
    ...(Array.isArray(loadedRd) ? loadedRd : []),
  ];
  const idxA = allAccts.indexOf(tokenAVault);
  const idxB = allAccts.indexOf(tokenBVault);
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const getIdx = (b: { accountIndex: number }) => b.accountIndex;
  const getUi = (b: { uiTokenAmount?: { uiAmount?: number } }) => b.uiTokenAmount?.uiAmount ?? 0;
  const preMap = new Map(pre.map((b) => [getIdx(b), getUi(b)]));
  const postMap = new Map(post.map((b) => [getIdx(b), getUi(b)]));
  const deltaA = idxA >= 0 ? (postMap.get(idxA) ?? 0) - (preMap.get(idxA) ?? 0) : 0;
  const deltaB = idxB >= 0 ? (postMap.get(idxB) ?? 0) - (preMap.get(idxB) ?? 0) : 0;
  let eventType = "TX";
  if (deltaA > 0 && deltaB < 0) eventType = "Sell";
  else if (deltaA < 0 && deltaB > 0) eventType = "Buy";
  else if (deltaA > 0 && deltaB > 0) eventType = "Add";
  else if (deltaA < 0 && deltaB < 0) eventType = "Remove";
  return { eventType, amountA: Math.abs(deltaA), amountB: Math.abs(deltaB) };
}

type TxMeta = {
  preTokenBalances?: Array<{ accountIndex: number; uiTokenAmount?: { uiAmount?: number } }>;
  postTokenBalances?: Array<{ accountIndex: number; uiTokenAmount?: { uiAmount?: number } }>;
  loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] };
};

interface PoolEvent {
  timestamp: string;
  type: "transaction" | "account_update";
  eventType: string;
  signature: string;
  slot?: number;
  amountA?: number;
  amountB?: number;
  accountRole?: string;
  account?: string;
  owner?: string;
}

function sampleRandom<T>(arr: T[], count: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, Math.min(count, copy.length)));
}

async function triggerReplicator(poolAddress: string, amountB: number, targetBuyStr: string): Promise<void> {
  const ts = new Date().toISOString();
  const sellPctEnv = process.env.SELL_PERCENTAGE?.trim();
  if (!sellPctEnv) return;
  const cooldownMs = Math.max(0, Number(process.env.REPLICATOR_COOLDOWN_MS?.trim() || "12000"));
  const nowMs = Date.now();
  if (replicatorInFlight) {
    console.log(`[${ts}] replicator busy -> skip trigger for amountB=${amountB.toFixed(6)}`);
    return;
  }
  if (nowMs - lastReplicatorTriggeredAt < cooldownMs) {
    const waitMs = cooldownMs - (nowMs - lastReplicatorTriggeredAt);
    console.log(`[${ts}] replicator cooldown ${waitMs}ms remaining -> skip trigger`);
    return;
  }
  replicatorInFlight = true;
  lastReplicatorTriggeredAt = nowMs;

  const walletsKey = getEnvOrDefault(
    "DISTRIBUTION_WALLETS_KEYSTORE_PATH",
    "data/distribution-wallets.keystore.json"
  );
  const requestedWalletCount = Math.max(
    1,
    Number(process.env.REPLICATOR_WALLET_COUNT?.trim() || "1")
  );
  const wallets = (await getDistributionWalletsByKey(walletsKey)) ?? [];
  const eligible = wallets.filter((w) => !!w.secretKeyBase58);
  const selected = sampleRandom(eligible, requestedWalletCount);

  try {
    if (selected.length === 0) {
      console.log(
        `[${ts}] amountB=${amountB.toFixed(6)} > TARGET_BUY_AMOUNT=${targetBuyStr} -> no distribution wallets found, fallback to main wallet`
      );
      await runSellThenBuy({ POOL_ADDRESS: poolAddress });
      return;
    }

    console.log(
      `[${ts}] amountB=${amountB.toFixed(6)} > TARGET_BUY_AMOUNT=${targetBuyStr} -> triggering sell-then-buy on ${selected.length}/${eligible.length} random wallets (sell ${sellPctEnv}%, buy ${process.env.BUY_PERCENTAGE?.trim() ?? "5"}%)`
    );
    for (const wallet of selected) {
      await runSellThenBuy({
        POOL_ADDRESS: poolAddress,
        WALLET_SECRET_KEY: wallet.secretKeyBase58,
      });
      // Small spacing helps reduce self-induced slippage spikes.
      await sleep(1200);
    }
  } finally {
    replicatorInFlight = false;
  }
}

async function saveEvent(eventsPath: string, event: PoolEvent): Promise<void> {
  try {
    await appendPoolEvent(eventsPath, event as unknown as Record<string, unknown>);
  } catch (e) {
    console.warn("Could not save event:", e);
  }
}

async function main(): Promise<void> {
  const apiKey = getRequiredEnv("LASERSTREAM_API_KEY");
  const endpoint = getRequiredEnv("LASERSTREAM_ENDPOINT");
  const poolAddress = await getPoolAddress();
  const eventsRecordKey = getEnvOrDefault("POOL_EVENTS_OUTPUT_PATH", "data/pool-events.jsonl");

  const rpcUrl = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpcUrl, "confirmed");
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm._program.account.pool.fetch(new PublicKey(poolAddress));
  const tokenAVault = poolState.tokenAVault.toBase58();
  const tokenBVault = poolState.tokenBVault.toBase58();
  const tokenAMint = poolState.tokenAMint.toBase58();
  const tokenBMint = poolState.tokenBMint.toBase58();

  const filterAccounts = [tokenAVault, tokenBVault, poolAddress];
  console.log("=== Meteora DAMM v2 Pool Event Listener (LaserStream) ===");
  console.log(`Pool (Mongo): ${poolAddress}`);
  console.log(`Token A vault: ${tokenAVault}`);
  console.log(`Token B vault: ${tokenBVault}`);
  console.log(`Events key: ${eventsRecordKey}`);
  console.log(`Token A mint: ${tokenAMint}`);
  console.log(`Token B mint: ${tokenBMint}`);

  const config: LaserstreamConfig = { apiKey, endpoint };

  const subscriptionRequest: SubscribeRequest = {
    commitment: CommitmentLevel.CONFIRMED,
    accountsDataSlice: [],
    transactions: {
      "pool-txs": {
        accountInclude: filterAccounts,
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false,
      },
    },
    // innerInstructions: {
    //   "pool-inner-instructions": {
    //     accountInclude: filterAccounts,
    //     accountExclude: [],
    //     accountRequired: [],
    //     vote: false,
    //     failed: false,
    //   },
    // },
    // accounts: {
    //   "pool-account": {
    //     account: filterAccounts,
    //     owner: [],
    //     filters: [],
    //   },
    // },
    slots: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    transactionsStatus: {},
  };

  const targetBuy = process.env.TARGET_BUY_AMOUNT?.trim();
  const sellPct = process.env.SELL_PERCENTAGE?.trim();
  const buyPct = process.env.BUY_PERCENTAGE?.trim();
  console.log(`Endpoint: ${endpoint}`);
  if (targetBuy) {
    if (sellPct) console.log(`Auto sell-then-buy when Buy amountB > ${targetBuy} (sell ${sellPct}% of wallet, buy ${buyPct ?? "5"}% of wSOL)`);
    else console.log(`Auto-sell when Buy amountB > ${targetBuy}`);
  }
  console.log("Listening for buy, sell, add, remove...\n");

  const stream = await subscribe(
    config,
    subscriptionRequest,
    async (update) => {
      const parsed = normalizeTxUpdate(update);
      const sigRaw = update.transaction?.transaction?.signature ?? update.transaction?.transaction?.transaction?.signatures?.[0];
      const sigStr = sigRaw?.length ? bs58.encode(Buffer.from(sigRaw)) : "unknown";
      if (process.env.DEBUG_PARSE === "1") {
        const meta = update.transaction?.transaction?.meta ?? update.transaction?.transaction?.transaction?.meta ?? {};
        console.log(`[DEBUG] update sig=${sigStr}`, meta);
      }

      const ts = new Date().toISOString();

      if (parsed && tokenAVault && tokenBVault) {
        const { rawTx, meta, slot, sig } = parsed;

        const txData = { transaction: rawTx, meta };
        const parseOpts =
          tokenAMint && tokenBMint
            ? { tokenAMint, tokenBMint, poolAddress }
            : undefined;
        let { eventType, amountA, amountB } = parseLaserStreamTx(
          txData,
          tokenAVault,
          tokenBVault,
          parseOpts
        );
        let usedGenericFallback = false;

        if (eventType === "TX") {
          try {
            const rpcParsed = await connection.getParsedTransaction(sig, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            });
            if (rpcParsed) {
              const rpcResult = parseRpcParsedTx(rpcParsed as unknown as Parameters<typeof parseRpcParsedTx>[0], tokenAVault, tokenBVault);
              if (rpcResult.eventType !== "TX") {
                eventType = rpcResult.eventType;
                amountA = rpcResult.amountA;
                amountB = rpcResult.amountB;
              }
            }
          } catch (e) {
            console.warn(`[parse] RPC fallback failed for ${sig}:`, (e as Error).message);
          }
          if (eventType === "TX" && isSwapTx(meta)) {
            const generic = parseGenericSwap(meta);
            if (generic.amountA > 0 || generic.amountB > 0) {
              eventType = generic.eventType;
              amountA = generic.amountA;
              amountB = generic.amountB;
              usedGenericFallback = true;
            }
          }
        }

        // If we still ended up with a swap-like event but one side is zero, try the
        // generic mint-based parser to recover better amounts (common in routed swaps).
        if (
          ["Buy", "Sell", "Swap"].includes(eventType) &&
          (amountA === 0 || amountB === 0) &&
          isSwapTx(meta)
        ) {
          const generic = parseGenericSwap(meta);
          if (generic.amountA > 0 && generic.amountB > 0) {
            eventType = generic.eventType;
            amountA = generic.amountA;
            amountB = generic.amountB;
            usedGenericFallback = true;
          }
        }

        if (process.env.DEBUG_PARSE === "1") {
          const msg = getTxMessage(rawTx as Record<string, unknown>);
          const accts = getAccountKeysFromLaserStream(msg as { accountKeys?: Buffer[]; account_keys?: Buffer[] }, meta);
          const idxA = accts.indexOf(tokenAVault);
          const idxB = accts.indexOf(tokenBVault);
          const hasKeys = !!(msg && typeof msg === "object" && ((msg as Record<string, unknown>).accountKeys ?? (msg as Record<string, unknown>).account_keys));
          console.log(`[DEBUG] eventType=${eventType} amountA=${amountA} amountB=${amountB} accts=${accts.length} idxA=${idxA} idxB=${idxB} hasAccountKeys=${hasKeys}`);
        }

        const isSwapEvent = ["Buy", "Sell", "Swap", "Add", "Remove"].includes(eventType);
        if (!isSwapEvent) return;

        const amountStr = `  amountA=${amountA.toFixed(6)}  amountB=${amountB.toFixed(6)}`;
        console.log(`[${ts}] [${eventType}]${amountStr}  slot=${slot}  ${sig}`);
        // const currentSlot = await connection.getSlot();
        // console.log("get slot ======>", currentSlot);

        const targetBuyStr = process.env.TARGET_BUY_AMOUNT?.trim();
        if (
          eventType === "Buy" &&
          targetBuyStr &&
          amountB > parseFloat(targetBuyStr)
        ) {
          // Deduplicate repeated callbacks for the same tx signature.
          const seenTs = recentReplicatorBySig.get(sig);
          const now = Date.now();
          const shouldTrigger = !(seenTs && now - seenTs < 60_000);
          if (shouldTrigger) {
            recentReplicatorBySig.set(sig, now);
            if (recentReplicatorBySig.size > 2000) {
              for (const [k, v] of recentReplicatorBySig.entries()) {
                if (now - v > 5 * 60_000) recentReplicatorBySig.delete(k);
              }
            }
          }
          const sellPctEnv = process.env.SELL_PERCENTAGE?.trim();
          if (sellPctEnv && shouldTrigger) {
            await triggerReplicator(poolAddress, amountB, targetBuyStr);
          } else if (shouldTrigger) {
            const tokenADecimals = Number(process.env.TOKEN_A_DECIMALS?.trim() || "6");
            const sellAmountRaw = Math.floor(amountA * 10 ** tokenADecimals);
            if (sellAmountRaw > 0) {
              console.log(`[${ts}] amountB=${amountB.toFixed(6)} > TARGET_BUY_AMOUNT=${targetBuyStr} -> triggering sell ${sellAmountRaw} raw`);
              spawn("npx", ["tsx", "src/commands/sell-pool-token.ts"], {
                env: {
                  ...process.env,
                  SELL_AMOUNT_RAW: String(sellAmountRaw),
                  POOL_ADDRESS: poolAddress,
                },
                stdio: "inherit",
                shell: false,
              }).unref();
            }
          }
        }

        const ev: PoolEvent = {
          timestamp: ts,
          type: "transaction",
          eventType,
          signature: sig,
          slot,
          amountA: amountA > 0 ? amountA : undefined,
          amountB: amountB > 0 ? amountB : undefined,
        };
        await saveEvent(eventsRecordKey, ev);
      }

      // if (update.account?.account) {
      //   const acc = update.account.account;
      //   const pubkey = acc.pubkey?.length ? bs58.encode(Buffer.from(acc.pubkey)) : "unknown";
      //   const owner = acc.owner?.length ? bs58.encode(Buffer.from(acc.owner)) : "unknown";
      //   const txnSig = acc.txnSignature?.length ? bs58.encode(Buffer.from(acc.txnSignature)) : null;
      //   const role = accountRole(pubkey, poolAddress, tokenAVault, tokenBVault);
      //   const ev: PoolEvent = {
      //     timestamp: ts,
      //     type: "account_update",
      //     eventType: "account_update",
      //     signature: txnSig || "",
      //     accountRole: role,
      //     account: pubkey,
      //     owner,
      //     solscanUrl: txnSig ? `https://solscan.io/tx/${txnSig}` : undefined,
      //   };
      //   await saveEvent(eventsPath, ev);
      // }
    },
    async (error) => {
      console.error("[LaserStream Error]", error);
    }
  );

  console.log(`Stream connected (id: ${stream.id}). Press Ctrl+C to stop.\n`);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    stream.cancel();
    process.exit(0);
  });
}

main()
  .finally(() => closeMongoClient())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
