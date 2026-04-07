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
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret, inferCluster, sleep } from "../lib/utils";
import { getChainTime } from "../lib/chain";
import { loadOrCreateLaunchState, saveLaunchState } from "../lib/launch-state";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
  const cluster = inferCluster(rpc);
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));
  const amountRaw = new BN(getRequiredEnv("DEPOSIT_AMOUNT_RAW"), 10);
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", "data/latest-pool.json");
  const alphaVaultPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", "data/latest-alpha-vault.json");
  const tokenMintPath = getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", "data/latest-token-mint.json");

  const connection = new Connection(rpc, "confirmed");

  const state = await loadOrCreateLaunchState(statePath, poolPath, alphaVaultPath, tokenMintPath);
  const alphaVaultAddress = new PublicKey(state.alphaVaultAddress);
  const depositingPoint = Number(state.depositingPoint);
  const poolActivationPointTs = state.poolActivationPointTs;
  const depositsByWallet = { ...state.depositsByWallet };

  if (depositsByWallet[wallet.publicKey.toBase58()]) {
    console.log("Already deposited. Skipping.");
    return;
  }

  const alphaVault = await AlphaVault.create(connection, alphaVaultAddress, { cluster });

  const lastJoinPoint = Number(poolActivationPointTs) - DEPOSIT_END_TO_ACTIVATION_SEC;
  const bufferSec = 3;
  const target = depositingPoint + bufferSec;

  let chainTime = await getChainTime(connection);
  if (chainTime < target) {
    const waitSec = target - chainTime;
    console.log(`Deposit window opens at ${new Date(depositingPoint * 1000).toISOString()}`);
    console.log(`Waiting ${waitSec}s (~${Math.ceil(waitSec / 60)} min)...`);
    while (chainTime < target) {
      await sleep(Math.min(10, target - chainTime) * 1000);
      chainTime = await getChainTime(connection);
    }
    console.log("Deposit window open.");
  }

  if (chainTime > lastJoinPoint) {
    console.log("Deposit period has ended. Skipping.");
    return;
  }

  const depositTx = await alphaVault.deposit(amountRaw, wallet.publicKey);
  const sig = await sendAndConfirmTransaction(connection, depositTx, [wallet], {
    commitment: "confirmed",
    skipPreflight: false,
  });

  depositsByWallet[wallet.publicKey.toBase58()] = amountRaw.toString();
  state.depositsByWallet = depositsByWallet;
  state.distributionWallets = [
    { publicKey: wallet.publicKey.toBase58(), secretKeyBase58: bs58.encode(wallet.secretKey), amountRaw: amountRaw.toString() },
  ];
  state.phase = "deposited";
  await saveLaunchState(statePath, state);

  console.log(`Deposited ${amountRaw.toString()} (tx: ${sig})`);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
