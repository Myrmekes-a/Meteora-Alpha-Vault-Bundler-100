"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LaunchState } from "@/lib/types";
import { useToast } from "@/lib/toast";
import { useLaunchState } from "@/lib/launchState";
import { runAction } from "@/lib/runAction";
import type { ActionResult } from "@/lib/runAction";
import GatherFundsModal from "@/components/modals/GatherFundsModal";

// ─── Helpers (copied from ActionsPanel) ─────────────────────────────────────

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "Now";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function getActivationMs(s: LaunchState | null): number | null {
  if (!s?.poolActivationPointTs) return null;
  const n = Number(s.poolActivationPointTs);
  if (isNaN(n)) return null;
  return n * 1000;
}

interface Cfg { claimLock: number }

// ─── Util definitions ────────────────────────────────────────────────────────

interface UtilDef {
  id: string;
  actionId: string;
  label: string;
  sublabel: string;
  icon: string;
  accent: "danger" | "purple" | "cyan" | "amber";
  availableAfterMs: (s: LaunchState | null, cfg: Cfg) => number | null;
  lockReason: (s: LaunchState | null, cfg: Cfg, now: number) => string | null;
}

const lockAfterActivation = (s: LaunchState | null, cfg: Cfg, now: number): string | null => {
  const ap = getActivationMs(s);
  if (!ap) return "Pool activation time not set yet";
  if (now < ap) return `Pool not yet activated — ${fmtCountdown(ap - now)}`;
  const openMs = ap + cfg.claimLock * 1000;
  if (now < openMs) return `Lock period — ${fmtCountdown(openMs - now)} remaining`;
  return null;
};

const availAfterLock = (s: LaunchState | null, cfg: Cfg): number | null => {
  const ap = getActivationMs(s);
  if (!ap) return null;
  return ap + cfg.claimLock * 1000;
};

const UTILS: UtilDef[] = [
  {
    id: "gather-funds",
    actionId: "gather-funds",
    label: "Gather Funds",
    sublabel: "Sweep distribution wallet SOL back to main wallet",
    icon: "🧲",
    accent: "amber",
    availableAfterMs: () => null,
    lockReason: () => null,
  },
  {
    id: "listen-pool",
    actionId: "listen-pool",
    label: "Start Listener",
    sublabel: "Pool event listener + replicator",
    icon: "📡",
    accent: "cyan",
    availableAfterMs: availAfterLock,
    lockReason: lockAfterActivation,
  },
  {
    id: "sell-pool-token",
    actionId: "sell-pool-token",
    label: "Sell All Tokens",
    sublabel: "Market sell all pool token holdings",
    icon: "💸",
    accent: "danger",
    availableAfterMs: availAfterLock,
    lockReason: lockAfterActivation,
  },
  {
    id: "collect-lp-fees",
    actionId: "collect-lp-fees",
    label: "Collect LP Fees",
    sublabel: "Claim accumulated LP trading fees",
    icon: "💜",
    accent: "purple",
    availableAfterMs: availAfterLock,
    lockReason: lockAfterActivation,
  },
];

// ─── Accent styles ───────────────────────────────────────────────────────────

const ACCENT: Record<string, { border: string; glow: string; text: string; bg: string; badge: string }> = {
  cyan:   { border: "border-cyan-400/60",   glow: "shadow-[0_0_12px_rgba(34,211,238,0.2)]",   text: "text-cyan-400",   bg: "bg-cyan-400/10",   badge: "bg-cyan-400/20 text-cyan-300 border-cyan-400/40" },
  danger: { border: "border-danger/60",     glow: "shadow-[0_0_12px_rgba(255,80,80,0.2)]",    text: "text-danger",     bg: "bg-danger/10",     badge: "bg-danger/20 text-danger border-danger/40" },
  purple: { border: "border-purple-400/60", glow: "shadow-[0_0_12px_rgba(192,132,252,0.2)]",  text: "text-purple-400", bg: "bg-purple-400/10", badge: "bg-purple-400/20 text-purple-300 border-purple-400/40" },
  amber:  { border: "border-amber-400/60",  glow: "shadow-[0_0_12px_rgba(251,191,36,0.2)]",    text: "text-amber-300",  bg: "bg-amber-400/10",  badge: "bg-amber-400/20 text-amber-200 border-amber-400/40" },
};



// ─── Component ───────────────────────────────────────────────────────────────

export default function UtilitiesPanel() {
  const { toast } = useToast();
  const { launchState } = useLaunchState();

  const [settings, setSettings]       = useState<Record<string, string>>({});
  const [now, setNow]                 = useState(Date.now());
  const [running, setRunning]         = useState<Record<string, boolean>>({});
  const [results, setResults]         = useState<Record<string, ActionResult>>({});
  const [expanded, setExpanded]       = useState<string | null>(null);
  const [gatherModalOpen, setGatherModalOpen] = useState(false);
  const controllersRef = useRef<Record<string, AbortController | null>>({});

  const cfg = useMemo<Cfg>(() => ({
    claimLock: Number(settings.ALPHA_FCFS_CLAIM_LOCK_AFTER_ACTIVATION_SEC ?? "1800"),
  }), [settings]);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/settings");
        if (r.ok) setSettings(await r.json());
      } catch { /* ignore */ }
    };
    load();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      for (const controller of Object.values(controllersRef.current)) {
        try {
          controller?.abort();
        } catch {
          // ignore abort errors during unmount
        }
      }
    };
  }, []);

  const stop = useCallback((util: UtilDef) => {
    const controller = controllersRef.current[util.id];
    if (!controller) return;
    try {
      controller.abort();
    } catch {
      // ignore
    }
    controllersRef.current[util.id] = null;
    setRunning((p) => ({ ...p, [util.id]: false }));
    toast(`"${util.label}" stopped.`, "warning");
  }, [toast]);

  const run = useCallback(async (util: UtilDef) => {
    if (util.id === "gather-funds") {
      setGatherModalOpen(true);
      return;
    }
    const reason = util.lockReason(launchState, cfg, now);
    if (reason) { toast(reason, "warning"); return; }

    if (util.id === "listen-pool" && running[util.id]) {
      stop(util);
      return;
    }

    const controller = new AbortController();
    controllersRef.current[util.id] = controller;
    setRunning((p) => ({ ...p, [util.id]: true }));
    setExpanded(util.id);
    setResults((p) => ({ ...p, [util.id]: { success: false, stdout: "", stderr: "" } }));
    try {
      const data = await runAction(util.actionId, {
        onStdout: (text) =>
          setResults((p) => ({
            ...p,
            [util.id]: { ...p[util.id], stdout: (p[util.id]?.stdout ?? "") + text },
          })),
        onStderr: (text) =>
          setResults((p) => ({
            ...p,
            [util.id]: { ...p[util.id], stderr: (p[util.id]?.stderr ?? "") + text },
          })),
      }, controller.signal);
      setResults((p) => ({ ...p, [util.id]: data }));
      if (data.success) toast(`"${util.label}" completed.`, "success");
      else              toast(`"${util.label}" failed.`, "error");
    } catch (e) {
      if (controller.signal.aborted) {
        setResults((p) => ({
          ...p,
          [util.id]: {
            success: false,
            stdout: p[util.id]?.stdout ?? "",
            stderr: ((p[util.id]?.stderr ?? "") + "\n[stopped by user]").trim(),
          },
        }));
        return;
      }
      setResults((p) => ({ ...p, [util.id]: { success: false, stderr: String(e) } }));
      toast(`"${util.label}" error: ${String(e)}`, "error");
    } finally {
      controllersRef.current[util.id] = null;
      setRunning((p) => ({ ...p, [util.id]: false }));
    }
  }, [launchState, cfg, now, toast, running, stop]);

  const activationMs  = getActivationMs(launchState);
  const isPoolLive    = activationMs ? now >= activationMs : false;
  const lockUnlockMs  = activationMs ? activationMs + cfg.claimLock * 1000 : null;
  const isUnlocked    = lockUnlockMs ? now >= lockUnlockMs : false;

  return (
    <>
    <div className="bg-card border border-border rounded-lg flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-text-secondary">
          Post-Launch
        </span>
        {isUnlocked ? (
          <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border border-accent/50 bg-accent/10 text-accent">
            ✓ UNLOCKED
          </span>
        ) : isPoolLive && lockUnlockMs ? (
          <span className="text-[9px] font-mono text-warn/80 animate-pulse">
            🔒 {fmtCountdown(lockUnlockMs - now)}
          </span>
        ) : (
          <span className="text-[9px] font-mono text-muted/60">After lock period</span>
        )}
      </div>

      {/* Lock status bar */}
      {!isUnlocked && (
        <div className={`mx-3 mt-3 px-3 py-2 rounded-lg border text-[9px] font-mono flex items-start gap-2 ${
          isPoolLive
            ? "border-warn/30 bg-warn/5 text-warn/80"
            : "border-border/50 bg-bg/40 text-muted"
        }`}>
          <span className="flex-shrink-0 mt-px">🔒</span>
          <span className="leading-relaxed">
            {isPoolLive && lockUnlockMs
              ? `Unlocks in ${fmtCountdown(lockUnlockMs - now)} — lock period ends after activation`
              : activationMs
                ? `Pool activates in ${fmtCountdown(activationMs - now)}, then lock period begins`
                : "These actions are available after pool activation + lock period"
            }
          </span>
        </div>
      )}

      {/* Buttons */}
      <div className="flex flex-col gap-2 p-3">
        {UTILS.map((util) => {
          const isRunning = running[util.id] ?? false;
          const canStop = util.id === "listen-pool" && isRunning;
          const result    = results[util.id];
          const lockMsg   = util.lockReason(launchState, cfg, now);
          const isLocked  = lockMsg !== null;
          const isExp     = expanded === util.id;
          const avail     = util.availableAfterMs(launchState, cfg);
          const countdown = avail && now < avail ? fmtCountdown(avail - now) : null;
          const ac        = ACCENT[util.accent];

          return (
            <div key={util.id} className="flex flex-col gap-0.5">
              <button
                onClick={() => run(util)}
                disabled={isLocked || (isRunning && !canStop)}
                title={isLocked ? (lockMsg ?? undefined) : undefined}
                className={`
                  w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all duration-200 text-left
                  ${isRunning
                    ? `${util.id === "listen-pool" ? "border-danger/60 bg-danger/10" : `${ac.border} ${ac.bg}`} opacity-90`
                    : isLocked
                      ? "border-border/30 bg-bg/30 cursor-not-allowed opacity-45"
                      : `${ac.border} ${ac.bg} ${ac.glow} hover:opacity-90 active:scale-[0.98]`
                  }
                `}
              >
                {/* Icon */}
                <div className={`
                  w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-sm
                  ${isLocked ? "bg-border/20" : ac.bg + " " + ac.border + " border"}
                `}>
                  {isRunning ? (
                    <svg className={`w-3.5 h-3.5 animate-spin ${ac.text}`} viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                  ) : isLocked ? (
                    <span className="text-muted/50 text-xs">🔒</span>
                  ) : (
                    <span>{util.icon}</span>
                  )}
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[11px] font-mono font-bold ${isLocked ? "text-muted/60" : ac.text}`}>
                      {canStop ? "Stop Listener" : util.label}
                    </span>
                    {!isLocked && !isRunning && result && (
                      <span className={`text-[9px] px-1 py-px rounded border ${
                        result.success ? "border-accent/40 bg-accent/10 text-accent" : "border-danger/40 bg-danger/10 text-danger"
                      }`}>
                        {result.success ? "✓" : "✗"}
                      </span>
                    )}
                    {isRunning && (
                      <span className={`text-[9px] px-1 py-px rounded border ${util.id === "listen-pool" ? "bg-danger/20 text-danger border-danger/40" : ac.badge} animate-pulse`}>
                        {util.id === "listen-pool" ? "STOP" : "RUNNING"}
                      </span>
                    )}
                  </div>
                  {!isLocked && isRunning && util.id === "listen-pool" ? (
                    <span className="text-[9px] font-mono text-danger leading-tight">
                      Listener running — click to stop
                    </span>
                  ) : isLocked && countdown ? (
                    <span className="text-[9px] font-mono text-warn/60">
                      Unlocks in {countdown}
                    </span>
                  ) : isLocked ? (
                    <span className="text-[9px] font-mono text-muted/50 truncate block leading-tight">
                      {lockMsg}
                    </span>
                  ) : (
                    <span className="text-[9px] font-mono text-muted leading-tight">{util.sublabel}</span>
                  )}
                </div>
              </button>

              {/* Output toggle */}
              {result && (
                <div className="flex items-center gap-1 px-1">
                  <button
                    onClick={() => setExpanded(isExp ? null : util.id)}
                    className="text-[8px] font-mono text-muted hover:text-text-secondary transition-colors"
                  >
                    {isExp ? "▲ hide output" : `▼ ${result.success ? "output" : "error"}`}
                  </button>
                </div>
              )}
              {isExp && result && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <div className="bg-bg/80 p-2 max-h-32 overflow-y-auto">
                    {result.stdout && (
                      <pre className="text-[9px] font-mono text-text-secondary whitespace-pre-wrap">{result.stdout}</pre>
                    )}
                    {result.stderr && (
                      <pre className="text-[9px] font-mono text-danger whitespace-pre-wrap mt-1">{result.stderr}</pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      {isUnlocked && (
        <div className="mx-3 mb-3 px-3 py-1.5 rounded-lg border border-accent/20 bg-accent/5">
          <p className="text-[9px] font-mono text-accent/70 text-center">
            ⚡ Post-launch actions are now available
          </p>
        </div>
      )}
    </div>
    <GatherFundsModal open={gatherModalOpen} onClose={() => setGatherModalOpen(false)} />
    </>
  );
}
