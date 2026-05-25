import { NextRequest, NextResponse } from "next/server";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getMongoDb } from "@/lib/mongo";

type DistWallet = {
  publicKey: string;
  secretKeyBase58: string;
  amountRaw?: string;
};

function parseWalletSecret(raw: string): Uint8Array {
  const t = raw.trim();
  if (t.startsWith("[")) return Uint8Array.from(JSON.parse(t) as number[]);
  if (t.includes(",")) return Uint8Array.from(t.split(",").map((x) => Number(x.trim())));
  return bs58.decode(t);
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

async function ensureMainAta(
  connection: Connection,
  mainWallet: Keypair,
  tokenMint: PublicKey,
  programId: PublicKey
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(tokenMint, mainWallet.publicKey, false, programId, undefined);
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (info) return ata;
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      mainWallet.publicKey,
      ata,
      mainWallet.publicKey,
      tokenMint,
      programId
    )
  );
  tx.feePayer = mainWallet.publicKey;
  await sendAndConfirmTransaction(connection, tx, [mainWallet], {
    commitment: "confirmed",
    skipPreflight: false,
  });
  return ata;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { wallets?: string[] };
    const selected = Array.isArray(body.wallets)
      ? body.wallets.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (selected.length === 0) {
      return NextResponse.json({ success: false, error: "No wallets selected." }, { status: 400 });
    }

    const db = await getMongoDb();
    const [settingsDoc, distDoc, launchStateDoc, tokenMintDoc] = await Promise.all([
      db.collection("settings").findOne({ recordKey: "ui-settings" }) as Promise<{ values?: Record<string, string> } | null>,
      db.collection("artifacts").findOne({ kind: "distribution-wallets" }, { sort: { updatedAt: -1 } }) as Promise<{ payload?: { wallets?: DistWallet[] } } | null>,
      db.collection("launch_states").findOne({}, { sort: { updatedAt: -1 } }) as Promise<{ tokenMint?: string; tokenMintAddress?: string } | null>,
      db.collection("artifacts").findOne({ kind: "token-mint-output" }, { sort: { updatedAt: -1 } }) as Promise<{ payload?: { tokenMint?: string } } | null>,
    ]);
    const values = settingsDoc?.values ?? {};
    const mainSecret = values.WALLET_SECRET_KEY?.trim() || process.env.WALLET_SECRET_KEY?.trim();
    if (!mainSecret) {
      return NextResponse.json({ success: false, error: "WALLET_SECRET_KEY not configured." }, { status: 400 });
    }

    const wallets = distDoc?.payload?.wallets ?? [];
    const walletMap = new Map(wallets.map((w) => [w.publicKey, w]));
    const selectedWallets = selected.map((pk) => walletMap.get(pk)).filter((w): w is DistWallet => Boolean(w));
    if (selectedWallets.length === 0) {
      return NextResponse.json({ success: false, error: "Selected wallets not found in distribution wallets." }, { status: 400 });
    }

    const rpcUrl = getRpcUrl(values);
    const connection = new Connection(rpcUrl, "confirmed");
    const mainWallet = Keypair.fromSecretKey(parseWalletSecret(mainSecret));
    const tokenMintStr =
      launchStateDoc?.tokenMint?.trim() ||
      launchStateDoc?.tokenMintAddress?.trim() ||
      tokenMintDoc?.payload?.tokenMint?.trim() ||
      "";
    const keepLamports = Math.max(10_000, Number(values.GATHER_KEEP_LAMPORTS_PER_WALLET ?? process.env.GATHER_KEEP_LAMPORTS_PER_WALLET ?? "10000"));

    let mainAtaToken: PublicKey | null = null;
    let mainAtaToken2022: PublicKey | null = null;
    const tokenMint = tokenMintStr ? new PublicKey(tokenMintStr) : null;
    if (tokenMint) {
      mainAtaToken = await ensureMainAta(connection, mainWallet, tokenMint, TOKEN_PROGRAM_ID);
      mainAtaToken2022 = await ensureMainAta(connection, mainWallet, tokenMint, TOKEN_2022_PROGRAM_ID);
    }

    const details: Array<{
      wallet: string;
      tokenRawMoved: string;
      solLamportsMoved: string;
      tokenTxs: string[];
      solTx?: string;
      error?: string;
    }> = [];
    let totalTokenRaw = 0n;
    let totalSolLamports = 0n;

    for (const w of selectedWallets) {
      const row = { wallet: w.publicKey, tokenRawMoved: "0", solLamportsMoved: "0", tokenTxs: [] as string[], solTx: undefined as string | undefined, error: undefined as string | undefined };
      try {
        const from = Keypair.fromSecretKey(bs58.decode(w.secretKeyBase58));
        if (!from.publicKey.equals(new PublicKey(w.publicKey))) {
          throw new Error("Secret/public key mismatch");
        }

        if (tokenMint && mainAtaToken && mainAtaToken2022) {
          const scans = await Promise.all([
            connection.getParsedTokenAccountsByOwner(from.publicKey, { programId: TOKEN_PROGRAM_ID }),
            connection.getParsedTokenAccountsByOwner(from.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
          ]);
          for (const scan of scans) {
            for (const account of scan.value) {
              const info = account.account.data.parsed?.info;
              const mintAddr = String(info?.mint ?? "");
              if (mintAddr !== tokenMint.toBase58()) continue;
              const amountStr = String(info?.tokenAmount?.amount ?? "0");
              const amountRaw = BigInt(amountStr);
              if (amountRaw <= 0n) continue;
              const srcTokenAcc = account.pubkey;
              const is2022 = scan === scans[1];
              const dst = is2022 ? mainAtaToken2022 : mainAtaToken;
              const programId = is2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
              const tx = new Transaction().add(
                createTransferInstruction(srcTokenAcc, dst, from.publicKey, amountRaw, [], programId)
              );
              tx.feePayer = from.publicKey;
              const sig = await sendAndConfirmTransaction(connection, tx, [from], {
                commitment: "confirmed",
                skipPreflight: false,
              });
              row.tokenTxs.push(sig);
              totalTokenRaw += amountRaw;
              row.tokenRawMoved = (BigInt(row.tokenRawMoved) + amountRaw).toString();
            }
          }
        }

        const bal = await connection.getBalance(from.publicKey, "confirmed");
        const sendLamports = bal - keepLamports;
        if (sendLamports > 0) {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: from.publicKey,
              toPubkey: mainWallet.publicKey,
              lamports: sendLamports,
            })
          );
          tx.feePayer = from.publicKey;
          const sig = await sendAndConfirmTransaction(connection, tx, [from], {
            commitment: "confirmed",
            skipPreflight: false,
          });
          row.solTx = sig;
          row.solLamportsMoved = String(sendLamports);
          totalSolLamports += BigInt(sendLamports);
        }
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      details.push(row);
    }

    return NextResponse.json({
      success: true,
      selected: selectedWallets.length,
      totalTokenRaw: totalTokenRaw.toString(),
      totalSolLamports: totalSolLamports.toString(),
      details,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

