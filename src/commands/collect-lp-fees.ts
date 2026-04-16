import "dotenv/config";

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CpAmm,
  derivePositionAddress,
  derivePositionNftAccount,
  getUnClaimLpFee,
  getTokenDecimals,
} from "@meteora-ag/cp-amm-sdk";
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret } from "../lib/utils";
import { getArtifactByKey, getLaunchStateByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";

async function resolvePoolAndNft(): Promise<{ pool: PublicKey; positionNftMint: PublicKey }> {
  const poolOverride = process.env.POOL_ADDRESS?.trim() || process.env.TARGET_POOL_ADDRESS?.trim();
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH);
  const launchPath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);

  let poolAddress: PublicKey | null = null;
  let positionNftMintStr: string | null = null;

  if (poolOverride) {
    poolAddress = new PublicKey(poolOverride);
  }

  const poolArtifact = await getArtifactByKey<{ poolAddress?: string; positionNftMint?: string }>(
    "pool-output",
    poolPath
  );

  if (!poolAddress) {
    if (poolArtifact?.poolAddress) {
      poolAddress = new PublicKey(poolArtifact.poolAddress);
    } else {
      const state = await getLaunchStateByKey(launchPath);
      if (state?.poolAddress) {
        poolAddress = new PublicKey(state.poolAddress);
      }
    }
  }

  if (!poolAddress) throw new Error("Cannot resolve pool address. Set POOL_ADDRESS env.");

  positionNftMintStr = poolArtifact?.positionNftMint ?? null;
  if (!positionNftMintStr) {
    throw new Error(
      "positionNftMint not found in pool output artifact.\n" +
        "Re-run `npm run launch:dammv2` to save the positionNftMint, or set POSITION_NFT_MINT env."
    );
  }

  const nftMintOverride = process.env.POSITION_NFT_MINT?.trim();
  const positionNftMint = new PublicKey(nftMintOverride ?? positionNftMintStr);
  return { pool: poolAddress, positionNftMint };
}

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));
  const dryRun = process.env.DRY_RUN?.toLowerCase() === "true";

  const connection = new Connection(rpc, "confirmed");
  const cpAmm = new CpAmm(connection);

  const { pool, positionNftMint } = await resolvePoolAndNft();
  const position = derivePositionAddress(positionNftMint);
  const positionNftAccount = derivePositionNftAccount(positionNftMint);

  console.log("=== Collect LP Fees (DAMM v2) ===");
  console.log(`Pool:              ${pool.toBase58()}`);
  console.log(`Position NFT Mint: ${positionNftMint.toBase58()}`);
  console.log(`Position:          ${position.toBase58()}`);
  console.log(`Owner (wallet):    ${wallet.publicKey.toBase58()}`);

  const [poolState, positionState] = await Promise.all([
    cpAmm._program.account.pool.fetch(pool),
    cpAmm.fetchPositionState(position),
  ]);

  const tokenAMint: PublicKey = poolState.tokenAMint;
  const tokenBMint: PublicKey = poolState.tokenBMint;
  const tokenAProgram = poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenBProgram = poolState.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const [tokenADecimals, tokenBDecimals] = await Promise.all([
    getTokenDecimals(connection, tokenAMint, tokenAProgram),
    getTokenDecimals(connection, tokenBMint, tokenBProgram),
  ]);

  const { feeTokenA, feeTokenB } = getUnClaimLpFee(poolState, positionState);

  const feeAHuman = Number(feeTokenA.toString()) / 10 ** tokenADecimals;
  const feeBHuman = Number(feeTokenB.toString()) / 10 ** tokenBDecimals;

  console.log(`\nPending LP Fees:`);
  console.log(`  Token A (${tokenAMint.toBase58().slice(0, 8)}…): ${feeAHuman.toFixed(tokenADecimals)} (raw: ${feeTokenA.toString()})`);
  console.log(`  Token B (${tokenBMint.toBase58().slice(0, 8)}…): ${feeBHuman.toFixed(tokenBDecimals)} (raw: ${feeTokenB.toString()})`);

  if (feeTokenA.isZero() && feeTokenB.isZero()) {
    console.log("\nNo pending fees to collect. Exiting.");
    return;
  }

  if (dryRun) {
    console.log("\nDRY_RUN=true — transaction not sent.");
    return;
  }

  const tx = await cpAmm.claimPositionFee2({
    owner: wallet.publicKey,
    position,
    pool,
    positionNftAccount,
    tokenAMint,
    tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram,
    tokenBProgram,
    receiver: wallet.publicKey,
  });

  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: "confirmed",
    skipPreflight: false,
  });

  console.log(`\nLP fees collected successfully!`);
  console.log(`Signature: ${sig}`);
  console.log(`Explorer:  https://solscan.io/tx/${sig}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((err: unknown) => {
    console.error("collect-lp-fees failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
