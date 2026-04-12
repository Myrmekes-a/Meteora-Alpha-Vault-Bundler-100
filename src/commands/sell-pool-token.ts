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

function isExceededSlippageError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("ExceededSlippage") || text.includes("custom program error: 0x1772") || text.includes('"Custom":6002');
}

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

  const amountRaw = process.env.SELL_AMOUNT_RAW?.trim();
  if (!amountRaw) throw new Error("Set SELL_AMOUNT_RAW (raw amount of launched token to sell)");

  const amountIn = new BN(amountRaw, 10);
  if (amountIn.lte(new BN(0))) throw new Error("SELL_AMOUNT_RAW must be > 0");

  const baseSlippageBps = Number(process.env.SLIPPAGE_BPS?.trim() || "100");
  const maxRetries = Math.max(0, Number(process.env.SELL_RETRY_MAX?.trim() || "2"));
  const slippageStepBps = Math.max(25, Number(process.env.SELL_RETRY_STEP_BPS?.trim() || "100"));

  const connection = new Connection(rpc, "confirmed");
  const poolAddress = await getPoolAddress();

  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm._program.account.pool.fetch(poolAddress);
  const tokenAMint = poolState.tokenAMint;
  const tokenBMint = poolState.tokenBMint;

  console.log("=== Meteora DAMM v2 Sell (Token A → Token B) ===");
  console.log(`Pool: ${poolAddress.toBase58()}`);
  console.log(`Token A (sell): ${tokenAMint.toBase58()}`);
  console.log(`Token B (receive): ${tokenBMint.toBase58()}`);
  console.log(`Amount (raw): ${amountIn.toString()}`);
  console.log(`Slippage: ${baseSlippageBps} bps`);
  console.log(`Dry run: ${dryRun}\n`);

  const tokenAProgram = poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenBProgram = poolState.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const [tokenADecimals, tokenBDecimals, currentPoint] = await Promise.all([
    getTokenDecimals(connection, tokenAMint, tokenAProgram),
    getTokenDecimals(connection, tokenBMint, tokenBProgram),
    getCurrentPoint(connection, poolState.activationType),
  ]);

  if (dryRun) {
    const slippage = baseSlippageBps / 10_000;
    const quote = cpAmm.getQuote2({
      inputTokenMint: tokenAMint,
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
    console.log(`Expected out (min): ${minimumAmountOut.toString()} raw`);
    console.log("DRY_RUN: Transaction built but not sent.");
    return;
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const slippageBps = baseSlippageBps + attempt * slippageStepBps;
    const slippage = slippageBps / 10_000;
    const quote = cpAmm.getQuote2({
      inputTokenMint: tokenAMint,
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
    console.log(
      `Attempt ${attempt + 1}/${maxRetries + 1} | slippage=${slippageBps} bps | expected out (min): ${minimumAmountOut.toString()} raw`
    );

    const swapTx = await cpAmm.swap2({
      payer: wallet.publicKey,
      pool: poolAddress,
      inputTokenMint: tokenAMint,
      outputTokenMint: tokenBMint,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
      tokenBProgram: poolState.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
      amountIn,
      minimumAmountOut,
    });

    try {
      const sig = await sendAndConfirmTransaction(connection, swapTx, [wallet], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log(`Sell success: ${sig}`);
      return;
    } catch (error) {
      if (attempt >= maxRetries || !isExceededSlippageError(error)) {
        throw error;
      }
      console.warn(
        `Sell failed due to slippage (attempt ${attempt + 1}). Retrying with higher slippage...`
      );
    }
  }
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
