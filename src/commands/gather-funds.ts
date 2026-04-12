import "dotenv/config";

import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { DistributionWallet } from "../lib/types";
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret } from "../lib/utils";
import { getArtifactByKey } from "../lib/store/mongo-store";
import { loadLaunchState } from "../lib/launch-state";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";
const DEFAULT_DISTRIBUTION_KEYSTORE_PATH = "data/distribution-wallets.keystore.json";

function toKeypair(secretKeyBase58: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
}

async function loadDistributionWallets(
  statePath: string,
  keystorePath: string
): Promise<DistributionWallet[]> {
  try {
    const state = await loadLaunchState(statePath);
    if (Array.isArray(state.distributionWallets) && state.distributionWallets.length > 0) {
      return state.distributionWallets;
    }
  } catch {
    // Ignore and fallback to artifact keystore.
  }

  const fromKeystore = await getArtifactByKey<{ wallets?: DistributionWallet[] }>(
    "distribution-wallets",
    keystorePath
  );
  if (Array.isArray(fromKeystore?.wallets)) {
    return fromKeystore.wallets;
  }
  return [];
}

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpc, "confirmed");

  const mainWallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const keystorePath = getEnvOrDefault(
    "DISTRIBUTION_WALLETS_KEYSTORE_PATH",
    DEFAULT_DISTRIBUTION_KEYSTORE_PATH
  );
  const keepLamports = Number(getEnvOrDefault("GATHER_KEEP_LAMPORTS_PER_WALLET", "0"));

  const wallets = await loadDistributionWallets(statePath, keystorePath);
  if (wallets.length === 0) {
    throw new Error(
      `No distribution wallets found in launch state (${statePath}) or keystore (${keystorePath}).`
    );
  }

  let totalGathered = 0n;
  let gatheredCount = 0;
  let skippedCount = 0;

  console.log(`Gathering SOL from ${wallets.length} distribution wallets...`);
  console.log(`Main wallet: ${mainWallet.publicKey.toBase58()}`);
  console.log(`Keep per wallet: ${keepLamports} lamports`);

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const from = toKeypair(w.secretKeyBase58);
    const fromPk = from.publicKey;

    if (!fromPk.equals(new PublicKey(w.publicKey))) {
      throw new Error(`Wallet secret/public mismatch at index ${i + 1}: ${w.publicKey}`);
    }

    const bal = await connection.getBalance(fromPk);
    const sendLamports = bal - keepLamports;
    if (sendLamports <= 0) {
      skippedCount += 1;
      continue;
    }

    const tx = new Transaction();
    tx.feePayer = mainWallet.publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: fromPk,
        toPubkey: mainWallet.publicKey,
        lamports: sendLamports,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [mainWallet, from], {
      commitment: "confirmed",
      skipPreflight: false,
    });

    totalGathered += BigInt(sendLamports);
    gatheredCount += 1;
    console.log(
      `[${i + 1}/${wallets.length}] gathered ${sendLamports} lamports from ${fromPk.toBase58()} (tx: ${sig})`
    );
  }

  console.log("Gather complete.");
  console.log(`Gathered wallets: ${gatheredCount}`);
  console.log(`Skipped wallets: ${skippedCount}`);
  console.log(`Total gathered: ${totalGathered.toString()} lamports`);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

