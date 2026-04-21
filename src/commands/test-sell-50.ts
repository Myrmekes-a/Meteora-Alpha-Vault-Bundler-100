import "dotenv/config";

import BN from "bn.js";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { spawn } from "node:child_process";
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret } from "../lib/utils";

const DEFAULT_POOL = "87v9gJ4X8P7TmvkhEYTqAQN1QxkvUA6o5YTWnUQnjF5d";

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpc, "confirmed");
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));
  const dryRun = process.env.DRY_RUN?.toLowerCase() !== "false";

  const poolAddr = process.env.POOL_ADDRESS?.trim() || process.env.TARGET_POOL_ADDRESS?.trim() || DEFAULT_POOL;
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm._program.account.pool.fetch(new PublicKey(poolAddr));
  const tokenAMint = poolState.tokenAMint;
  const tokenAProgram = poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const ata = getAssociatedTokenAddressSync(
    tokenAMint,
    wallet.publicKey,
    false,
    tokenAProgram,
    undefined
  );

  const balance = await connection.getTokenAccountBalance(ata);
  const amountRaw = new BN(balance.value.amount, 10);
  const halfRaw = amountRaw.div(new BN(2));

  if (halfRaw.lte(new BN(0))) {
    console.error("No token balance to sell. Wallet has 0 tokens.");
    process.exit(1);
  }

  console.log(`Pool: ${poolAddr}`);
  console.log(`Token A mint: ${tokenAMint.toBase58()}`);
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Token A balance: ${amountRaw.toString()} raw`);
  console.log(`Selling 50%: ${halfRaw.toString()} raw`);
  console.log(`Dry run: ${dryRun}\n`);

  const env = {
    ...process.env,
    SELL_AMOUNT_RAW: halfRaw.toString(),
    POOL_ADDRESS: poolAddr,
    DRY_RUN: dryRun ? "true" : "",
  };

  return new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/commands/sell-pool-token.ts"], {
      env,
      stdio: "inherit",
      shell: true,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Sell exited with code ${code}`));
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
