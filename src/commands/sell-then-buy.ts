import "dotenv/config";

import BN from "bn.js";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CpAmm, SwapMode, getTokenDecimals, getCurrentPoint } from "@meteora-ag/cp-amm-sdk";
import { spawn } from "node:child_process";
import { getEnvOrDefault, getRequiredEnv, parseWalletSecret } from "../lib/utils";

const DEFAULT_POOL = "87v9gJ4X8P7TmvkhEYTqAQN1QxkvUA6o5YTWnUQnjF5d";

function runScript(script: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", script], { env: { ...process.env, ...env }, stdio: "inherit", shell: false });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}

function splitAmount(total: BN, parts: number): BN[] {
  if (parts <= 1) return [total];
  const chunk = total.divn(parts);
  const out: BN[] = [];
  let acc = new BN(0);
  for (let i = 0; i < parts; i++) {
    const isLast = i === parts - 1;
    const amt = isLast ? total.sub(acc) : chunk;
    out.push(amt);
    acc = acc.add(amt);
  }
  return out.filter((x) => x.gt(new BN(0)));
}

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("mainnet-beta"));
  const connection = new Connection(rpc, "confirmed");
  const wallet = Keypair.fromSecretKey(parseWalletSecret(getRequiredEnv("WALLET_SECRET_KEY")));
  const dryRun = process.env.DRY_RUN?.toLowerCase() !== "false";

  const sellPct = Math.max(0, Math.min(100, Number(process.env.SELL_PERCENTAGE?.trim() || "70")));
  const buyPct = Math.max(0, Math.min(100, Number(process.env.BUY_PERCENTAGE?.trim() || "5")));
  const sellTxCount = Math.max(1, Number(process.env.REPLICATOR_SELL_TXS?.trim() || "1"));
  const buyTxCount = Math.max(1, Number(process.env.REPLICATOR_BUY_TXS?.trim() || "1"));

  const poolAddr = process.env.POOL_ADDRESS?.trim() || process.env.TARGET_POOL_ADDRESS?.trim() || DEFAULT_POOL;
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm._program.account.pool.fetch(new PublicKey(poolAddr));
  const tokenAMint = poolState.tokenAMint;
  const tokenBMint = poolState.tokenBMint;
  const tokenAProgram = poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenBProgram = poolState.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const ata = getAssociatedTokenAddressSync(tokenAMint, wallet.publicKey, false, tokenAProgram, undefined);
  const balance = await connection.getTokenAccountBalance(ata);
  const balanceRaw = new BN(balance.value.amount, 10);
  const sellAmountRaw = balanceRaw.muln(sellPct).divn(100);

  if (sellAmountRaw.lte(new BN(0))) {
    console.error("No token balance to sell.");
    process.exit(1);
  }

  const [tokenADecimals, tokenBDecimals, currentPoint] = await Promise.all([
    getTokenDecimals(connection, tokenAMint, tokenAProgram),
    getTokenDecimals(connection, tokenBMint, tokenBProgram),
    getCurrentPoint(connection, poolState.activationType),
  ]);

  const slippageBps = Number(process.env.SLIPPAGE_BPS?.trim() || "100");
  const slippage = slippageBps / 10_000;

  const sellQuote = cpAmm.getQuote2({
    inputTokenMint: tokenAMint,
    slippage,
    currentPoint,
    poolState,
    tokenADecimal: tokenADecimals,
    tokenBDecimal: tokenBDecimals,
    hasReferral: false,
    swapMode: SwapMode.ExactIn,
    amountIn: sellAmountRaw,
  });

  const expectedWsolOut = sellQuote.minimumAmountOut ?? new BN(0);
  const buyAmountWsol = expectedWsolOut.muln(buyPct).divn(100);

  console.log(`Pool: ${poolAddr}`);
  console.log(`Sell ${sellPct}% of Token A: ${sellAmountRaw.toString()} raw`);
  console.log(`Expected wSOL out (min): ${expectedWsolOut.toString()}`);
  console.log(`Buy ${buyPct}% of that wSOL: ${buyAmountWsol.toString()} raw`);
  console.log(`Sell tx count: ${sellTxCount} | Buy tx count: ${buyTxCount}`);
  console.log(`Dry run: ${dryRun}\n`);

  const baseEnv = {
    POOL_ADDRESS: poolAddr,
    DRY_RUN: dryRun ? "true" : "",
  };

  const sellChunks = splitAmount(sellAmountRaw, sellTxCount);
  for (const chunk of sellChunks) {
    await runScript("src/commands/sell-pool-token.ts", {
      ...baseEnv,
      SELL_AMOUNT_RAW: chunk.toString(),
    });
  }

  if (buyAmountWsol.lte(new BN(0))) {
    console.log("Buy amount is 0, skipping buy.");
    return;
  }

  const buyChunks = splitAmount(buyAmountWsol, buyTxCount);
  for (const chunk of buyChunks) {
    await runScript("src/commands/buy-pool-token.ts", {
      ...baseEnv,
      BUY_AMOUNT_RAW: chunk.toString(),
    });
  }

  console.log("Sell-then-buy done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
