import type { LaunchState } from "./types";
import { getArtifactByKey, getLaunchStateByKey, upsertLaunchStateByKey } from "./store/mongo-store";

export async function loadLaunchState(statePath: string): Promise<LaunchState> {
  const state = await getLaunchStateByKey(statePath);
  if (!state) throw new Error(`Launch state not found: ${statePath}`);
  return state;
}

export async function saveLaunchState(statePath: string, state: LaunchState): Promise<void> {
  await upsertLaunchStateByKey(statePath, {
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

export async function loadOrCreateLaunchState(
  statePath: string,
  poolPath: string,
  alphaVaultPath: string,
  tokenMintPath: string
): Promise<LaunchState> {
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

  const existing: Partial<LaunchState> = (await getLaunchStateByKey(statePath)) ?? {};

  return {
    phase: existing.phase || "initial",
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
    distributionWallets: existing.distributionWallets || [],
    totalDistributedRaw: existing.totalDistributedRaw || "0",
    depositsByWallet: existing.depositsByWallet || {},
    fillTxSignature: existing.fillTxSignature ?? null,
    claimsByWallet: existing.claimsByWallet || {},
    tokenMintOutputPath: tokenMintPath,
    poolOutputPath: poolPath,
    alphaVaultOutputPath: alphaVaultPath,
  };
}
