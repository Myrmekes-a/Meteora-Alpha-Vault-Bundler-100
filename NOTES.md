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
