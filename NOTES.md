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
