# Meteora Alpha Vault Bundler

## Goals
- Automated token launch pipeline for Meteora DAMM v2
- Support Alpha Vault FCFS deposit mode
- Multi-wallet distribution for organic volume

## Meteora DLMM / DAMM v2 Research
- DAMM v2 uses dynamic AMM with concentrated liquidity bins
- Alpha Vault connects to pool for controlled distribution
- FCFS = First Come First Served; deposits open for fixed window
- Pool can be set to activate at a future timestamp

## Alpha Vault FCFS Parameters
- depositingPoint: unix ts when deposits open
- maxDepositingCap: total SOL/USDC capacity
- lockUpPeriod: minimum hold time before claim
- vestingPeriod: optional linear vesting after lock-up
- individualDepositingCap: per-wallet limit

## Wallet Distribution Strategy
- Generate N wallets deterministically from seed
- Fund each with SOL for transaction fees
- Distribute quote tokens proportionally
- Optional randomization to avoid bot detection
- Gather back remaining SOL after operations

## Token Launch Flow
1. Mint SPL token with Metaplex metadata
2. Create DAMM v2 pool (token / SOL or USDC)
3. Attach Alpha Vault with FCFS config
4. Set pool activation point timestamp
5. Distribute quote tokens to wallets
6. Open deposit window -> wallets deposit
7. Fill vault after deposit window closes
8. Wait for lock-up -> claim tokens

## DAMM v2 SDK Notes
- Use @meteora-ag/cp-amm-sdk for pool creation
- Requires initial price and liquidity range
- Base / Quote token ordering matters
- Must use @solana/web3.js 1.69.x for compatibility
- Pool fees configurable at creation time

## Transaction Handling Strategy
- Blockhash expires after ~150 slots (~60 seconds)
- Implement retry loop for fill-vault command
- Batch multiple deposits into single transactions where possible
- Priority fees: estimate via getRecentPrioritizationFees
- Use ComputeBudgetProgram for CU limit + fee

## Bundle Timing Analysis
- depositWindowSeconds: ~300s (configurable)
- fillWindow: opens immediately after deposit closes
- lockUpPeriod: 86400s default (1 day)
- vestingPeriod: optional, linear release
- Total mainnet flow: approximately 2-3 hours
- Set POOL_ACTIVATION_POINT_TS = 10800 for 3h delay

## LP Fee Monitoring
- DAMM v2 accumulates trading fees in LP positions
- Fees split between base and quote tokens
- Collect via SDK claimFee / collectFees method
- Build UI display for uncollected fee amounts
- Schedule periodic collection or trigger manually

## Architecture Decisions
- Language: TypeScript (type safety + Solana SDK support)
- Runtime: tsx for direct execution without compile step
- State persistence: MongoDB + JSON files under data/
- Dashboard: Next.js 14 with App Router
- Real-time events: Helius LaserStream gRPC
- Chart: lightweight-charts library

## Solana RPC Configuration
- Use dedicated RPC for mainnet (not public endpoint)
- Helius RPC recommended for reliability
- LaserStream requires Helius Developer or Business plan
- devnet: standard public RPC is sufficient for testing
- Store RPC URL in SOLANA_RPC_URL env variable

## UI / Dashboard Planning
- Main page: real-time price chart + event log
- Launch progress stepper: mint -> pool -> vault -> fill -> claim
- Actions panel: trigger each pipeline step manually
- Settings modals: token / pool / vault / distribution config
- Bundlers panel: per-wallet deposit status
- Toast notifications for tx success / failure

## API Routes Design
- GET /api/launch-state -> current pipeline JSON
- GET /api/pool-events -> event history array
- GET /api/pool-events/stream -> SSE live feed
- GET /api/chart-candles -> OHLCV candle data
- GET /api/pool-stats -> volume / price / liquidity
- GET /api/lp-fees -> uncollected fee amounts
- POST /api/actions/[action] -> trigger pipeline step

## Pre-Implementation Checklist
- [x] Architecture decided
- [x] API routes designed
- [x] UI layout planned
- [x] SDK versions confirmed
- [ ] Set up project structure
- [ ] Implement backend commands
- [ ] Build Next.js dashboard
- [ ] Test full flow on devnet

## Implementation Started
- Beginning full implementation as of 2026-03-24
- All planning complete, proceeding to code
