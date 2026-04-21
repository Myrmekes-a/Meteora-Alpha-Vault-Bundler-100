import "dotenv/config";

import type { LaunchState } from "../lib/types";
import { getEnvOrDefault } from "../lib/utils";
import { createLaunchStateIfMissing, getArtifactByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

async function main(): Promise<void> {
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", "data/latest-pool.json");
  const alphaVaultPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", "data/latest-alpha-vault.json");
  const tokenMintPath = getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", "data/latest-token-mint.json");

  const pool = await getArtifactByKey<{
    poolAddress: string;
    baseMint: string;
    quoteMint: string;
    quoteMintType: "WSOL" | "USDC";
    poolActivationPointTs: string;
  }>("pool-output", poolPath);
  if (!pool) throw new Error(`Pool output not found for key: ${poolPath}`);

  const av = await getArtifactByKey<{
    alphaVaultAddress: string;
    depositingPoint: string;
    startVestingPoint: string;
    endVestingPoint: string;
    maxDepositingCap: string;
  }>("alpha-vault-output", alphaVaultPath);
  if (!av) throw new Error(`Alpha vault output not found for key: ${alphaVaultPath}`);

  const token = await getArtifactByKey<{ tokenMint: string }>("token-mint-output", tokenMintPath);
  if (!token) throw new Error(`Token mint output not found for key: ${tokenMintPath}`);

  const state: LaunchState = {
    phase: "initial",
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
    distributionWallets: [],
    totalDistributedRaw: "0",
    depositsByWallet: {},
    fillTxSignature: null,
    claimsByWallet: {},
    tokenMintOutputPath: tokenMintPath,
    poolOutputPath: poolPath,
    alphaVaultOutputPath: alphaVaultPath,
  };

  const created = await createLaunchStateIfMissing(statePath, state);
  if (!created) {
    console.log("Launch state already exists:", statePath);
    return;
  }
  console.log("Launch state initialized:", statePath);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
