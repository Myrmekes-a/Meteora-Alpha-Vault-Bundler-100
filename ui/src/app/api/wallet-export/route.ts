import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { getMongoDb } from "@/lib/mongo";

type BundlerWallet = {
  index: number;
  publicKey: string;
  secretKeyBase58: string;
  amountRaw?: string;
};

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  const marker = path.join("src", "commands", "token-mint.ts");
  if (fs.existsSync(path.join(cwd, marker))) return cwd;
  const parent = path.resolve(cwd, "..");
  if (fs.existsSync(path.join(parent, marker))) return parent;
  return cwd;
}

function readEnv(projectRoot: string): Record<string, string> {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath, "utf8"));
}

function parseWalletSecret(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Uint8Array.from(arr);
  }
  return bs58.decode(trimmed);
}

function getMainWallet(env: Record<string, string>): { publicKey: string; privateKey: string } | null {
  const secret = env.WALLET_SECRET_KEY?.trim();
  if (!secret) return null;
  try {
    const kp = Keypair.fromSecretKey(parseWalletSecret(secret));
    return { publicKey: kp.publicKey.toBase58(), privateKey: secret };
  } catch {
    return null;
  }
}

function escapeCsv(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

function toSol(raw?: string): string {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n)) return "";
  return (n / 1_000_000_000).toString();
}

function findLatestDistributionKeystore(projectRoot: string): string | null {
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  const stack = [projectRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (e.isFile() && e.name === "distribution-wallets.keystore.json") {
        try {
          const st = fs.statSync(abs);
          candidates.push({ file: abs, mtimeMs: st.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].file;
}

function loadBundlersFromLocal(projectRoot: string): BundlerWallet[] {
  const file = findLatestDistributionKeystore(projectRoot);
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Array<{
      publicKey?: string;
      secretKeyBase58?: string;
      amountRaw?: string;
    }>;
    return parsed
      .filter((w) => typeof w.publicKey === "string" && typeof w.secretKeyBase58 === "string")
      .map((w, i) => ({
        index: i + 1,
        publicKey: w.publicKey as string,
        secretKeyBase58: w.secretKeyBase58 as string,
        amountRaw: w.amountRaw,
      }));
  } catch {
    return [];
  }
}

async function loadBundlersFromMongo(): Promise<BundlerWallet[]> {
  try {
    const db = await getMongoDb();
    const doc = await db
      .collection("artifacts")
      .findOne({ kind: "distribution-wallets" }, { sort: { updatedAt: -1 } });
    const payload = (doc?.payload as { wallets?: unknown } | undefined)?.wallets;
    if (!Array.isArray(payload)) return [];
    const rows: BundlerWallet[] = [];
    for (let i = 0; i < payload.length; i += 1) {
      const w = payload[i];
      if (!w || typeof w !== "object") continue;
      const raw = w as Record<string, unknown>;
      if (typeof raw.publicKey !== "string" || typeof raw.secretKeyBase58 !== "string") continue;
      rows.push({
        index: typeof raw.index === "number" ? raw.index : i + 1,
        publicKey: raw.publicKey,
        secretKeyBase58: raw.secretKeyBase58,
        amountRaw: typeof raw.amountRaw === "string" ? raw.amountRaw : undefined,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export async function GET() {
  const projectRoot = resolveProjectRoot();
  const env = readEnv(projectRoot);
  const main = getMainWallet(env);
  const mongoBundlers = await loadBundlersFromMongo();
  const bundlers = mongoBundlers.length > 0 ? mongoBundlers : loadBundlersFromLocal(projectRoot);

  const lines: string[] = [];
  lines.push([
    "wallet_type",
    "index",
    "public_key",
    "private_key",
    "assigned_amount_raw",
    "assigned_amount_sol",
  ].join(","));

  if (main) {
    lines.push([
      escapeCsv("main"),
      "",
      escapeCsv(main.publicKey),
      escapeCsv(main.privateKey),
      "",
      "",
    ].join(","));
  }

  for (const w of bundlers) {
    lines.push([
      escapeCsv("bundler"),
      escapeCsv(w.index),
      escapeCsv(w.publicKey),
      escapeCsv(w.secretKeyBase58),
      escapeCsv(w.amountRaw ?? ""),
      escapeCsv(toSol(w.amountRaw)),
    ].join(","));
  }

  const csv = lines.join("\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=\"wallets-${stamp}.csv\"`,
      "Cache-Control": "no-store",
    },
  });
}

