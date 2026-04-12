import "dotenv/config";

import { Connection, clusterApiUrl } from "@solana/web3.js";
import { getEnvOrDefault, sleep } from "../lib/utils";
import { getChainTime } from "../lib/chain";
import { run } from "../lib/spawn";
import { loadLaunchState } from "../lib/launch-state";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

async function waitForDepositWindow(connection: Connection, depositingPoint: number): Promise<void> {
  const bufferSec = 3;
  const target = depositingPoint + bufferSec;
  let chainTime = await getChainTime(connection);
  if (chainTime >= target) return;

  const waitSec = target - chainTime;
  const startIso = new Date(depositingPoint * 1000).toISOString();
  console.log(`Deposit window opens at ${startIso} (+${bufferSec}s buffer)`);
  console.log(`Waiting ${waitSec}s (~${Math.ceil(waitSec / 60)} min)...`);
  while (chainTime < target) {
    const chunk = Math.min(10, target - chainTime);
    await sleep(chunk * 1000);
    chainTime = await getChainTime(connection);
    const left = Math.max(0, target - chainTime);
    if (left > 0) {
      console.log(`  ... ${left}s (~${Math.ceil(left / 60)} min) left`);
    }
  }
  console.log("Deposit window open.");
}

async function main(): Promise<void> {
  console.log("Step 1: Distributing funds to wallets...");
  await run("npx tsx src/commands/distribute-funds.ts");

  const skipWait = process.env.SKIP_DEPOSIT_WAIT === "true";
  if (!skipWait) {
    const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
    try {
      const state = await loadLaunchState(statePath);
      const depositingPoint = Number(state.depositingPoint);
      if (depositingPoint && !Number.isNaN(depositingPoint)) {
        const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
        const connection = new Connection(rpc, "confirmed");
        await waitForDepositWindow(connection, depositingPoint);
      }
    } catch {
      console.log("(No launch state yet; deposit will run without wait. Run init/launch first for wait logic.)");
    }
  }

  console.log("\nStep 2: Depositing to Alpha Vault...");
  await run("npx tsx src/commands/deposit-to-vault.ts");

  console.log("\nDone. Funds distributed and deposited to Alpha Vault.");
}

main()
  .finally(() => closeMongoClient())
  .catch((err: unknown) => {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
