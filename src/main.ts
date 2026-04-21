import { run } from "./lib/spawn";

async function main(): Promise<void> {
  console.log("=== Step 1/4: Mint token ===");
  await run("npx tsx src/commands/token-mint.ts");

  console.log("\n=== Step 2/4: Create pool + Alpha Vault ===");
  await run("npx tsx src/flows/launch-with-alpha-vault.ts");

  const useSimpleDeposit = !!process.env.DEPOSIT_AMOUNT_RAW;

  if (useSimpleDeposit) {
    console.log("\n=== Step 3/4: Wait for deposit window → deposit (single wallet) ===");
    await run("npx tsx src/commands/simple-deposit.ts");
  } else {
    console.log("\n=== Step 3/4: Distribute funds → wait → deposit (multi-wallet) ===");
    await run("npx tsx src/flows/distribute-and-deposit.ts");
  }

  console.log("\n=== Step 4/4: Fill vault (crank) ===");
  await run("npx tsx src/commands/fill-vault.ts");

  console.log("\n=== Launch complete ===");
  console.log("Next: run claim:tokens after vesting period.");
}

main().catch((err: unknown) => {
  console.error("Launch failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
