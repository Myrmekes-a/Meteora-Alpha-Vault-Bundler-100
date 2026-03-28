import { PublicKey } from "@solana/web3.js";

export const DEVNET_USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const MAINNET_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** Meteora: ~65 min between deposit close and pool activation (see docs) */
export const DEPOSIT_END_TO_ACTIVATION_SEC = 3900;
/** Fill allowed this many seconds before pool activation */
export const FILL_BUFFER_SEC_BEFORE_ACTIVATION = 40;

/** Shortest working: 2h activation + 15min buffer (Meteora rejects shorter - 6021) */
export const POOL_ACTIVATION_FROM_NOW_SEC = 120 * 60;
/** Deposit opens 15 min after creation. Closes T+55min. */
export const DEPOSIT_OPEN_BUFFER_SEC = 900;
/** Claim available 30 min after pool activation (110 min total) */
export const CLAIM_LOCK_AFTER_ACTIVATION_SEC = 60 * 30;
