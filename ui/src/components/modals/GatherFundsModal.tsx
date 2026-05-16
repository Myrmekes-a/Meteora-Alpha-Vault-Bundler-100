"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type WalletRow = {
  publicKey: string;
  index?: number;
  assignedAmount?: number;
  solBalanceLamports?: number;
  tokenBalance?: number;
};

type BundlersPayload = {
  wallets: WalletRow[];
  tokenMint?: string | null;
};

interface GatherFundsModalProps {
  open: boolean;
  onClose: () => void;
}

function shortKey(key: string): string {
  return key.length > 14 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key;
}

function fmtSolFromLamports(v?: number): string {
  if (v == null) return "—";
  return (v / 1_000_000_000).toFixed(4);
}

function fmtToken(v?: number): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return v.toFixed(4);
}

export default function GatherFundsModal({ open, onClose }: GatherFundsModalProps) {
  const [rows, setRows] = useState<WalletRow[]>([]);
  const [tokenMint, setTokenMint] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/bundlers?t=${Date.now()}`, { cache: "no-store" });
      const data = (await res.json()) as BundlersPayload;
      const wallets = Array.isArray(data.wallets) ? data.wallets : [];
      setRows(wallets);
      setTokenMint(data.tokenMint ?? null);
      const defaults: Record<string, boolean> = {};
      for (const w of wallets) {
        const hasAny = (w.solBalanceLamports ?? 0) > 10_000 || (w.tokenBalance ?? 0) > 0;
        defaults[w.publicKey] = hasAny;
      }
      setSelected(defaults);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setResult("");
      void load();
    }
  }, [open, load]);

  const selectedKeys = useMemo(
    () => rows.filter((r) => selected[r.publicKey]).map((r) => r.publicKey),
    [rows, selected]
  );

  const totalSol = useMemo(
    () => rows.filter((r) => selected[r.publicKey]).reduce((s, r) => s + (r.solBalanceLamports ?? 0), 0),
    [rows, selected]
  );
  const totalToken = useMemo(
    () => rows.filter((r) => selected[r.publicKey]).reduce((s, r) => s + (r.tokenBalance ?? 0), 0),
    [rows, selected]
  );

  const toggleAll = (on: boolean) => {
    const next: Record<string, boolean> = {};
    for (const r of rows) next[r.publicKey] = on;
    setSelected(next);
  };

  const gather = async () => {
    if (selectedKeys.length === 0) {
      setResult("Select at least one wallet.");
      return;
    }
    setRunning(true);
    setResult("");
    try {
      const res = await fetch("/api/gather-funds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets: selectedKeys }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setResult(data?.error ? `Failed: ${data.error}` : "Failed to gather funds.");
      } else {
        setResult(
          `Done: ${data.selected} wallets | SOL ${data.totalSolLamports} lamports | Token ${data.totalTokenRaw} raw`
        );
        await load();
      }
    } catch (e) {
      setResult(`Failed: ${String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-card border border-border rounded-xl shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-sm font-mono font-bold text-text-primary">Gather Funds</h2>
            <p className="text-[10px] font-mono text-text-secondary mt-0.5">
              Select distribution wallets to gather token + SOL
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text-primary text-xs font-mono">
            Close
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border bg-bg/35 flex items-center justify-between">
          <div className="text-[10px] font-mono text-muted">
            Token: <span className="text-cyan-300">{tokenMint ? shortKey(tokenMint) : "—"}</span>
          </div>
          <div className="text-[10px] font-mono text-muted">
            Selected: <span className="text-text-primary">{selectedKeys.length}</span> | SOL{" "}
            <span className="text-accent">{fmtSolFromLamports(totalSol)}</span> | Token{" "}
            <span className="text-cyan-300">{fmtToken(totalToken)}</span>
          </div>
        </div>

        <div className="px-5 py-2 border-b border-border flex items-center gap-3">
          <button onClick={() => toggleAll(true)} className="text-[10px] font-mono text-accent hover:underline">
            Select All
          </button>
          <button onClick={() => toggleAll(false)} className="text-[10px] font-mono text-muted hover:underline">
            Clear
          </button>
          <button onClick={() => void load()} className="text-[10px] font-mono text-cyan-300 hover:underline">
            Refresh Status
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-xs font-mono text-muted">Loading wallet status...</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-xs font-mono text-muted">No distribution wallets found.</div>
          ) : (
            <>
              <div className="flex items-center px-4 py-1 border-b border-border bg-bg/50">
                <span className="w-8 text-[9px] font-mono text-muted">SEL</span>
                <span className="w-8 text-[9px] font-mono text-muted">#</span>
                <span className="flex-1 text-[9px] font-mono text-muted">PUBLIC KEY</span>
                <span className="w-24 text-right text-[9px] font-mono text-muted">ASSIGNED</span>
                <span className="w-24 text-right text-[9px] font-mono text-muted">SOL</span>
                <span className="w-24 text-right text-[9px] font-mono text-muted">TOKEN</span>
              </div>
              {rows.map((r, i) => (
                <label
                  key={r.publicKey}
                  className="flex items-center px-4 py-2 border-b border-border/40 hover:bg-border/20"
                >
                  <span className="w-8">
                    <input
                      type="checkbox"
                      checked={!!selected[r.publicKey]}
                      onChange={(e) =>
                        setSelected((p) => ({ ...p, [r.publicKey]: e.target.checked }))
                      }
                    />
                  </span>
                  <span className="w-8 text-[10px] font-mono text-muted">{r.index ?? i + 1}</span>
                  <span className="flex-1 text-[10px] font-mono text-text-secondary">{shortKey(r.publicKey)}</span>
                  <span className="w-24 text-right text-[10px] font-mono text-warn">
                    {r.assignedAmount != null ? (r.assignedAmount / 1_000_000_000).toFixed(4) : "—"}
                  </span>
                  <span className="w-24 text-right text-[10px] font-mono text-accent">
                    {fmtSolFromLamports(r.solBalanceLamports)}
                  </span>
                  <span className="w-24 text-right text-[10px] font-mono text-cyan-300">
                    {fmtToken(r.tokenBalance)}
                  </span>
                </label>
              ))}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <span className="text-[10px] font-mono text-muted">{result || "Select wallets and click Gather Selected."}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-mono border border-border rounded text-muted hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              onClick={gather}
              disabled={running || selectedKeys.length === 0}
              className={`px-4 py-1.5 text-xs font-mono font-semibold rounded ${
                running || selectedKeys.length === 0
                  ? "bg-border text-muted cursor-not-allowed"
                  : "bg-accent text-bg hover:bg-accent/85"
              }`}
            >
              {running ? "Gathering..." : "Gather Selected"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

