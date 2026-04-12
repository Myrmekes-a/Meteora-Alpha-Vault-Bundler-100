import "dotenv/config";

import { Connection, clusterApiUrl } from "@solana/web3.js";
import { getEnvOrDefault, sleep } from "../lib/utils";
import { getChainTime } from "../lib/chain";
import { run } from "../lib/spawn";
import { loadLaunchState } from "../lib/launch-state";
import { closeMongoClient } from "../lib/store/mongo";

const DEFAULT_LAUNCH_STATE_PATH = "data/latest-launch-state.json";

async function main(): Promise<void> {
  const rpc = getEnvOrDefault("RPC_URL", clusterApiUrl("devnet"));
  const statePath = getEnvOrDefault("LAUNCH_STATE_PATH", DEFAULT_LAUNCH_STATE_PATH);
  const state = await loadLaunchState(statePath);
  const depositingPoint = Number(state.depositingPoint);
  const poolActivation = Number(state.poolActivationPointTs);

  const connection = new Connection(rpc, "confirmed");

  let chainTime = await getChainTime(connection);
  if (chainTime < depositingPoint) {
    const waitSec = depositingPoint - chainTime;
    const startIso = new Date(depositingPoint * 1000).toISOString();
    console.log(`Deposit window opens at ${startIso}`);
    console.log(`Waiting ${waitSec}s (~${Math.ceil(waitSec / 60)} min)...`);
    while (chainTime < depositingPoint) {
      const chunk = Math.min(10, depositingPoint - chainTime);
      await sleep(chunk * 1000);
      chainTime = await getChainTime(connection);
      const left = Math.max(0, depositingPoint - chainTime);
      if (left > 0) {
        console.log(`  ... ${left}s (~${Math.ceil(left / 60)} min) left`);
      }
    }
    console.log("Deposit window open.");
  }

  console.log("\nStep 1: Depositing to Alpha Vault...");
  await run("npx tsx src/commands/deposit-to-vault.ts");

  console.log("\nStep 2: Running fill:vault (will wait for fill window, then execute)...");
  await run("npx tsx src/commands/fill-vault.ts");

  console.log("\n=== All done ===");
  console.log(`Pool activates at ${new Date(poolActivation * 1000).toISOString()}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((err: unknown) => {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
