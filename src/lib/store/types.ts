import type { DistributionWallet, LaunchState } from "../types";

export type ArtifactKind =
  | "token-mint-output"
  | "pool-output"
  | "alpha-vault-output"
  | "distribution-wallets"
  | "middle-wallets";

export interface LaunchStateDoc extends LaunchState {
  recordKey: string;
  createdAt: string;
}

export interface ArtifactDoc<T = Record<string, unknown>> {
  kind: ArtifactKind;
  recordKey: string;
  payload: T;
  createdAt: string;
  updatedAt: string;
}

export interface PoolEventDoc {
  recordKey: string;
  event: Record<string, unknown>;
  createdAt: string;
}

export type DistributionWalletsPayload = DistributionWallet[];
