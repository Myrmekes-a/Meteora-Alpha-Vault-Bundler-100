export type QuoteMintType = "WSOL" | "USDC";

export interface DistributionWallet {
  publicKey: string;
  secretKeyBase58: string;
  amountRaw: string;
}

export interface LaunchState {
  phase:
    | "initial"
    | "token-minted"
    | "pool-created"
    | "vault-created"
    | "funds-distributed"
    | "deposited"
    | "filled"
    | "launched"
    | "claimed"
    | "distributed"
    | "activated";
  updatedAt: string;
  tokenMint: string;
  poolAddress: string;
  alphaVaultAddress: string;
  quoteMintType: QuoteMintType;
  quoteMint: string;
  poolActivationPointTs: string;
  depositingPoint: string;
  startVestingPoint: string;
  endVestingPoint: string;
  maxDepositingCap: string;
  distributionWallets: DistributionWallet[];
  totalDistributedRaw: string;
  depositsByWallet: Record<string, string>;
  fillTxSignature: string | null;
  claimsByWallet: Record<string, string>;
  tokenMintOutputPath: string;
  poolOutputPath: string;
  alphaVaultOutputPath: string;
}
