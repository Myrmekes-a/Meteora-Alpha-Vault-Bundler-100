import "dotenv/config";

import { spawn } from "node:child_process";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { DistributionWallet } from "../lib/types";
import { getEnvOrDefault } from "../lib/utils";
import { getArtifactByKey, getDistributionWalletsByKey, getLaunchStateByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";
const DEFAULT_DISTRIBUTION_KEYSTORE_PATH = "data/distribution-wallets.keystore.json";

async function getPoolAddress(): Promise<string> {
  const poolOverride = process.env.POOL_ADDRESS?.trim() || process.env.TARGET_POOL_ADDRESS?.trim();
  const launchPath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH);

  if (poolOverride) return poolOverride;
  const state = await getLaunchStateByKey(launchPath);
  if (state?.poolAddress) return state.poolAddress;
  const pool = await getArtifactByKey<{ poolAddress?: string }>("pool-output", poolPath);
  if (pool?.poolAddress) return pool.poolAddress;
  throw new Error("Pool address not found; set POOL_ADDRESS or ensure launch state/pool output exists.");
}

async function loadDistributionWallets(): Promise<DistributionWallet[]> {
  const launchPath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const keystorePath = getEnvOrDefault(
    "DISTRIBUTION_WALLETS_KEYSTORE_PATH",
    DEFAULT_DISTRIBUTION_KEYSTORE_PATH
  );
  const state = await getLaunchStateByKey(launchPath);
  if (state?.distributionWallets?.length) return state.distributionWallets;
  const fromArtifact = await getDistributionWalletsByKey(keystorePath);
  return fromArtifact ?? [];
}

function runSellForWallet(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/commands/sell-pool-token.ts"], {
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: false,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sell-pool-token.ts exited ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpc, "confirmed");
  const poolAddress = await getPoolAddress();
  const wallets = await loadDistributionWallets();
  const delayMs = Math.max(0, Number(process.env.SELL_ALL_DELAY_MS?.trim() || "750"));

  if (wallets.length === 0) {
    throw new Error("No distribution wallets found to sell from.");
  }

  const cpAmmModule = await import("@meteora-ag/cp-amm-sdk");
  const cpAmm = new cpAmmModule.CpAmm(connection);
  const poolState = await cpAmm._program.account.pool.fetch(new PublicKey(poolAddress));
  const tokenAMint = poolState.tokenAMint;
  const tokenAProgram = poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  console.log(`Selling token balances from ${wallets.length} distribution wallets...`);
  console.log(`Pool: ${poolAddress}`);
  console.log(`Token A mint: ${tokenAMint.toBase58()}`);

  let soldWallets = 0;
  let skippedWallets = 0;
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i]!;
    const owner = new PublicKey(wallet.publicKey);
    const ata = getAssociatedTokenAddressSync(tokenAMint, owner, false, tokenAProgram, undefined);
    let rawAmount = "0";
    try {
      const bal = await connection.getTokenAccountBalance(ata, "confirmed");
      rawAmount = bal.value.amount ?? "0";
    } catch {
      rawAmount = "0";
    }
    if (BigInt(rawAmount) <= 0n) {
      skippedWallets += 1;
      console.log(`[${i + 1}/${wallets.length}] skip ${wallet.publicKey} (no token balance)`);
      continue;
    }

    console.log(`[${i + 1}/${wallets.length}] selling ${rawAmount} raw from ${wallet.publicKey}...`);
    try {
      await runSellForWallet({
        POOL_ADDRESS: poolAddress,
        WALLET_SECRET_KEY: wallet.secretKeyBase58,
        SELL_AMOUNT_RAW: rawAmount,
      });
      soldWallets += 1;
    } catch (e) {
      console.error(`[${i + 1}/${wallets.length}] failed ${wallet.publicKey}:`, e);
    }

    if (delayMs > 0 && i < wallets.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log(`Done. Sold wallets: ${soldWallets}, skipped: ${skippedWallets}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

