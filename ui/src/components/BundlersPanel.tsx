"use client";

import { useEffect, useState, useCallback } from "react";
import { copyText } from "@/lib/copy";
import { useToast } from "@/lib/toast";

interface Wallet {
  index?: number;
  publicKey: string;
  assignedAmount?: number;
  solBalanceLamports?: number;
  tokenBalance?: number;
  tokenBalanceRaw?: string;
  secretKey?: unknown;
}

interface BundlersData {
  wallets: Wallet[];
  tokenMint?: string | null;
}

function shortKey(key: string): string {
  if (!key || key.length < 12) return key;
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}

function lamportsToSol(lamports: number | undefined): string {
  if (lamports === undefined || lamports === null) return "—";
  return (lamports / 1_000_000_000).toFixed(4);
}

function fmtToken(v: number | undefined): string {
  if (v === undefined || v === null) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return v.toFixed(4);
}

function rawToSol(raw: number | undefined): string {
  if (raw === undefined || raw === null) return "—";
  return (raw / 1_000_000_000).toFixed(4);
}

export default function BundlersPanel() {
  const { toast } = useToast();
  const [data, setData] = useState<BundlersData>({ wallets: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setRefreshing(true);
      const res = await fetch(`/api/bundlers?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        setData(await res.json());
        setLastUpdatedAt(Date.now());
      } else {
        setData({ wallets: [] });
      }
    } catch {
      setData({ wallets: [] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const wallets = data.wallets;
  const totalAssigned = data.wallets.reduce(
    (sum, w) => sum + (w.assignedAmount ?? 0),
    0
  );
  const totalSolLamports = data.wallets.reduce(
    (sum, w) => sum + (w.solBalanceLamports ?? 0),
    0
  );
  const totalTokenBalance = data.wallets.reduce(
    (sum, w) => sum + (w.tokenBalance ?? 0),
    0
  );

  return (
    <div className="bg-card border border-border rounded-lg flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <span className="text-[10px] font-mono uppercase tracking-widest text-text-secondary">
          Bundler Wallets
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={refreshing}
            className="text-[10px] font-mono text-muted hover:text-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {refreshing ? "↻ Updating..." : "↻ Refresh"}
          </button>
        </div>
      </div>

      {wallets.length > 0 && (
        <div className="px-3 pt-2 pb-2 border-b border-border bg-bg/25">
          <div className="rounded-lg border border-cyan-400/20 bg-[linear-gradient(120deg,rgba(34,211,238,0.08),rgba(15,23,42,0.45))] px-3 py-2.5 min-h-[66px]">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <div className="flex flex-col">
                <span className="text-[9px] font-mono uppercase tracking-wider text-muted">Assigned SOL</span>
                <span className="text-sm font-mono font-semibold text-warn">{rawToSol(totalAssigned)} SOL</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] font-mono uppercase tracking-wider text-muted">Live SOL</span>
                <span className="text-sm font-mono font-semibold text-accent">{lamportsToSol(totalSolLamports)} SOL</span>
              </div>
              <div className="col-span-2 flex items-baseline justify-between">
                <span className="text-[9px] font-mono uppercase tracking-wider text-muted">Live Token</span>
                <span className="text-sm font-mono font-semibold text-cyan-300">{fmtToken(totalTokenBalance)} Token</span>
              </div>
            </div>
            <div className="mt-1 text-[9px] font-mono text-muted/80 text-right">
              {lastUpdatedAt ? `Updated ${new Date(lastUpdatedAt).toLocaleTimeString()}` : "Not updated yet"}
            </div>
          </div>
        </div>
      )}

      {/* Distribution header */}
      <div className="flex border-b border-border px-3">
        <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border-b-2 -mb-px border-accent text-accent">
          Distribution ({data.wallets.length})
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted text-xs font-mono">
          Loading wallets…
        </div>
      ) : wallets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <span className="text-muted text-2xl">👛</span>
          <p className="text-xs font-mono text-muted">No wallets found</p>
          <p className="text-[10px] font-mono text-muted/60">
            Run &quot;Distribute&quot; to create bundler wallets
          </p>
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div className="flex items-center px-3 py-1 border-b border-border bg-bg/40">
            <span className="text-[9px] font-mono uppercase text-muted w-6">#</span>
            <span className="text-[9px] font-mono uppercase text-muted flex-1">
              Public Key
            </span>
            <span className="text-[9px] font-mono uppercase text-muted w-20 text-right">
              Assigned
            </span>
            <span className="text-[9px] font-mono uppercase text-muted w-20 text-right">
              SOL Bal
            </span>
            <span className="text-[9px] font-mono uppercase text-muted w-24 text-right">
              Token Bal
            </span>
          </div>

          {/* Rows */}
          <div className="overflow-y-auto max-h-64">
            {wallets.map((wallet, idx) => (
              <div
                key={wallet.publicKey}
                className="flex items-center px-3 py-2 border-b border-border/40 hover:bg-border/20 transition-colors"
              >
                <span className="text-[10px] font-mono text-muted w-6">
                  {wallet.index ?? idx + 1}
                </span>
                <span
                  className="text-[10px] font-mono text-text-secondary flex-1 hover:text-accent cursor-pointer transition-colors"
                  title={wallet.publicKey}
                  onClick={async () => {
                    const ok = await copyText(wallet.publicKey);
                    toast(ok ? "Address is copied" : "Copy failed", ok ? "success" : "error");
                  }}
                >
                  {shortKey(wallet.publicKey)}
                </span>
                <span className="text-[10px] font-mono text-warn w-20 text-right">
                  {wallet.assignedAmount !== undefined
                    ? rawToSol(wallet.assignedAmount)
                    : "—"}
                </span>
                <span className="text-[10px] font-mono text-accent w-20 text-right">
                  {lamportsToSol(wallet.solBalanceLamports)}
                </span>
                <span className="text-[10px] font-mono text-cyan-300 w-24 text-right">
                  {fmtToken(wallet.tokenBalance)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
