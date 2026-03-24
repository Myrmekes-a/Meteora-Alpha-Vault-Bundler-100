# Meteora-Alpha-Vault-Bundler

DAMM v2 token launch with Alpha Vault FCFS: mint → pool → alpha vault → distribute → deposit → fill → claim.

## Quick Start

```bash
npm install
cp .env.example .env
# Fill .env (WALLET_SECRET_KEY, DISTRIBUTION_*, etc.)
```

## Full Launch (One Command)

```bash
npm run run:full
```

Runs all steps and waits automatically for deposit/fill windows. Leave it running; total ~2–3h depending on `POOL_ACTIVATION_POINT_TS`.

## Full Launch Flow (Step by Step)

| Step | Command | Description |
|------|---------|-------------|
| 1 | `npm run mint:token` | Create token mint + metadata |
| 2 | `npm run launch:with-alpha-vault` | Pool + Alpha Vault in one |
| 3 | `npm run distribute:and:deposit` | Distribute → wait for deposit window → deposit |
| 4 | `npm run fill:vault` | Wait for fill window → fill (retries on blockhash expiry) |
| 5 | (automatic) | Pool activates at `POOL_ACTIVATION_POINT_TS` |
| 6 | `npm run claim:tokens` | After lock-up: each wallet claims |

### Alternative Commands

- `npm run wait:deposit:then:fill` – When funds already distributed, wait for deposit window → deposit → fill
- `npm run distribute:funds` – Distribute only (no deposit)
- `npm run deposit:to-vault` – Deposit only (run when deposit window is open)
- `npm run listen:pool` – Stream pool events via Helius LaserStream gRPC (transactions + account updates)

## .env Config

### Pool & timing

- `POOL_ACTIVATION_POINT_TS` – seconds until pool activation (10800 = 3h, mainnet-safe; 4200 = 70 min if using `launch:with-alpha-vault`)
- `CONNECT_ALPHA_VAULT_POOL` – set true to create Alpha Vault–connected pool

### Alpha Vault

- `ALPHA_FCFS_DEPOSIT_PERIOD_SEC` – deposit window (default 300)
- `ALPHA_FCFS_LOCK_UP_PERIOD_SEC` – minimum lock-up (default 86400 = 1 day)
- `ALPHA_FCFS_VESTING_PERIOD_SEC` – optional vesting; if unset, claim all at once
- `ALPHA_FCFS_MAX_DEPOSITING_CAP_RAW` – total cap (lamports/SOL or 6 decimals/USDC)

### LaserStream (listen:pool)

- `LASERSTREAM_API_KEY` – Helius API key (Developer/Business plan for devnet; Professional for mainnet)
- Pool from `TARGET_POOL_ADDRESS` (preferred), `POOL_ADDRESS`, or `LAUNCH_STATE_PATH`
- `POOL_EVENTS_OUTPUT_PATH` – JSONL file (one event per line) with swap/add/remove classification

### Distribution

- `DISTRIBUTION_WALLET_COUNT` – number of wallets to create
- `DISTRIBUTION_TOTAL_DEPOSIT_RAW` – total amount to distribute
- `DISTRIBUTION_RANDOMIZE_AMOUNTS` – randomize per-wallet amounts
- `DISTRIBUTION_WALLET_SOL_FEE_BUFFER_LAMPORTS` – SOL buffer per wallet for fees
- `MAIN_WALLET_FEE_RESERVE_LAMPORTS` – SOL to keep in main wallet

## State & Outputs

- `data/latest-token-mint.json` – token mint info
- `data/latest-pool.json` – pool address, `poolActivationPointTs`
- `data/latest-alpha-vault.json` – vault address, `depositingPoint`, `startVestingPoint`, etc.
- `data/latest-launch-state.json` – combined state for all steps
- `data/distribution-wallets.keystore.json` – generated wallets (private keys; store securely)
