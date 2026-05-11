"use client";

import { useEffect, useState } from "react";
import { useLaunchState } from "@/lib/launchState";
import { copyText } from "@/lib/copy";
import { useToast } from "@/lib/toast";

const PHASES = [
  { key: "init",              label: "Init"        },
  { key: "token-minted",      label: "Mint"        },
  { key: "pool-created",      label: "Launch Pool" },
  { key: "vault-created",     label: "Alpha Vault" },
  { key: "funds-distributed", label: "Distribute"  },
  { key: "deposited",         label: "Deposit"     },
  { key: "filled",            label: "Fill"        },
  { key: "launched",          label: "Trading"     },
];

const PHASE_ORDER: Record<string, number> = Object.fromEntries(
  PHASES.map((p, i) => [p.key, i])
);
// Aliases for legacy phase names used by backend commands
PHASE_ORDER["initial"]    = 0;  // same as "init"
PHASE_ORDER["distributed"] = 4; // old name for "funds-distributed"
PHASE_ORDER["activated"]  = 7;  // old name for "launched"
PHASE_ORDER["claimed"]    = 8;

function phaseIndex(phase: string | undefined): number {
  if (!phase) return -1;
  return PHASE_ORDER[phase] ?? -1;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "Now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

export default function LaunchProgress() {
  const { toast } = useToast();
  const { launchState } = useLaunchState();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const activationMs =
    launchState?.poolActivationPointTs
      ? Number(launchState.poolActivationPointTs) * 1000
      : launchState?.activationPoint
        ? launchState.activationPoint * 1000
        : null;

  const isLive = activationMs ? now >= activationMs : false;
  const msUntilActivation = activationMs ? activationMs - now : null;
  const rawIdx = phaseIndex(launchState?.phase);
  const hasFillSignature = Boolean(launchState?.fillTxSignature);
  const rawIdxWithFill = hasFillSignature ? Math.max(rawIdx, phaseIndex("filled")) : rawIdx;
  // If pool is already live, force progress at least to "Trading".
  // This handles cases where fill failed or launch_state phase didn't advance in time.
  const currentIdx = isLive ? Math.max(rawIdxWithFill, phaseIndex("launched")) : rawIdxWithFill;
  const fillIdx = phaseIndex("filled");
  const tradingIdx = phaseIndex("launched");
  const fillFailedButLive = isLive && !hasFillSignature && rawIdxWithFill < fillIdx && currentIdx >= tradingIdx;

  const depositMs = launchState?.depositingPoint
    ? Number(launchState.depositingPoint) * 1000
    : null;

  return (
    <div className={`relative overflow-hidden rounded-xl border border-border/80 bg-gradient-to-br from-card via-[#121622] to-[#17131f] px-4 py-3 shadow-[0_10px_28px_rgba(0,0,0,0.35)] ${
      isLive ? "live-pulse-soft" : ""
    }`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-white/[0.035] to-transparent" />
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-mono uppercase tracking-widest text-text-secondary">
          Launch Progress
        </span>

        <div className="flex items-center gap-3">
          {/* Phase badge */}
          {launchState?.phase && (
            <span className="text-[11px] font-mono px-2.5 py-0.5 rounded border border-border/80 bg-bg/35 text-text-secondary">
              {launchState.phase}
            </span>
          )}

          {/* Countdown / LIVE badge */}
          {activationMs && (
            <span
              className={`text-[11px] font-mono font-semibold px-2.5 py-0.5 rounded border ${
                isLive
                  ? "border-cyan-400/45 bg-cyan-400/10 text-cyan-300 live-pulse-soft"
                  : "border-warn/35 bg-warn/10 text-warn"
              }`}
            >
              {isLive ? "⚡ LIVE" : `Live in ${formatCountdown(msUntilActivation!)}`}
            </span>
          )}
        </div>
      </div>

      {/* Step track */}
      <div className="relative flex items-center">
        <div className="absolute left-0 right-0 h-px bg-border/90 top-4" />
        {currentIdx >= 0 && (
          <div
            className="absolute h-px top-4 bg-gradient-to-r from-cyan-400/75 via-blue-400/70 to-violet-400/75 transition-all duration-700"
            style={{ width: `${(currentIdx / (PHASES.length - 1)) * 100}%` }}
          />
        )}

        <div className="relative flex justify-between w-full">
          {PHASES.map((phase, idx) => {
            const done   = idx < currentIdx && !(fillFailedButLive && phase.key === "filled");
            const active = idx === currentIdx;
            const isFillFailedNode = fillFailedButLive && phase.key === "filled";

            return (
              <div key={phase.key} className="flex flex-col items-center gap-2">
                <div
                  className={`
                    w-8 h-8 rounded-full border-2 flex items-center justify-center transition-all duration-300
                    ${isFillFailedNode
                      ? "bg-danger/10 border-danger"
                      : done
                        ? "bg-cyan-400/80 border-cyan-300/90"
                        : active
                          ? "bg-violet-400/15 border-violet-300/80"
                          : "bg-card border-border"
                    }
                  `}
                >
                  {isFillFailedNode ? (
                    <span className="text-xs text-danger font-bold">!</span>
                  ) : done ? (
                    <svg className="w-4 h-4 text-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : active && isLive ? (
                    <span className="text-[10px] text-cyan-300 font-bold live-pulse-soft">⚡</span>
                  ) : (
                    <div className={`w-2 h-2 rounded-full ${active ? "bg-violet-300" : "bg-border"}`} />
                  )}
                </div>
                <span
                  className={`text-[9px] font-mono uppercase tracking-wider text-center leading-tight max-w-[72px] ${
                    isFillFailedNode ? "text-danger"
                    : done ? "text-cyan-200/90"
                    : active ? "text-text-primary font-semibold"
                    : "text-muted"
                  }`}
                >
                  {isFillFailedNode ? "Fill (Failed)" : phase.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Info row */}
      {(launchState?.poolAddress || launchState?.tokenMint || launchState?.tokenMintAddress || depositMs) && (
        <div className="mt-3 pt-2 border-t border-border flex items-center gap-4 text-[10px] font-mono text-text-secondary flex-wrap">
          {launchState?.poolAddress && (
            <span
              className="cursor-pointer hover:text-text-primary transition-colors"
              title={launchState.poolAddress}
              onClick={async () => {
                const poolAddress = launchState?.poolAddress;
                if (!poolAddress) return;
                const ok = await copyText(poolAddress);
                toast(ok ? "Address is copied" : "Copy failed", ok ? "success" : "error");
              }}
            >
              Pool: <span className="text-text-primary">{launchState.poolAddress.slice(0, 8)}…</span>
            </span>
          )}
          {(launchState?.tokenMint || launchState?.tokenMintAddress) && (
            <span
              className="cursor-pointer hover:text-text-primary transition-colors"
              title={launchState?.tokenMint ?? launchState?.tokenMintAddress}
              onClick={async () => {
                const value = launchState?.tokenMint ?? launchState?.tokenMintAddress ?? "";
                const ok = await copyText(value);
                toast(ok ? "Address is copied" : "Copy failed", ok ? "success" : "error");
              }}
            >
              Mint: <span className="text-text-primary">{(launchState?.tokenMint ?? launchState?.tokenMintAddress ?? "").slice(0, 8)}…</span>
            </span>
          )}
          {depositMs && (
            <span>
              Deposit opens:{" "}
              <span className={now >= depositMs ? "text-accent/80" : "text-text-secondary"}>
                {now >= depositMs ? "Open" : formatCountdown(depositMs - now)}
              </span>
            </span>
          )}
          {activationMs && !isLive && msUntilActivation && (
            <span>
              Live in:{" "}
              <span className="text-text-primary">
                {formatCountdown(msUntilActivation)}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
