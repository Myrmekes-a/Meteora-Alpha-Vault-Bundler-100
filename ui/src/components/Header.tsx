"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";
import type { PoolStats, LpFees } from "@/lib/types";
import { useLaunchState } from "@/lib/launchState";
import { copyText } from "@/lib/copy";
import { useToast } from "@/lib/toast";

interface HeaderProps {
  onOpenSettings: () => void;
  onOpenActions: () => void;
  onOpenReplicator: () => void;
  autoModeEnabled?: boolean;
}

function StatCell({
  label,
  value,
  color,
}: {
  label: string;
  value: ReactNode;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2 border-r border-border last:border-r-0">
      <span className="text-[10px] font-mono uppercase tracking-widest text-text-secondary">
        {label}
      </span>
      <span
        className={`text-sm font-mono font-semibold ${color ?? "text-text-primary"}`}
      >
        {value}
      </span>
    </div>
  );
}

function fmt(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(decimals)}K`;
  return `$${n.toFixed(decimals)}`;
}

function fmtPriceUsd(raw: string | undefined): string {
  const n = Number(raw ?? "0");
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1) return `$${n.toFixed(6)}`;
  if (n >= 0.001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(10)}`;
}

export default function Header({
  onOpenSettings,
  onOpenActions,
  onOpenReplicator,
  autoModeEnabled = false,
}: HeaderProps) {
  const { toast } = useToast();
  const { launchState } = useLaunchState();
  const [stats, setStats] = useState<PoolStats | null>(null);
  const [lpFees, setLpFees] = useState<LpFees | null>(null);
  const [collectingFees, setCollectingFees] = useState(false);
  const [downloadingKeys, setDownloadingKeys] = useState(false);
  const [collectResult, setCollectResult] = useState<{ success: boolean; msg: string } | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await fetch("/api/pool-stats").then((r) => (r.ok ? r.json() : null));
      setStats(s);
      setError(!s);
    } catch {
      setStats(null);
      setError(true);
    }
  }, []);

  const refreshLpFees = useCallback(async () => {
    try {
      const data: LpFees = await fetch(`/api/lp-fees?t=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
      if (!data.error) setLpFees(data);
    } catch {
      // silently ignore
    }
  }, []);

  const collectFees = useCallback(async () => {
    setCollectingFees(true);
    setCollectResult(null);
    try {
      const res = await fetch("/api/actions/collect-lp-fees", { method: "POST" });
      const data = await res.json();
      setCollectResult({
        success: data.success,
        msg: data.success ? "Fees collected!" : data.stderr?.slice(-200) ?? "Failed",
      });
      if (data.success) {
        await refreshLpFees();
        // Chain state/indexing may settle shortly after tx confirmation.
        setTimeout(() => {
          void refreshLpFees();
        }, 2500);
      }
    } catch (e) {
      setCollectResult({ success: false, msg: String(e) });
    } finally {
      setCollectingFees(false);
    }
  }, [refreshLpFees]);

  const downloadKeysCsv = useCallback(async () => {
    try {
      setDownloadingKeys(true);
      const res = await fetch("/api/wallet-export");
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "wallets-export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // keep header resilient even if export endpoint is temporarily unavailable
    } finally {
      setDownloadingKeys(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    refreshLpFees();
    const id = setInterval(refreshLpFees, 10_000);
    return () => clearInterval(id);
  }, [refreshLpFees]);

  const hasToken = Boolean(launchState?.tokenMint || launchState?.tokenMintAddress);
  const tokenName = hasToken ? (stats?.name || "Token") : "No Token";
  const tokenSymbol = stats?.symbol || "—";
  const priceChange = stats?.priceChange24h ?? 0;
  const priceColor =
    priceChange > 0
      ? "text-accent"
      : priceChange < 0
        ? "text-danger"
        : "text-text-primary";

  return (
    <header className="sticky top-0 z-40 bg-card border-b border-border shadow-lg">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        {/* Brand + token */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse-green" />
            <span className="text-xs font-mono font-bold text-accent tracking-widest uppercase">
              Meteora
            </span>
          </div>
          <div className="w-px h-4 bg-border" />
          {stats?.imageUrl ? (
            <img
              src={stats.imageUrl}
              alt={tokenName}
              className="w-7 h-7 rounded-full object-cover border border-border/70"
            />
          ) : (
            <div className="w-7 h-7 rounded-full border border-border/70 bg-bg/60 flex items-center justify-center text-[10px] font-mono text-muted">
              {tokenName === "No Token" ? "?" : (tokenSymbol?.[0] ?? "T")}
            </div>
          )}
          <div>
            <span className="text-sm font-mono font-bold text-text-primary">
              {tokenName}
            </span>
            <span className="ml-2 text-xs font-mono text-text-secondary">
              {tokenSymbol}
            </span>
          </div>
          {launchState?.poolAddress && (
            <>
              <div className="w-px h-4 bg-border" />
              <span
                className="text-[10px] font-mono text-muted hover:text-accent cursor-pointer transition-colors"
                title={launchState.poolAddress}
                onClick={async () => {
                  const ok = await copyText(launchState.poolAddress!);
                  toast(ok ? "Address is copied" : "Copy failed", ok ? "success" : "error");
                }}
              >
                {launchState.poolAddress.slice(0, 8)}…
                {launchState.poolAddress.slice(-6)}
              </span>
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-xs font-mono text-danger mr-2">
              ⚠ No data
            </span>
          )}
          <button
            onClick={downloadKeysCsv}
            disabled={downloadingKeys}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold bg-border text-text-secondary hover:bg-accent/10 hover:text-accent border border-border hover:border-accent/40 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            title="Download main + bundler wallets CSV"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {downloadingKeys ? "Downloading..." : "Download Keys"}
          </button>
          <button
            onClick={onOpenReplicator}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold bg-border text-text-secondary hover:bg-accent/10 hover:text-accent border border-border hover:border-accent/40 transition-all"
            title="Replicator Settings"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Replicator
          </button>
          <button
            onClick={onOpenActions}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold border transition-all ${
              autoModeEnabled
                ? "bg-danger/10 text-danger border-danger/35 hover:bg-danger/20 hover:border-danger/60"
                : "bg-accent/10 text-accent border-accent/30 hover:bg-accent/20 hover:border-accent/60"
            }`}
            title={autoModeEnabled ? "Stop Auto Run" : "Start Auto Run"}
          >
            {autoModeEnabled ? (
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="6" y="6" width="12" height="12" />
              </svg>
            ) : (
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
            {autoModeEnabled ? "Stop" : "Auto Run"}
          </button>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-semibold bg-border text-text-secondary hover:bg-border/60 hover:text-text-primary border border-border transition-all"
            title="Settings"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            Settings
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex overflow-x-auto scrollbar-hide">
        <StatCell
          label="Price USD"
          value={stats ? fmtPriceUsd(stats.priceUsd) : "—"}
        />
        <StatCell
          label="24h Change"
          value={
            stats
              ? `${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`
              : "—"
          }
          color={priceColor}
        />
        <StatCell
          label="Volume 24h"
          value={stats ? fmt(stats.volume24h) : "—"}
        />
        <StatCell
          label="Market Cap"
          value={stats ? fmt(stats.marketCap) : "—"}
        />
        <StatCell
          label="Liquidity"
          value={stats ? fmt(stats.liquidity) : "—"}
        />
        <StatCell
          label="Buys 24h"
          value={stats ? String(stats.buys24h) : "—"}
          color="text-accent"
        />
        <StatCell
          label="Sells 24h"
          value={stats ? String(stats.sells24h) : "—"}
          color="text-danger"
        />
        <StatCell
          label="Phase"
          value={launchState?.phase ?? "—"}
          color="text-warn"
        />
        {/* LP Fees cells — only shown when data is available */}
        {lpFees && !lpFees.error && (
          <>
            <StatCell
              label="LP Fee Token"
              value={
                lpFees.feeTokenA !== undefined
                  ? lpFees.feeTokenA.toFixed(Math.min(lpFees.tokenADecimals ?? 6, 6))
                  : "—"
              }
              color="text-purple-400"
            />
            <StatCell
              label="LP Fee SOL"
              value={
                lpFees.feeTokenB !== undefined
                  ? `${lpFees.feeTokenB.toFixed(6)} SOL`
                  : "—"
              }
              color="text-purple-400"
            />
            <div className="flex flex-col justify-center px-3 py-2 border-r border-border last:border-r-0">
              <button
                onClick={collectFees}
                disabled={collectingFees}
                className={`text-[10px] font-mono font-semibold px-2.5 py-1 rounded border transition-all whitespace-nowrap ${
                  collectingFees
                    ? "border-border text-muted cursor-not-allowed"
                    : "border-purple-400/40 text-purple-400 hover:bg-purple-400/10 hover:border-purple-400/70"
                }`}
              >
                {collectingFees ? "Collecting…" : "Collect LP Fees"}
              </button>
              {collectResult && (
                <span
                  className={`text-[9px] font-mono mt-0.5 ${
                    collectResult.success ? "text-accent" : "text-danger"
                  }`}
                >
                  {collectResult.success ? "✓ Done" : "✗ Failed"}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  );
}
