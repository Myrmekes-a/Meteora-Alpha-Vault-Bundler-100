import "dotenv/config";

import { run } from "../lib/spawn";
import { getEnvOrDefault } from "../lib/utils";
import { getArtifactByKey } from "../lib/store/mongo-store";
import { saveLaunchState } from "../lib/launch-state";
import { closeMongoClient } from "../lib/store/mongo";
import { getLaunchStateByKey } from "../lib/store/mongo-store";

async function savePoolCreatedState(statePath: string, poolPath: string, tokenMintPath: string): Promise<void> {
  const pool = await getArtifactByKey<{
    poolAddress: string;
    baseMint: string;
    quoteMint: string;
    quoteMintType: "WSOL" | "USDC";
    poolActivationPointTs: string;
  }>("pool-output", poolPath);
  if (!pool) throw new Error("Pool output artifact not found after launch");

  const token = await getArtifactByKey<{ tokenMint: string }>("token-mint-output", tokenMintPath);
  if (!token) throw new Error("Token mint output artifact not found after launch");

  const existing = (await getLaunchStateByKey(statePath)) ?? {};
  await saveLaunchState(statePath, {
    phase: "pool-created",
    updatedAt: new Date().toISOString(),
    tokenMint: token.tokenMint,
    poolAddress: pool.poolAddress,
    quoteMintType: pool.quoteMintType,
    quoteMint: pool.quoteMint,
    poolActivationPointTs: pool.poolActivationPointTs,
    alphaVaultAddress: (existing as { alphaVaultAddress?: string }).alphaVaultAddress ?? "",
    depositingPoint: (existing as { depositingPoint?: string }).depositingPoint ?? "",
    startVestingPoint: (existing as { startVestingPoint?: string }).startVestingPoint ?? "",
    endVestingPoint: (existing as { endVestingPoint?: string }).endVestingPoint ?? "",
    maxDepositingCap: (existing as { maxDepositingCap?: string }).maxDepositingCap ?? "",
    distributionWallets: (existing as { distributionWallets?: [] }).distributionWallets ?? [],
    totalDistributedRaw: (existing as { totalDistributedRaw?: string }).totalDistributedRaw ?? "0",
    depositsByWallet: (existing as { depositsByWallet?: Record<string, string> }).depositsByWallet ?? {},
    fillTxSignature: (existing as { fillTxSignature?: null }).fillTxSignature ?? null,
    claimsByWallet: (existing as { claimsByWallet?: Record<string, string> }).claimsByWallet ?? {},
    tokenMintOutputPath: tokenMintPath,
    poolOutputPath: poolPath,
    alphaVaultOutputPath:
      (existing as { alphaVaultOutputPath?: string }).alphaVaultOutputPath ?? getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", "data/latest-alpha-vault.json"),
  });
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN?.toLowerCase() === "true";
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", "data/latest-launch-state.json");
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", "data/latest-pool.json");
  const avPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", "data/latest-alpha-vault.json");
  const tokenMintPath = getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", "data/latest-token-mint.json");

  console.log("Step 1: Creating pool (launch:dammv2)...");
  try {
    await run("npx tsx src/launch/damm-v2-launch.ts");
  } catch (err) {
    // Allow resume mode: if pool output already exists from a previous successful run,
    // continue to alpha-vault creation instead of hard-failing at pool step.
    const existingPool = await getArtifactByKey<{ poolAddress?: string }>("pool-output", poolPath);
    if (!existingPool?.poolAddress) {
      throw err;
    }
    console.log(
      `Pool launch step returned an error, but existing pool output found (${existingPool.poolAddress}). Continuing...`
    );
  }
  await savePoolCreatedState(statePath, poolPath, tokenMintPath);

  if (dryRun) {
    console.log("DRY_RUN=true: skipping Alpha Vault creation. Run create:alpha-vault:fcfs manually after a real launch.");
    return;
  }

  console.log("\nStep 2: Creating Alpha Vault (create:alpha-vault:fcfs)...");
  await run("npx tsx src/launch/alpha-vault-fcfs.ts");

  console.log("\nStep 3: Saving launch state...");

  const pool = await getArtifactByKey<{
    poolAddress: string;
    baseMint: string;
    quoteMint: string;
    quoteMintType: "WSOL" | "USDC";
    poolActivationPointTs: string;
  }>("pool-output", poolPath);
  if (!pool) throw new Error("Pool output artifact not found after launch");

  const av = await getArtifactByKey<{
    alphaVaultAddress: string;
    depositingPoint: string;
    startVestingPoint: string;
    endVestingPoint: string;
    maxDepositingCap: string;
  }>("alpha-vault-output", avPath);
  if (!av) throw new Error("Alpha vault output artifact not found after launch");

  const token = await getArtifactByKey<{ tokenMint: string }>("token-mint-output", tokenMintPath);
  if (!token) throw new Error("Token mint output artifact not found after launch");

  const existing = (await getLaunchStateByKey(statePath)) ?? {};

  await saveLaunchState(statePath, {
    phase: "vault-created",
    updatedAt: new Date().toISOString(),
    tokenMint: token.tokenMint,
    poolAddress: pool.poolAddress,
    alphaVaultAddress: av.alphaVaultAddress,
    quoteMintType: pool.quoteMintType,
    quoteMint: pool.quoteMint,
    poolActivationPointTs: pool.poolActivationPointTs,
    depositingPoint: av.depositingPoint,
    startVestingPoint: av.startVestingPoint,
    endVestingPoint: av.endVestingPoint,
    maxDepositingCap: av.maxDepositingCap,
    distributionWallets: (existing as { distributionWallets?: [] }).distributionWallets ?? [],
    totalDistributedRaw: (existing as { totalDistributedRaw?: string }).totalDistributedRaw ?? "0",
    depositsByWallet: (existing as { depositsByWallet?: Record<string, string> }).depositsByWallet ?? {},
    fillTxSignature: (existing as { fillTxSignature?: null }).fillTxSignature ?? null,
    claimsByWallet: (existing as { claimsByWallet?: Record<string, string> }).claimsByWallet ?? {},
    tokenMintOutputPath: tokenMintPath,
    poolOutputPath: poolPath,
    alphaVaultOutputPath: avPath,
  });

  console.log(`\nDone. Pool: ${pool.poolAddress}`);
  console.log(`Alpha Vault: ${av.alphaVaultAddress}`);
  console.log("Launch state saved with phase: vault-created");
  console.log("Next: distribute funds and deposit within the deposit window.");
}

main()
  .finally(() => closeMongoClient())
  .catch((err: unknown) => {
    console.error("Launch failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
