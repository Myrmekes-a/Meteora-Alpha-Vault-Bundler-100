import { NextResponse } from "next/server";
import { getMongoDb } from "@/lib/mongo";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

type WalletLike = {
  publicKey: string;
  assignedAmount?: number;
  solBalanceLamports?: number;
  tokenBalance?: number;
  tokenBalanceRaw?: string;
  index?: number;
  secretKey?: unknown;
};

function normalizeWalletArray(input: unknown): WalletLike[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((w) => w && typeof w === "object" && typeof (w as Record<string, unknown>).publicKey === "string")
    .map((w, i) => {
      const raw = w as Record<string, unknown>;
      // Backend stores amounts as `amountRaw` (string lamports); map to `assignedAmount` (number).
      const assignedAmount =
        typeof raw.assignedAmount === "number"
          ? raw.assignedAmount
          : raw.amountRaw !== undefined
            ? Number(raw.amountRaw)
            : undefined;
      return {
        index: typeof raw.index === "number" ? raw.index : i + 1,
        publicKey: raw.publicKey as string,
        assignedAmount,
        solBalanceLamports:
          typeof raw.solBalanceLamports === "number"
            ? raw.solBalanceLamports
            : typeof raw.solBalance === "number"
              ? raw.solBalance
              : undefined,
        tokenBalance: typeof raw.tokenBalance === "number" ? raw.tokenBalance : undefined,
        tokenBalanceRaw:
          typeof raw.tokenBalanceRaw === "string" ? raw.tokenBalanceRaw : undefined,
      } satisfies WalletLike;
    });
}

function getRpcUrl(values: Record<string, string>): string {
  const fromDb = values.RPC_URL?.trim();
  if (fromDb) return fromDb;
  const fromEnv = process.env.RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  const clusterRaw = (values.CLUSTER?.trim() || process.env.CLUSTER?.trim() || "devnet").toLowerCase();
  const cluster = clusterRaw === "mainnet" ? "mainnet-beta" : clusterRaw;
  return clusterApiUrl(cluster as "devnet" | "mainnet-beta" | "testnet");
}

async function getWalletTokenBalance(
  connection: Connection,
  owner: PublicKey,
  tokenMint: string
): Promise<{ tokenBalance?: number; tokenBalanceRaw?: string }> {
  let totalUi = 0;
  let totalRaw = 0n;
  const mint = tokenMint.trim();
  const scans = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  for (const scan of scans) {
    for (const acc of scan.value) {
      const info = acc.account.data.parsed?.info;
      const mintAddr = String(info?.mint ?? "");
      if (mintAddr !== mint) continue;
      const tokenAmount = info?.tokenAmount;
      const ui = Number(tokenAmount?.uiAmount ?? 0);
      if (Number.isFinite(ui)) totalUi += ui;
      const raw = String(tokenAmount?.amount ?? "0");
      try {
        totalRaw += BigInt(raw);
      } catch {
        // ignore malformed balances
      }
    }
  }
  return {
    tokenBalance: totalUi,
    tokenBalanceRaw: totalRaw.toString(),
  };
}

export async function GET() {
  try {
    const db = await getMongoDb();

    const distDoc = await db
      .collection("artifacts")
      .findOne({ kind: "distribution-wallets" }, { sort: { updatedAt: -1 } });

    const middleDoc = await db
      .collection("artifacts")
      .findOne({ kind: "middle-wallets" }, { sort: { updatedAt: -1 } });
    const [settingsDoc, launchStateDoc, tokenMintArtifactDoc] = await Promise.all([
      db.collection("settings").findOne({ recordKey: "ui-settings" }) as Promise<{ values?: Record<string, string> } | null>,
      db.collection("launch_states").findOne({}, { sort: { updatedAt: -1 } }) as Promise<{ tokenMint?: string; tokenMintAddress?: string } | null>,
      db.collection("artifacts").findOne({ kind: "token-mint-output" }, { sort: { updatedAt: -1 } }) as Promise<{ payload?: { tokenMint?: string } } | null>,
    ]);

    const values = settingsDoc?.values ?? {};
    const rpcUrl = getRpcUrl(values);
    const tokenMint =
      launchStateDoc?.tokenMint?.trim() ||
      launchStateDoc?.tokenMintAddress?.trim() ||
      tokenMintArtifactDoc?.payload?.tokenMint?.trim() ||
      "";
    const wallets = normalizeWalletArray((distDoc?.payload as { wallets?: unknown } | undefined)?.wallets);
    const middleWallets = normalizeWalletArray((middleDoc?.payload as { wallets?: unknown } | undefined)?.wallets);
    if (wallets.length === 0) return NextResponse.json({ wallets, middleWallets });

    const connection = new Connection(rpcUrl, "confirmed");
    const hydratedWallets = await Promise.all(
      wallets.map(async (w) => {
        try {
          const owner = new PublicKey(w.publicKey);
          const solBalanceLamports = await connection.getBalance(owner, "confirmed");
          const token = tokenMint
            ? await getWalletTokenBalance(connection, owner, tokenMint)
            : { tokenBalance: undefined, tokenBalanceRaw: undefined };
          return {
            ...w,
            solBalanceLamports,
            tokenBalance: token.tokenBalance,
            tokenBalanceRaw: token.tokenBalanceRaw,
          } satisfies WalletLike;
        } catch {
          return w;
        }
      })
    );

    return NextResponse.json({ wallets: hydratedWallets, middleWallets, tokenMint: tokenMint || null });
  } catch {
    return NextResponse.json({ wallets: [], middleWallets: [] }, { status: 503 });
  }
}
