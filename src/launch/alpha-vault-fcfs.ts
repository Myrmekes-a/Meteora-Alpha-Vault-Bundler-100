import "dotenv/config";

import BN from "bn.js";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey, clusterApiUrl, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import AlphaVault, {
  PoolType,
  PROGRAM_ID,
  WhitelistMode,
  createCpAmmProgram,
  deriveAlphaVault,
} from "@meteora-ag/alpha-vault";
import { ActivationType, getCurrentPoint } from "@meteora-ag/cp-amm-sdk";
import {
  DEVNET_USDC_MINT,
  MAINNET_USDC_MINT,
  DEPOSIT_END_TO_ACTIVATION_SEC,
  DEPOSIT_OPEN_BUFFER_SEC,
  CLAIM_LOCK_AFTER_ACTIVATION_SEC,
} from "../lib/constants";
import { getRequiredEnv, getEnvOrDefault, parseWalletSecret, inferCluster } from "../lib/utils";
import { getArtifactByKey, saveArtifactByKey } from "../lib/store/mongo-store";
import { closeMongoClient } from "../lib/store/mongo";

type QuoteMintType = "WSOL" | "USDC";
type ClusterType = "devnet" | "mainnet-beta";
type WhitelistModeName =
  | "permissionless"
  | "permission_with_merkle_proof"
  | "permission_with_authority"
  | "whitelist";

const DEFAULT_TOKEN_MINT_OUTPUT_PATH = "data/latest-token-mint.json";
const DEFAULT_POOL_OUTPUT_PATH = "data/latest-pool.json";
const DEFAULT_ALPHA_VAULT_OUTPUT_PATH = "data/latest-alpha-vault.json";
/** Min time depositingPoint must be in the future. Meteora requires ~10 min (6021). Override via ALPHA_FCFS_DEPOSIT_OPEN_BUFFER_SEC. */
const DEFAULT_MIN_DEPOSIT_FUTURE_SEC = DEPOSIT_OPEN_BUFFER_SEC;

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === "true";
}

function parseWhitelistMode(value: string): WhitelistMode {
  const normalized = value.toLowerCase() as WhitelistModeName;
  if (normalized === "whitelist") return WhitelistMode.PermissionWithAuthority;
  if (normalized === "permission_with_merkle_proof") return WhitelistMode.PermissionWithMerkleProof;
  if (normalized === "permission_with_authority") return WhitelistMode.PermissionWithAuthority;
  return WhitelistMode.Permissionless;
}

function getQuoteMint(cluster: ClusterType, quoteMintType: QuoteMintType): PublicKey {
  if (quoteMintType === "WSOL") return NATIVE_MINT;
  return cluster === "mainnet-beta" ? MAINNET_USDC_MINT : DEVNET_USDC_MINT;
}

async function getTokenMintFromOutputFile(pathValue: string): Promise<PublicKey> {
  const parsed = await getArtifactByKey<{ tokenMint?: string }>("token-mint-output", pathValue);
  if (!parsed) throw new Error(`token mint output not found for key: ${pathValue}`);
  if (!parsed.tokenMint) throw new Error(`tokenMint missing in output for key: ${pathValue}`);
  return new PublicKey(parsed.tokenMint);
}

async function getPoolAddressFromOutputFile(pathValue: string): Promise<PublicKey> {
  const parsed = await getArtifactByKey<{ poolAddress?: string }>("pool-output", pathValue);
  if (!parsed) throw new Error(`pool output not found for key: ${pathValue}`);
  if (!parsed.poolAddress) throw new Error(`poolAddress missing in output for key: ${pathValue}`);
  return new PublicKey(parsed.poolAddress);
}

async function getPoolTimingFromOutputFile(pathValue: string): Promise<{ poolActivationPointTs: BN | null }> {
  const parsed = await getArtifactByKey<{ poolActivationPointTs?: string | null }>("pool-output", pathValue);
  if (!parsed) return { poolActivationPointTs: null };
  if (!parsed.poolActivationPointTs) return { poolActivationPointTs: null };
  return { poolActivationPointTs: new BN(parsed.poolActivationPointTs, 10) };
}

async function writeAlphaVaultOutput(params: {
  outputPath: string;
  alphaVaultAddress: PublicKey;
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  quoteMintType: QuoteMintType;
  depositingPoint: string;
  startVestingPoint: string;
  endVestingPoint: string;
  maxDepositingCap: string;
  individualDepositingCap: string;
  whitelistMode: string;
  txSignature: string | null;
  dryRun: boolean;
}): Promise<void> {
  await saveArtifactByKey("alpha-vault-output", params.outputPath, {
    alphaVaultAddress: params.alphaVaultAddress.toBase58(),
    poolAddress: params.poolAddress.toBase58(),
    baseMint: params.baseMint.toBase58(),
    quoteMint: params.quoteMint.toBase58(),
    quoteMintType: params.quoteMintType,
    depositingPoint: params.depositingPoint,
    startVestingPoint: params.startVestingPoint,
    endVestingPoint: params.endVestingPoint,
    maxDepositingCap: params.maxDepositingCap,
    individualDepositingCap: params.individualDepositingCap,
    whitelistMode: params.whitelistMode,
    txSignature: params.txSignature,
    dryRun: params.dryRun,
    createdAt: new Date().toISOString(),
  });
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL?.trim() || clusterApiUrl("devnet");
  const cluster = (process.env.CLUSTER?.trim() as ClusterType | undefined) || inferCluster(rpcUrl);
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));

  const quoteMintType = (getEnvOrDefault("QUOTE_MINT_TYPE", "WSOL").toUpperCase() as QuoteMintType);
  if (!["WSOL", "USDC"].includes(quoteMintType)) throw new Error("QUOTE_MINT_TYPE must be WSOL or USDC");

  const tokenMintOutputPath =
    process.env.TOKEN_MINT_OUTPUT_PATH?.trim() || DEFAULT_TOKEN_MINT_OUTPUT_PATH;
  const poolOutputPath = process.env.POOL_OUTPUT_PATH?.trim() || DEFAULT_POOL_OUTPUT_PATH;
  const alphaVaultOutputPath =
    process.env.ALPHA_VAULT_OUTPUT_PATH?.trim() || DEFAULT_ALPHA_VAULT_OUTPUT_PATH;

  const baseMint = await getTokenMintFromOutputFile(tokenMintOutputPath);
  const quoteMint = getQuoteMint(cluster, quoteMintType);
  const poolAddress = process.env.POOL_ADDRESS?.trim()
    ? new PublicKey(process.env.POOL_ADDRESS.trim())
    : await getPoolAddressFromOutputFile(poolOutputPath);
  const { poolActivationPointTs: poolActivationFromFile } = await getPoolTimingFromOutputFile(poolOutputPath);

  const connection = new Connection(rpcUrl, "confirmed");
  const alphaVaultProgramId = new PublicKey(PROGRAM_ID[cluster]);
  const [alphaVaultAddress] = deriveAlphaVault(wallet.publicKey, poolAddress, alphaVaultProgramId);

  const minDepositFutureSec = Number(
    getEnvOrDefault("ALPHA_FCFS_DEPOSIT_OPEN_BUFFER_SEC", String(DEFAULT_MIN_DEPOSIT_FUTURE_SEC))
  );

  // Use chain clock and on-chain pool state for time points (avoids mainnet validation failures from clock skew)
  let poolActivationPointTs: BN | null = poolActivationFromFile;
  let activationType: typeof ActivationType.Timestamp | typeof ActivationType.Slot = ActivationType.Timestamp;
  try {
    const cpAmm = createCpAmmProgram(connection, { cluster });
    const pool = await cpAmm.account.pool.fetch(poolAddress);
    poolActivationPointTs = pool.activationPoint;
    activationType = pool.activationType as typeof ActivationType.Timestamp | typeof ActivationType.Slot;
  } catch (e) {
    console.warn("Could not fetch pool from chain, using pool output file for activation:", e instanceof Error ? e.message : e);
  }

  let chainNow: number;
  try {
    const chainNowBn = await getCurrentPoint(connection, activationType);
    chainNow = chainNowBn.toNumber();
  } catch (e) {
    console.warn("Could not fetch chain time, using system time:", e instanceof Error ? e.message : e);
    chainNow = Math.floor(Date.now() / 1000);
  }
  const activation = poolActivationPointTs ? Number(poolActivationPointTs.toString()) : null;

  /** Meteora: activation-depositingPoint >= 65 min. Min ~15 min buffer (shorter fails 6021). */
  const METEORA_MIN_DEPOSIT_FUTURE_SEC = 900;
  const effectiveBufferSec = Math.max(minDepositFutureSec, METEORA_MIN_DEPOSIT_FUTURE_SEC);

  const defaultDepositingPoint = (() => {
    if (!activation) return chainNow + effectiveBufferSec;
    const latestSafeDepositEnd = activation - DEPOSIT_END_TO_ACTIVATION_SEC;
    const candidate = Math.min(
      chainNow + effectiveBufferSec,
      latestSafeDepositEnd - 60
    );
    return candidate;
  })();
  const depositingPointFutureSec = defaultDepositingPoint - chainNow;
  if (depositingPointFutureSec < effectiveBufferSec && activation) {
    console.warn(
      `depositingPoint is ${Math.floor(depositingPointFutureSec / 60)} min in future. ` +
        `Meteora requires activation-depositingPoint >= 65 min.`
    );
  }
  if (activation && defaultDepositingPoint <= chainNow) {
    throw new Error(
      "Pool activation is too close/past for FCFS depositing window. Recreate pool with later activation point."
    );
  }
  const depositingWindowSec = activation ? activation - DEPOSIT_END_TO_ACTIVATION_SEC - chainNow : 0;
  if (activation && depositingWindowSec < 60) {
    throw new Error(
      `Pool activation too close: only ${Math.floor(depositingWindowSec / 60)} min left for deposit window. ` +
        `Use POOL_ACTIVATION_POINT_TS=4800 (80 min) for this timeline.`
    );
  }
  /** Claim available N min after pool activation (lock duration). Override via ALPHA_FCFS_CLAIM_LOCK_AFTER_ACTIVATION_SEC */
  const claimLockSec = Number(
    getEnvOrDefault("ALPHA_FCFS_CLAIM_LOCK_AFTER_ACTIVATION_SEC", String(CLAIM_LOCK_AFTER_ACTIVATION_SEC))
  );
  const defaultStartVestingPoint = activation
    ? activation + claimLockSec
    : chainNow + 90 * 60;
  /** No vesting: claim all at once when lock ends */
  const defaultEndVestingPoint = defaultStartVestingPoint;

  const depositingPoint = new BN(
    getEnvOrDefault("ALPHA_FCFS_DEPOSITING_POINT", String(defaultDepositingPoint)),
    10
  );
  console.log("🚀 ~ main ~ depositingPoint:", depositingPoint.toNumber())
  const startVestingPoint = new BN(
    getEnvOrDefault("ALPHA_FCFS_START_VESTING_POINT", String(defaultStartVestingPoint)),
    10
  );
  console.log("🚀 ~ main ~ startVestingPoint:", startVestingPoint.toNumber())
  const endVestingPoint = new BN(
    getEnvOrDefault("ALPHA_FCFS_END_VESTING_POINT", String(defaultEndVestingPoint)),
    10
  );
  console.log("🚀 ~ main ~ endVestingPoint:", endVestingPoint.toNumber())
  const maxDepositingCap = new BN(getRequiredEnv("ALPHA_FCFS_MAX_DEPOSITING_CAP_RAW"), 10);
  const individualDepositingCap = new BN(
    getEnvOrDefault("ALPHA_FCFS_INDIVIDUAL_CAP_RAW", maxDepositingCap.toString()),
    10
  );
  const escrowFee = new BN(getEnvOrDefault("ALPHA_FCFS_ESCROW_FEE_RAW", "0"), 10);
  const whitelistModeRaw = getEnvOrDefault("ALPHA_FCFS_WHITELIST_MODE", "permissionless");
  const whitelistMode = parseWhitelistMode(whitelistModeRaw);
  const dryRun = parseBool(process.env.DRY_RUN, true);

  const existing = await connection.getAccountInfo(alphaVaultAddress);
  if (existing) {
    console.log(`Alpha Vault already exists: ${alphaVaultAddress.toBase58()}`);
    await writeAlphaVaultOutput({
      outputPath: alphaVaultOutputPath,
      alphaVaultAddress,
      poolAddress,
      baseMint,
      quoteMint,
      quoteMintType,
      depositingPoint: depositingPoint.toString(),
      startVestingPoint: startVestingPoint.toString(),
      endVestingPoint: endVestingPoint.toString(),
      maxDepositingCap: maxDepositingCap.toString(),
      individualDepositingCap: individualDepositingCap.toString(),
      whitelistMode: whitelistModeRaw,
      txSignature: null,
      dryRun,
    });
    console.log(`Saved: ${resolve(alphaVaultOutputPath)}`);
    return;
  }

  const tx = await AlphaVault.createCustomizableFcfsVault(
    connection,
    {
      quoteMint,
      baseMint,
      poolAddress,
      poolType: PoolType.DAMMV2,
      depositingPoint,
      startVestingPoint,
      endVestingPoint,
      maxDepositingCap,
      individualDepositingCap,
      escrowFee,
      whitelistMode,
    },
    wallet.publicKey,
    { cluster }
  );

  console.log("Prepared FCFS Alpha Vault creation transaction");
  console.log(`Chain now: ${chainNow}, depositingPoint: ${depositingPoint.toString()}, pool activation: ${activation ?? "n/a"}`);
  console.log(`Alpha Vault (derived): ${alphaVaultAddress.toBase58()}`);
  console.log(`Pool address: ${poolAddress.toBase58()}`);
  console.log(`Base mint: ${baseMint.toBase58()}`);
  console.log(`Quote mint (${quoteMintType}): ${quoteMint.toBase58()}`);
  console.log(`Dry run: ${dryRun}`);

  if (dryRun) {
    await writeAlphaVaultOutput({
      outputPath: alphaVaultOutputPath,
      alphaVaultAddress,
      poolAddress,
      baseMint,
      quoteMint,
      quoteMintType,
      depositingPoint: depositingPoint.toString(),
      startVestingPoint: startVestingPoint.toString(),
      endVestingPoint: endVestingPoint.toString(),
      maxDepositingCap: maxDepositingCap.toString(),
      individualDepositingCap: individualDepositingCap.toString(),
      whitelistMode: whitelistModeRaw,
      txSignature: null,
      dryRun,
    });
    console.log("DRY_RUN=true so transaction is not sent.");
    console.log(`Saved: ${resolve(alphaVaultOutputPath)}`);
    return;
  }

  const skipPreflight = parseBool(process.env.SKIP_PREFLIGHT, false);
  if (skipPreflight) {
    console.log("SKIP_PREFLIGHT=true: skipping simulation (may succeed if simulation timing is strict).");
  }
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: "confirmed",
    skipPreflight,
  });

  await writeAlphaVaultOutput({
    outputPath: alphaVaultOutputPath,
    alphaVaultAddress,
    poolAddress,
    baseMint,
    quoteMint,
    quoteMintType,
    depositingPoint: depositingPoint.toString(),
    startVestingPoint: startVestingPoint.toString(),
    endVestingPoint: endVestingPoint.toString(),
    maxDepositingCap: maxDepositingCap.toString(),
    individualDepositingCap: individualDepositingCap.toString(),
    whitelistMode: whitelistModeRaw,
    txSignature: signature,
    dryRun,
  });

  console.log(`Alpha Vault tx: ${signature}`);
  console.log(`Explorer: https://solscan.io/tx/${signature}${cluster === "devnet" ? "?cluster=devnet" : ""}`);
  console.log(`Saved: ${resolve(alphaVaultOutputPath)}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Alpha Vault FCFS creation failed: ${message}`);
    if (message.includes("0x1785") || message.includes("6021")) {
      console.error(
        "Hint: 6021 = depositingTimePointIsInvalid. Ensure depositingPoint is in the future (chain time) and pool activation - depositingPoint >= ~65 min."
      );
    }
    process.exit(1);
  });