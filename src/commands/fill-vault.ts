import "dotenv/config";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import AlphaVault, {
  ALPHA_VAULT_TREASURY_ID,
  PoolType,
  VaultMode,
  deriveCrankFeeWhitelist,
  getOrCreateATAInstruction,
} from "@meteora-ag/alpha-vault";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  DEPOSIT_END_TO_ACTIVATION_SEC,
  FILL_BUFFER_SEC_BEFORE_ACTIVATION,
} from "../lib/constants";
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret, inferCluster, sleep } from "../lib/utils";
import { getChainTime } from "../lib/chain";
import { loadLaunchState, saveLaunchState } from "../lib/launch-state";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

/** Build DAMM v2 fill tx (SDK fillVault has empty branch for DAMMV2). Uses totalDeposit for FCFS. */
async function buildDammV2FillTx(
  alphaVault: InstanceType<typeof AlphaVault>,
  payer: PublicKey
): Promise<Transaction> {
  const { program, pubkey: vaultKey, vault } = alphaVault;
  const connection = program.provider.connection;
  const cpAmm = new CpAmm(connection);
  const pool = await cpAmm._program.account.pool.fetch(vault.pool);
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    cpAmm._program.programId
  );
  const [dammEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    cpAmm._program.programId
  );
  const [crankFeeWhitelist] = deriveCrankFeeWhitelist(payer, program.programId);
  const crankFeeWhitelistAccount = await connection.getAccountInfo(crankFeeWhitelist);
  const preInstructions: Parameters<Transaction["add"]>[0][] = [];
  const { ataPubKey: tokenOutVault, ix: createTokenOutVaultIx } = await getOrCreateATAInstruction(
    connection,
    vault.baseMint,
    vaultKey,
    payer,
    pool.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
  );
  if (createTokenOutVaultIx) preInstructions.push(createTokenOutVaultIx);
  const fillAmount =
    vault.vaultMode === VaultMode.FCFS || vault.maxBuyingCap.isZero()
      ? vault.totalDeposit
      : vault.totalDeposit.lt(vault.maxBuyingCap)
        ? vault.totalDeposit
        : vault.maxBuyingCap;
  const fillDammInstruction = await program.methods.fillDammV2(fillAmount).accountsPartial({
    vault: vaultKey,
    tokenVault: vault.tokenVault,
    tokenOutVault,
    ammProgram: cpAmm._program.programId,
    pool: vault.pool,
    poolAuthority,
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    tokenAProgram: pool.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
    tokenBProgram: pool.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
    cranker: payer,
    crankFeeReceiver: crankFeeWhitelistAccount ? program.programId : ALPHA_VAULT_TREASURY_ID,
    crankFeeWhitelist: crankFeeWhitelistAccount ? crankFeeWhitelist : program.programId,
    dammEventAuthority,
    systemProgram: SystemProgram.programId,
  }).instruction();
  const { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ lastValidBlockHeight, blockhash });
  tx.add(...preInstructions, fillDammInstruction);
  return tx;
}

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
  const cluster = inferCluster(rpc);
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);

  const connection = new Connection(rpc, "confirmed");
  const state = await loadLaunchState(statePath);

  if (state.fillTxSignature) {
    // Self-heal legacy state where signature exists but phase was not persisted as filled.
    if (state.phase !== "filled" && state.phase !== "launched" && state.phase !== "activated" && state.phase !== "claimed") {
      state.phase = "filled";
      await saveLaunchState(statePath, state);
      console.log("Fill signature already exists; phase corrected to filled.");
    }
    console.log("Fill already executed.", state.fillTxSignature);
    return;
  }

  const poolActivationTs = Number(state.poolActivationPointTs);
  const lastJoinPoint = poolActivationTs - DEPOSIT_END_TO_ACTIVATION_SEC;
  const fillBufferSec = Number(
    getEnvOrDefault("FILL_BUFFER_SEC_BEFORE_ACTIVATION", String(FILL_BUFFER_SEC_BEFORE_ACTIVATION))
  );
  const fillWindowStart = Math.max(lastJoinPoint + 1, poolActivationTs - fillBufferSec);

  let chainTime = await getChainTime(connection);
  if (chainTime < fillWindowStart) {
    const waitSec = fillWindowStart - chainTime;
    const skipWait = process.env.SKIP_FILL_WAIT === "true";
    if (skipWait) {
      console.log(
        `Fill window not yet open. Fill allowed from chain ${fillWindowStart} (${fillBufferSec}s before activation).`
      );
      console.log(`${waitSec}s (~${Math.ceil(waitSec / 60)} min) remaining. Re-run later or set SKIP_FILL_WAIT=false to wait.`);
      return;
    }
    console.log(
      `Fill window not yet open. Deposit ends at ${new Date(lastJoinPoint * 1000).toISOString()}. Fill allowed from chain time ${fillWindowStart} (${fillBufferSec}s before activation).`
    );
    console.log(`Waiting until chain_time >= ${fillWindowStart} (${waitSec}s ~${Math.ceil(waitSec / 60)} min)...`);
    let remaining = waitSec;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 10);
      await sleep(chunk * 1000);
      chainTime = await getChainTime(connection);
      remaining = Math.max(0, fillWindowStart - chainTime);
      if (remaining > 0) {
        console.log(`  ... ${remaining}s (~${Math.ceil(remaining / 60)} min) left`);
      }
    }
    console.log("Fill window open. Checking vault balance...");
  }

  let alphaVault;
  try {
    alphaVault = await AlphaVault.create(
      connection,
      new PublicKey(state.alphaVaultAddress),
      { cluster }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("null") || msg.includes("not found") || msg.includes("Cannot read")) {
      throw new Error(
        `Alpha Vault not found at ${state.alphaVaultAddress}. Run create:alpha-vault:fcfs first to create the vault. ` + msg
      );
    }
    throw e;
  }

  let vaultQuoteBalance = 0n;
  try {
    const tokenAccount = await getAccount(connection, alphaVault.vault.tokenVault);
    vaultQuoteBalance = tokenAccount.amount;
  } catch {
    /* token_vault not initialized */
  }
  if (vaultQuoteBalance === 0n) {
    console.error(
      "Vault has no deposits (token_vault not initialized or empty). Run deposit:to-vault during the deposit window first."
    );
    process.exit(1);
  }
  console.log(`Vault quote balance: ${vaultQuoteBalance} (ready to fill)`);

  const simulateOnly = process.env.SIMULATE_ONLY === "true";
  const sendFill = process.env.SEND_FILL === "true";
  const fillWindowEnd = poolActivationTs;

  if (simulateOnly) {
    const chainTime = await getChainTime(connection);
    const inWindow = chainTime >= fillWindowStart && chainTime < poolActivationTs;
    console.log(`Chain time: ${chainTime}, fill window: ${fillWindowStart}–${poolActivationTs}`);
    console.log(`In fill window: ${inWindow}`);
    if (!inWindow && chainTime < fillWindowStart) {
      console.log(`Fill window opens in ~${Math.ceil((fillWindowStart - chainTime) / 60)} min`);
    }

    let fillTx = await alphaVault.fillVault(wallet.publicKey);
    if (!fillTx && alphaVault.vault.poolType === PoolType.DAMMV2) {
      fillTx = await buildDammV2FillTx(alphaVault, wallet.publicKey);
    }
    if (!fillTx) {
      console.error("Fill returned null.");
      process.exit(1);
    }
    fillTx.feePayer = wallet.publicKey;
    fillTx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    fillTx.sign(wallet);

    const sim = await connection.simulateTransaction(fillTx);
    console.log("\n--- Simulation result ---");
    if (sim.value.err) {
      console.log("Simulation failed (expected if not in fill window):", sim.value.err);
      if (sim.value.logs?.length) console.log("Logs:\n", sim.value.logs.join("\n"));
    } else {
      console.log("Simulation OK — tx would succeed.");
    }

    if (sendFill && inWindow) {
      console.log("\nSending fill transaction...");
      const sig = await sendAndConfirmTransaction(connection, fillTx, [wallet], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      state.phase = "filled";
      state.fillTxSignature = sig;
      await saveLaunchState(statePath, state);
      console.log("Fill success:", sig);
    } else if (sendFill && !inWindow) {
      console.log("\nSEND_FILL=true but not in fill window. Skipping send.");
    } else {
      console.log("\nDry run. Set SEND_FILL=true to send when in window.");
    }
    return;
  }

  let sig: string | null = null;

  while (true) {
    chainTime = await getChainTime(connection);
    if (chainTime > fillWindowEnd) {
      console.error("Fill window closed (pool activation passed). Fill failed.");
      process.exit(1);
    }
    if (chainTime < fillWindowStart) {
      await sleep(1000);
      continue;
    }

    let fillTx = await alphaVault.fillVault(wallet.publicKey);
    if (!fillTx && alphaVault.vault.poolType === PoolType.DAMMV2) {
      fillTx = await buildDammV2FillTx(alphaVault, wallet.publicKey);
    }
    if (!fillTx) {
      console.log("Fill returned null (e.g. no liquidity or unsupported pool). Retrying...");
      await sleep(1000);
      continue;
    }

    try {
      console.log("Sending fill transaction (fresh blockhash)...");
      sig = await sendAndConfirmTransaction(connection, fillTx, [wallet], {
        commitment: "confirmed",
        skipPreflight: false,
      });
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isExpired = msg.includes("TransactionExpiredBlockheightExceeded") || msg.includes("block height exceeded");
      const isRetriable = isExpired || msg.includes("simulation failed") || msg.includes("Timeout");
      if (isRetriable && chainTime < fillWindowEnd - 5) {
        console.log(`Fill failed (${isExpired ? "blockhash expired" : "retriable"}), retrying...`);
        await sleep(2000);
      } else {
        throw err;
      }
    }
  }

  if (!sig) throw new Error("Fill did not produce signature");

  state.phase = "filled";
  state.fillTxSignature = sig;
  await saveLaunchState(statePath, state);

  console.log("");
  console.log("=== Fill successful ===");
  console.log("Tx signature:", sig);
  console.log("Explorer:", `https://solscan.io/tx/${sig}`);
  console.log(`Pool will activate at ${new Date(poolActivationTs * 1000).toISOString()}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
