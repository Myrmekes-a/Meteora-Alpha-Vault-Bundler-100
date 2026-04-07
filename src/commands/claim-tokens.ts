import "dotenv/config";

import BN from "bn.js";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import AlphaVault from "@meteora-ag/alpha-vault";
import { getEnvOrDefault, inferCluster } from "../lib/utils";
import { loadLaunchState, saveLaunchState } from "../lib/launch-state";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
  const cluster = inferCluster(rpc);
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);

  const connection = new Connection(rpc, "confirmed");
  const state = await loadLaunchState(statePath);

  const startVestingPoint = Number(state.startVestingPoint);
  const now = Math.floor(Date.now() / 1000);

  if (now < startVestingPoint) {
    console.log(`Claim not yet available. Lock-up ends at ${new Date(startVestingPoint * 1000).toISOString()}`);
    return;
  }

  let alphaVault;
  try {
    alphaVault = await AlphaVault.create(
      connection,
      new PublicKey(state.alphaVaultAddress),
      { cluster }
    );
  } catch (e) {
    throw new Error(
      `Alpha Vault not found at ${state.alphaVaultAddress}. ` +
        (e instanceof Error ? e.message : String(e))
    );
  }

  const claimsByWallet = { ...state.claimsByWallet };

  for (const w of state.distributionWallets) {
    const kp = Keypair.fromSecretKey(bs58.decode(w.secretKeyBase58));

    const escrow = await alphaVault.getEscrow(kp.publicKey);
    const claimInfo = alphaVault.getClaimInfo(escrow);

    const claimable = claimInfo.totalClaimable;
    if (claimable.isZero()) {
      const prev = claimsByWallet[w.publicKey];
      if (prev) {
        console.log(`Wallet ${w.publicKey} already claimed (${prev}).`);
      } else {
        console.log(`Wallet ${w.publicKey} has nothing to claim.`);
      }
      continue;
    }

    const claimTx = await alphaVault.claimToken(kp.publicKey);
    const sig = await sendAndConfirmTransaction(connection, claimTx, [kp], {
      commitment: "confirmed",
      skipPreflight: false,
    });

    const prevClaimed = claimsByWallet[w.publicKey] ? new BN(claimsByWallet[w.publicKey]) : new BN(0);
    claimsByWallet[w.publicKey] = prevClaimed.add(claimable).toString();
    console.log(`Claimed ${claimable.toString()} for ${w.publicKey} (tx: ${sig})`);
  }

  const allClaimed = state.distributionWallets.every((w) => {
    const prev = claimsByWallet[w.publicKey];
    return prev && new BN(prev).gt(new BN(0));
  });

  state.claimsByWallet = claimsByWallet;
  if (allClaimed) state.phase = "claimed";
  await saveLaunchState(statePath, state);

  console.log("Claims processed.");
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
