export interface LaunchState {
  phase: string;
  /** Token mint public key (field name used in DB) */
  tokenMint?: string;
  /** Alias for tokenMint, used in some UI paths */
  tokenMintAddress?: string;
  poolAddress?: string;
  alphaVaultAddress?: string;
  /** Pool activation unix timestamp (seconds) – numeric alias kept for compatibility */
  activationPoint?: number;
  /** Pool activation unix timestamp as string (seconds), from pool artifact */
  poolActivationPointTs?: string;
  /** Unix timestamp (seconds) when alpha vault deposits open */
  depositingPoint?: string;
  /** Unix timestamp (seconds) when vesting starts */
  startVestingPoint?: string;
  /** Unix timestamp (seconds) when vesting ends */
  endVestingPoint?: string;
  quoteMintType?: string;
  fillTxSignature?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface TokenMintOutput {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: string;
  metadataUri?: string;
  image?: string;
}

export interface PoolOutput {
  poolAddress: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault?: string;
  tokenBVault?: string;
}

export interface DistributionWallet {
  index: number;
  publicKey: string;
  assignedAmount?: number;
  solBalance?: number;
}

export interface PoolEvent {
  _id?: string;
  recordKey: string;
  event: {
    type?: string;
    amountA?: string | number;
    amountB?: string | number;
    timestamp?: number;
    [key: string]: unknown;
  };
  createdAt: string;
}

export interface DexScreenerPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    m5: { buys: number; sells: number };
  };
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { h24: number; h6: number; h1: number; m5: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
}

export interface PoolStats {
  priceUsd: string;
  priceNative: string;
  volume24h: number;
  marketCap: number;
  liquidity: number;
  priceChange24h: number;
  buys24h: number;
  sells24h: number;
  fdv: number;
  symbol: string;
  name: string;
  imageUrl?: string;
}

export interface EnvSettings {
  [key: string]: string;
}

export interface UiSettingsDoc {
  recordKey: string;
  values: EnvSettings;
  createdAt: string;
  updatedAt: string;
}

export interface LpFees {
  pool?: string;
  positionNftMint?: string;
  feeTokenARaw?: string;
  feeTokenBRaw?: string;
  feeTokenA?: number;
  feeTokenB?: number;
  tokenAMint?: string;
  tokenBMint?: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  error?: string;
}

export interface ActionResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  code?: number | null;
}

export const LAUNCH_PHASES = [
  "init",
  "token-minted",
  "pool-created",
  "vault-created",
  "funds-distributed",
  "deposited",
  "filled",
  "claimed",
  "launched",
] as const;

export type LaunchPhase = (typeof LAUNCH_PHASES)[number];
