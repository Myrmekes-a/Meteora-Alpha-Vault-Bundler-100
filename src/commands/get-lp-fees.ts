import "dotenv/config";

import {
  Connection,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CpAmm,
  derivePositionAddress,
  getUnClaimLpFee,
  getTokenDecimals,
} from "@meteora-ag/cp-amm-sdk";
import { getEnvOrDefault, getRequiredEnv } from "../lib/utils";
import { getArtifactByKey, getLaunchStateByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpc, "confirmed");
  const cpAmm = new CpAmm(connection);

  const poolOverride = process.env.POOL_ADDRESS?.trim();
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", DEFAULT_POOL_OUTPUT_PATH);
  const launchPath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);

  let poolAddress: PublicKey | null = null;
  const poolArtifact = await getArtifactByKey<{ poolAddress?: string; positionNftMint?: string }>(
    "pool-output",
    poolPath
  );

  if (poolOverride) {
    poolAddress = new PublicKey(poolOverride);
  } else if (poolArtifact?.poolAddress) {
    poolAddress = new PublicKey(poolArtifact.poolAddress);
  } else {
    const state = await getLaunchStateByKey(launchPath);
    if (state?.poolAddress) poolAddress = new PublicKey(state.poolAddress);
  }

  if (!poolAddress) {
    process.stdout.write(JSON.stringify({ error: "Pool address not found" }));
    return;
  }

  const nftMintStr = process.env.POSITION_NFT_MINT?.trim() ?? poolArtifact?.positionNftMint;
  if (!nftMintStr) {
    process.stdout.write(JSON.stringify({ error: "positionNftMint not found in pool artifact" }));
    return;
  }

  const positionNftMint = new PublicKey(nftMintStr);
  const position = derivePositionAddress(positionNftMint);

  const [poolState, positionState] = await Promise.all([
    cpAmm._program.account.pool.fetch(poolAddress),
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

  process.stdout.write(
    JSON.stringify({
      pool: poolAddress.toBase58(),
      positionNftMint: positionNftMint.toBase58(),
      position: position.toBase58(),
      feeTokenARaw: feeTokenA.toString(),
      feeTokenBRaw: feeTokenB.toString(),
      feeTokenA: feeAHuman,
      feeTokenB: feeBHuman,
      tokenAMint: tokenAMint.toBase58(),
      tokenBMint: tokenBMint.toBase58(),
      tokenADecimals,
      tokenBDecimals,
    })
  );
}

main()
  .finally(() => closeMongoClient())
  .catch((err: unknown) => {
    process.stdout.write(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
    );
    process.exit(1);
  });
