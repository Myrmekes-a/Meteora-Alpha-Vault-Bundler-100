import "dotenv/config";

import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CpAmm, SwapMode, getTokenDecimals, getCurrentPoint } from "@meteora-ag/cp-amm-sdk";
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret } from "../lib/utils";
import { getArtifactByKey, getLaunchStateByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";

async function getPoolAddress(): Promise<PublicKey> {
  const poolOverride = process.env.POOL_ADDRESS?.trim() || process.env.TARGET_POOL_ADDRESS?.trim();
  const launchPath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH);

  if (poolOverride) return new PublicKey(poolOverride);
  const state = await getLaunchStateByKey(launchPath);
  if (state) {
    if (!state.poolAddress) throw new Error(`Launch state missing poolAddress; set POOL_ADDRESS env`);
    return new PublicKey(state.poolAddress);
  }
  const pool = await getArtifactByKey<{ poolAddress?: string }>("pool-output", poolPath);
  if (!pool) throw new Error(`Pool output not found for key: ${poolPath}`);
  if (!pool.poolAddress) throw new Error(`Pool output missing poolAddress`);
  return new PublicKey(pool.poolAddress);
}

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));
  const dryRun = process.env.DRY_RUN?.toLowerCase() === "true";

  const amountRaw = process.env.BUY_AMOUNT_RAW?.trim();
  if (!amountRaw) throw new Error("Set BUY_AMOUNT_RAW (raw wSOL/lamports to spend)");

  const amountIn = new BN(amountRaw, 10);
  if (amountIn.lte(new BN(0))) throw new Error("BUY_AMOUNT_RAW must be > 0");

  const slippageBps = Number(process.env.SLIPPAGE_BPS?.trim() || "100");
  const slippage = slippageBps / 10_000;

  const connection = new Connection(rpc, "confirmed");
  const poolAddress = await getPoolAddress();

  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm._program.account.pool.fetch(poolAddress);
  const tokenAMint = poolState.tokenAMint;
  const tokenBMint = poolState.tokenBMint;

  const tokenAProgram = poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenBProgram = poolState.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const [tokenADecimals, tokenBDecimals, currentPoint] = await Promise.all([
    getTokenDecimals(connection, tokenAMint, tokenAProgram),
    getTokenDecimals(connection, tokenBMint, tokenBProgram),
    getCurrentPoint(connection, poolState.activationType),
  ]);

  const quote = cpAmm.getQuote2({
    inputTokenMint: tokenBMint,
    slippage,
    currentPoint,
    poolState,
    tokenADecimal: tokenADecimals,
    tokenBDecimal: tokenBDecimals,
    hasReferral: false,
    swapMode: SwapMode.ExactIn,
    amountIn,
  });

  const minimumAmountOut = quote.minimumAmountOut ?? new BN(0);
  console.log("=== Meteora DAMM v2 Buy (Token B/wSOL → Token A) ===");
  console.log(`Pool: ${poolAddress.toBase58()}`);
  console.log(`Spend wSOL (raw): ${amountIn.toString()}`);
  console.log(`Expected Token A out (min): ${minimumAmountOut.toString()} raw`);
  console.log(`Slippage: ${slippageBps} bps`);
  console.log(`Dry run: ${dryRun}\n`);

  const swapTx = await cpAmm.swap2({
    payer: wallet.publicKey,
    pool: poolAddress,
    inputTokenMint: tokenBMint,
    outputTokenMint: tokenAMint,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram,
    tokenBProgram,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn,
    minimumAmountOut,
  });

  if (dryRun) {
    console.log("DRY_RUN: Transaction built but not sent.");
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, swapTx, [wallet], {
    commitment: "confirmed",
    skipPreflight: false,
  });

  console.log(`Buy success: ${sig}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
