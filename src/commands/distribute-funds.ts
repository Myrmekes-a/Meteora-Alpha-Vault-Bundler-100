import "dotenv/config";

import BN from "bn.js";
import bs58 from "bs58";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { NATIVE_MINT } from "@solana/spl-token";
import type { DistributionWallet } from "../lib/types";
import { DEVNET_USDC_MINT, MAINNET_USDC_MINT } from "../lib/constants";
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret, inferCluster, sleep } from "../lib/utils";
import { loadOrCreateLaunchState, saveLaunchState } from "../lib/launch-state";
import { saveDistributionWalletsByKey, saveMiddleWalletsByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

/** Batch size for Step 2 (wrap + close). More instructions = larger tx. */
const WRAP_BATCH_SIZE = 4;

function getQuoteMint(quoteType: "WSOL" | "USDC", cluster: "devnet" | "mainnet-beta"): PublicKey {
  return quoteType === "WSOL" ? NATIVE_MINT : cluster === "mainnet-beta" ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;
}

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
  const cluster = inferCluster(rpc);
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));

  const walletCount = Number(getEnvOrDefault("DISTRIBUTION_WALLET_COUNT", "10"));
  const totalDepositRaw = new BN(getRequiredEnv("DISTRIBUTION_TOTAL_DEPOSIT_RAW"), 10);
  const randomizeAmounts = getEnvOrDefault("DISTRIBUTION_RANDOMIZE_AMOUNTS", "true").toLowerCase() === "true";
  const feeBufferLamports = Number(getEnvOrDefault("DISTRIBUTION_WALLET_SOL_FEE_BUFFER_LAMPORTS", "20000000"));
  const mainWalletReserve = Number(getEnvOrDefault("MAIN_WALLET_FEE_RESERVE_LAMPORTS", "50000000"));
  const quoteMintType = (getEnvOrDefault("QUOTE_MINT_TYPE", "WSOL").toUpperCase() || "WSOL") as "WSOL" | "USDC";
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const tokenMintPath = getEnvOrDefault("TOKEN_MINT_OUTPUT_PATH", "data/latest-token-mint.json");
  const poolPath = getEnvOrDefault("POOL_OUTPUT_PATH", "data/latest-pool.json");
  const alphaVaultPath = getEnvOrDefault("ALPHA_VAULT_OUTPUT_PATH", "data/latest-alpha-vault.json");

  const connection = new Connection(rpc, "confirmed");
  const quoteMint = getQuoteMint(quoteMintType, cluster);

  const state = await loadOrCreateLaunchState(statePath, poolPath, alphaVaultPath, tokenMintPath);

  if (state.distributionWallets.length > 0) {
    console.log("Distribution wallets already exist. Skipping.");
    return;
  }

  const amounts: BN[] = [];
  if (randomizeAmounts && walletCount > 1) {
    let remaining = totalDepositRaw.clone();
    for (let i = 0; i < walletCount - 1; i++) {
      const frac = remaining.divn(walletCount - i);
      const amt = frac.isZero() ? new BN(0) : frac.divn(2).add(frac.muln(Math.floor(Math.random() * 50)).divn(100));
      amounts.push(amt);
      remaining = remaining.sub(amt);
    }
    amounts.push(remaining);
    amounts.sort(() => Math.random() - 0.5);
  } else {
    const perWallet = totalDepositRaw.divn(walletCount);
    for (let i = 0; i < walletCount; i++) {
      amounts.push(perWallet);
    }
  }

  const totalCheck = amounts.reduce((a, b) => a.add(b), new BN(0));
  if (!totalCheck.eq(totalDepositRaw)) {
    amounts[amounts.length - 1] = amounts[amounts.length - 1].add(totalDepositRaw.sub(totalCheck));
  }

  // Destination wallets (C) - these receive SOL via middle wallets and are used for deposits
  const cWallets: DistributionWallet[] = [];
  const cKeypairs: Keypair[] = [];
  for (let i = 0; i < walletCount; i++) {
    const kp = Keypair.generate();
    cKeypairs.push(kp);
    cWallets.push({
      publicKey: kp.publicKey.toBase58(),
      secretKeyBase58: bs58.encode(kp.secretKey),
      amountRaw: amounts[i].toString(),
    });
  }

  if (quoteMintType === "WSOL") {
    // Middle-wallet distribution flow (Main -> B -> wSOL -> C)
    // Step 1: Main -> B (middle) wallets - transfer SOL
    // Step 2: B creates wSOL ATA, wraps SOL, closes wSOL to C
    const bKeypairs: Keypair[] = [];
    for (let i = 0; i < walletCount; i++) {
      bKeypairs.push(Keypair.generate());
    }

    const lamportsPerB = amounts.map((amt, i) => amt.toNumber() + feeBufferLamports);
    const totalLamportsStep1 = lamportsPerB.reduce((a, b) => a + b, 0);
    const needed = totalLamportsStep1 + mainWalletReserve;
    const balance = await connection.getBalance(wallet.publicKey);
    if (balance < needed) {
      throw new Error(
        `Insufficient SOL: need ${needed} lamports (${needed / LAMPORTS_PER_SOL} SOL), have ${balance}`
      );
    }

    // Step 1: Main -> B wallets (single tx)
    console.log("Step 1: Main -> B (middle) wallets (transfer SOL)...");
    const step1Tx = new Transaction();
    for (let i = 0; i < walletCount; i++) {
      step1Tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: bKeypairs[i].publicKey,
          lamports: lamportsPerB[i],
        })
      );
    }
    const sig1 = await sendAndConfirmTransaction(connection, step1Tx, [wallet], {
      commitment: "confirmed",
      skipPreflight: false,
    });
    console.log(`Step 1 done (tx: ${sig1})`);

    await sleep(2000);

    // Step 2: B -> wrap SOL -> close to C (batched)
    console.log("Step 2: B wallets wrap SOL and close to C (destination) wallets...");
    const numBatches = Math.ceil(walletCount / WRAP_BATCH_SIZE);
    for (let batch = 0; batch < numBatches; batch++) {
      const batchStart = batch * WRAP_BATCH_SIZE;
      const batchEnd = Math.min(batchStart + WRAP_BATCH_SIZE, walletCount);

      const batchTx = new Transaction();
      const batchSigners: Keypair[] = [wallet];

      for (let i = batchStart; i < batchEnd; i++) {
        const bWallet = bKeypairs[i];
        const cWallet = cKeypairs[i];
        const solAmount = lamportsPerB[i];
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, bWallet.publicKey);

        // 1. Create wSOL ATA for B (main pays rent)
        batchTx.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            wsolAta,
            bWallet.publicKey,
            NATIVE_MINT
          )
        );

        // 2. B transfers SOL to wSOL ATA
        batchTx.add(
          SystemProgram.transfer({
            fromPubkey: bWallet.publicKey,
            toPubkey: wsolAta,
            lamports: solAmount,
          })
        );

        // 3. Sync native SOL in ATA
        batchTx.add(createSyncNativeInstruction(wsolAta));

        // 4. Close wSOL ATA -> C receives SOL + ATA rent
        batchTx.add(
          createCloseAccountInstruction(
            wsolAta,
            cWallet.publicKey,
            bWallet.publicKey
          )
        );

        batchSigners.push(bWallet);
      }

      const sig2 = await sendAndConfirmTransaction(connection, batchTx, batchSigners, {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log(`Step 2 batch ${batch + 1}/${numBatches} done (tx: ${sig2})`);

      if (batch < numBatches - 1) {
        await sleep(2000);
      }
    }

    // Save middle wallets (B) for debugging/audit
    const middleWalletsPath = getEnvOrDefault(
      "DISTRIBUTION_MIDDLE_WALLETS_PATH",
      "data/middle-wallets.keystore.json"
    );
    try {
      await saveMiddleWalletsByKey(
        middleWalletsPath,
        bKeypairs.map((kp, i) => ({
          publicKey: kp.publicKey.toBase58(),
          secretKeyBase58: bs58.encode(kp.secretKey),
          index: i,
        }))
      );
      console.log(`Middle wallets saved: ${middleWalletsPath}`);
    } catch (e) {
      console.warn("Could not save middle wallets:", e);
    }

    console.log("Distribution complete (Main -> B -> wSOL -> C)");
  } else {
    // USDC: direct Main -> C (unchanged)
    for (let i = 0; i < cWallets.length; i++) {
      const tx = new Transaction();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(cWallets[i].publicKey),
          lamports: feeBufferLamports,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [wallet], {
        commitment: "confirmed",
        skipPreflight: false,
      });
    }

    const { address: ownerAta } = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      quoteMint,
      wallet.publicKey
    );
    const balance = await connection.getTokenAccountBalance(ownerAta);
    const balRaw = new BN(balance.value.amount);
    if (balRaw.lt(totalDepositRaw)) {
      throw new Error(`Insufficient USDC: need ${totalDepositRaw.toString()} raw, have ${balRaw.toString()}`);
    }

    for (let i = 0; i < cWallets.length; i++) {
      const destAta = getAssociatedTokenAddressSync(
        quoteMint,
        new PublicKey(cWallets[i].publicKey),
        false
      );
      const createAtaIx = createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        destAta,
        new PublicKey(cWallets[i].publicKey),
        quoteMint
      );
      const amountNum = amounts[i].toNumber();
      if (amountNum <= 0) continue;
      const ix = createTransferInstruction(ownerAta, destAta, wallet.publicKey, amountNum);
      const tx = new Transaction();
      try {
        const info = await connection.getAccountInfo(destAta);
        if (!info) tx.add(createAtaIx);
      } catch {
        tx.add(createAtaIx);
      }
      tx.add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log(`Distributed ${amounts[i].toString()} USDC raw to ${cWallets[i].publicKey} (tx: ${sig})`);
    }

    console.log("Distribution complete (USDC direct)");
  }

  state.phase = "funds-distributed";
  state.distributionWallets = cWallets;
  state.totalDistributedRaw = totalDepositRaw.toString();
  await saveLaunchState(statePath, state);

  const keystorePath = getEnvOrDefault("DISTRIBUTION_WALLETS_KEYSTORE_PATH", "data/distribution-wallets.keystore.json");
  await saveDistributionWalletsByKey(
    keystorePath,
    cWallets.map((w) => ({
      publicKey: w.publicKey,
      secretKeyBase58: w.secretKeyBase58,
      amountRaw: w.amountRaw,
    }))
  );

  console.log(`State saved: ${statePath}`);
  console.log(`Keystore saved: ${keystorePath}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
