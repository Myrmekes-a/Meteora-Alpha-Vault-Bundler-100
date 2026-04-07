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
import { DEPOSIT_END_TO_ACTIVATION_SEC } from "../lib/constants";
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

  if (state.distributionWallets.length === 0) {
    throw new Error("No distribution wallets. Run distribute:funds first.");
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
      `Alpha Vault not found at ${state.alphaVaultAddress}. Ensure pool and alpha vault exist on ${cluster}. ` +
        (e instanceof Error ? e.message : String(e))
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const depositingPoint = Number(state.depositingPoint);
  const poolActivation = Number(state.poolActivationPointTs);
  console.log("🚀 ~ main ~ depositingPoint:", depositingPoint)
  const difference = poolActivation - depositingPoint;
  console.log("🚀 ~ main ~ difference =================================>:", difference)
  if (now < depositingPoint) {
    console.log(`Deposit period not yet open. Starts at ${new Date(depositingPoint * 1000).toISOString()}`);
    return;
  }

  const lastJoinPoint = poolActivation - DEPOSIT_END_TO_ACTIVATION_SEC;
  if (now > lastJoinPoint) {
    console.log("Deposit period has ended. Skipping deposits.");
    return;
  }

  const depositsByWallet = { ...state.depositsByWallet };

  for (const w of state.distributionWallets) {
    if (depositsByWallet[w.publicKey]) {
      console.log(`Wallet ${w.publicKey} already deposited. Skipping.`);
      continue;
    }

    const amount = new BN(w.amountRaw);
    if (amount.isZero()) {
      depositsByWallet[w.publicKey] = "0";
      continue;
    }

    const kp = Keypair.fromSecretKey(bs58.decode(w.secretKeyBase58));
    const depositTx = await alphaVault.deposit(amount, kp.publicKey);

    const sig = await sendAndConfirmTransaction(connection, depositTx, [kp], {
      commitment: "confirmed",
      skipPreflight: false,
    });
    depositsByWallet[w.publicKey] = amount.toString();
    console.log(`Deposited ${amount.toString()} to vault from ${w.publicKey} (tx: ${sig})`);
  }

  state.phase = "deposited";
  state.depositsByWallet = depositsByWallet;
  await saveLaunchState(statePath, state);

  console.log("Deposits complete.");
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
