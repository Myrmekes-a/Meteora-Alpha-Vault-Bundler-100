"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/lib/toast";
import { useLaunchState } from "@/lib/launchState";
import { runAction } from "@/lib/runAction";
import type { ActionResult } from "@/lib/runAction";
import type { LaunchState } from "@/lib/types";

// ─── Phase ordering ─────────────────────────────────────────────────────────

const PHASE_ORDER: Record<string, number> = {
  init: 0, initial: 0,
  "token-minted": 1,
  "pool-created": 2,
  "vault-created": 3,
  "funds-distributed": 4, distributed: 4,   // legacy alias
  deposited: 5,
  filled: 6,
  launched: 7, activated: 7,               // legacy alias
  claimed: 8,
};

function phaseIdx(phase: string | undefined): number {
  if (!phase) return -1;
  return PHASE_ORDER[phase] ?? -1;
}

// ─── Countdown helpers ───────────────────────────────────────────────────────

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "Now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Step definitions ────────────────────────────────────────────────────────

type StepStatus = "locked" | "available" | "waiting" | "running" | "done" | "live";

interface StepDef {
  id: string;
  actionId: string;        // key for /api/actions/[action]
  label: string;
  sublabel: string;
  completesPhaseIdx: number;
  requiresPhaseIdx: number;
  estimatedTime: string;
  accent: string;          // tailwind color suffix
  isAutomatic?: boolean;
  /** Returns the earliest ms timestamp when this step is allowed to run, or null = no time lock */
  availableAfterMs: (s: LaunchState | null, cfg: Cfg) => number | null;
  /** Returns ms timestamp when the window closes (deposit step), or null = no window */
  windowClosesMs: (s: LaunchState | null, cfg: Cfg) => number | null;
  /** Human-readable reason why step is time-locked */
  lockReason: (s: LaunchState | null, cfg: Cfg, now: number) => string | null;
}

interface Cfg {
  fillBuffer: number;   // FILL_BUFFER_SEC_BEFORE_ACTIVATION
  claimLock: number;    // ALPHA_FCFS_CLAIM_LOCK_AFTER_ACTIVATION_SEC
}

function getActivationMs(s: LaunchState | null): number | null {
  if (!s) return null;
  const ts = s.poolActivationPointTs ?? (s.activationPoint != null ? String(s.activationPoint) : null);
  return ts ? Number(ts) * 1000 : null;
}

const STEPS: StepDef[] = [
  {
    id: "mint",
    actionId: "mint-token",
    label: "Mint Token",
    sublabel: "Create token mint & upload metadata to Pinata",
    completesPhaseIdx: 1,
    requiresPhaseIdx: -1,
    estimatedTime: "~5 min",
    accent: "purple",
    availableAfterMs: () => null,
    windowClosesMs: () => null,
    lockReason: () => null,
  },
  {
    id: "launch",
    actionId: "launch-with-alpha-vault",
    label: "Launch Pool + Alpha Vault",
    sublabel: "Create DAMM v2 pool and FCFS alpha vault together",
    completesPhaseIdx: 3,
    requiresPhaseIdx: 1,
    estimatedTime: "~5 min",
    accent: "cyan",
    availableAfterMs: () => null,
    windowClosesMs: () => null,
    lockReason: () => null,
  },
  {
    id: "distribute",
    actionId: "distribute-funds",
    label: "Distribute Funds",
    sublabel: "Send SOL to bundler wallets before deposit window",
    completesPhaseIdx: 4,
    requiresPhaseIdx: 3,
    estimatedTime: "~2 min",
    accent: "yellow",
    availableAfterMs: () => null,
    windowClosesMs: (s) => {
      const dp = s?.depositingPoint ? Number(s.depositingPoint) * 1000 : null;
      return dp;
    },
    lockReason: () => null,
  },
  {
    id: "deposit",
    actionId: "deposit-to-vault",
    label: "Deposit to Vault",
    sublabel: "Bundler wallets deposit SOL into alpha vault",
    completesPhaseIdx: 5,
    requiresPhaseIdx: 4,
    estimatedTime: "~5 min",
    accent: "green",
    availableAfterMs: (s) => {
      const dp = s?.depositingPoint ? Number(s.depositingPoint) * 1000 : null;
      return dp;
    },
    windowClosesMs: (s) => getActivationMs(s),
    lockReason: (s, _cfg, now) => {
      const dp = s?.depositingPoint ? Number(s.depositingPoint) * 1000 : null;
      if (dp && now < dp) return `Deposit window opens in ${fmtCountdown(dp - now)}`;
      return null;
    },
  },
  {
    id: "fill",
    actionId: "fill-vault",
    label: "Fill Vault",
    sublabel: "Crank the vault just before pool activation",
    completesPhaseIdx: 6,
    requiresPhaseIdx: 5,
    estimatedTime: "~1 min",
    accent: "orange",
    availableAfterMs: (s, cfg) => {
      const ap = getActivationMs(s);
      if (!ap) return null;
      return ap - cfg.fillBuffer * 1000;
    },
    windowClosesMs: (s) => getActivationMs(s),
    lockReason: (s, cfg, now) => {
      const ap = getActivationMs(s);
      if (!ap) return "Pool activation time not set yet";
      const openMs = ap - cfg.fillBuffer * 1000;
      if (now < openMs) return `Fill window opens in ${fmtCountdown(openMs - now)} (${cfg.fillBuffer}s before activation)`;
      return null;
    },
  },
  {
    id: "trading",
    actionId: "",
    label: "Activate Trading",
    sublabel: "Pool goes live — public trading begins automatically",
    completesPhaseIdx: 7,
    requiresPhaseIdx: 6,
    estimatedTime: "Automatic at activation",
    accent: "accent",
    isAutomatic: true,
    availableAfterMs: (s) => getActivationMs(s),
    windowClosesMs: () => null,
    lockReason: (s, _cfg, now) => {
      const ap = getActivationMs(s);
      if (!ap) return "Activation time not set";
      if (now < ap) return `Pool activates in ${fmtCountdown(ap - now)}`;
      return null;
    },
  },
  {
    id: "claim",
    actionId: "claim-tokens",
    label: "Claim Tokens",
    sublabel: "Claim tokens after lock period expires",
    completesPhaseIdx: 8,
    requiresPhaseIdx: 7,
    estimatedTime: "~2 min",
    accent: "emerald",
    availableAfterMs: (s, cfg) => {
      const ap = getActivationMs(s);
      if (!ap) return null;
      return ap + cfg.claimLock * 1000;
    },
    windowClosesMs: () => null,
    lockReason: (s, cfg, now) => {
      const ap = getActivationMs(s);
      if (!ap) return "Activation time not set";
      if (now < ap) return `Pool not yet activated (${fmtCountdown(ap - now)} remaining)`;
      const claimMs = ap + cfg.claimLock * 1000;
      if (now < claimMs) return `Lock period expires in ${fmtCountdown(claimMs - now)}`;
      return null;
    },
  },
];

// ─── Accent color maps ───────────────────────────────────────────────────────

const ACCENT_RING: Record<string, string> = {
  blue:    "ring-blue-400/25 shadow-[0_0_10px_rgba(96,165,250,0.12)]",
  purple:  "ring-purple-400/25 shadow-[0_0_10px_rgba(192,132,252,0.12)]",
  cyan:    "ring-cyan-400/25 shadow-[0_0_10px_rgba(34,211,238,0.12)]",
  yellow:  "ring-warn/25 shadow-[0_0_10px_rgba(245,166,35,0.12)]",
  orange:  "ring-orange-400/25 shadow-[0_0_10px_rgba(251,146,60,0.12)]",
  green:   "ring-emerald-400/25 shadow-[0_0_10px_rgba(52,211,153,0.12)]",
  emerald: "ring-emerald-300/25 shadow-[0_0_10px_rgba(110,231,183,0.12)]",
  accent:  "ring-cyan-300/30 shadow-[0_0_12px_rgba(103,232,249,0.15)]",
};

const ACCENT_DOT: Record<string, string> = {
  blue:    "bg-blue-400/80",
  purple:  "bg-purple-400/80",
  cyan:    "bg-cyan-400/80",
  yellow:  "bg-warn/85",
  orange:  "bg-orange-400/80",
  green:   "bg-emerald-400/80",
  emerald: "bg-emerald-300/80",
  accent:  "bg-cyan-300/85",
};

const ACCENT_TEXT: Record<string, string> = {
  blue:    "text-blue-300",
  purple:  "text-purple-300",
  cyan:    "text-cyan-300",
  yellow:  "text-amber-300",
  orange:  "text-orange-300",
  green:   "text-emerald-300",
  emerald: "text-emerald-200",
  accent:  "text-cyan-200",
};

const ACCENT_BTN: Record<string, string> = {
  blue:    "border-blue-300/35 text-blue-200 hover:bg-blue-400/10 hover:border-blue-300/60",
  purple:  "border-purple-300/35 text-purple-200 hover:bg-purple-400/10 hover:border-purple-300/60",
  cyan:    "border-cyan-300/35 text-cyan-200 hover:bg-cyan-400/10 hover:border-cyan-300/60",
  yellow:  "border-amber-300/35 text-amber-200 hover:bg-amber-400/10 hover:border-amber-300/60",
  orange:  "border-orange-300/35 text-orange-200 hover:bg-orange-400/10 hover:border-orange-300/60",
  green:   "border-emerald-300/35 text-emerald-200 hover:bg-emerald-400/10 hover:border-emerald-300/60",
  emerald: "border-emerald-200/35 text-emerald-100 hover:bg-emerald-300/10 hover:border-emerald-200/60",
  accent:  "border-cyan-300/40 text-cyan-200 hover:bg-cyan-400/15 hover:border-cyan-200/65",
};


// ─── Main component ──────────────────────────────────────────────────────────

interface ActionsPanelProps {
  autoRunTrigger?: number;
  stopAutoRunTrigger?: number;
  onAutoModeChange?: (enabled: boolean) => void;
}

export default function ActionsPanel({
  autoRunTrigger = 0,
  stopAutoRunTrigger = 0,
  onAutoModeChange,
}: ActionsPanelProps) {
  const { toast } = useToast();
  const { launchState, refresh: refreshLaunchState } = useLaunchState();

  const [settings, setSettings] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  const prevLivRef = useRef(false);
  const autoFillTriggerRef = useRef<string | null>(null);
  const lastAutoRunTriggerRef = useRef(0);
  const lastStopAutoRunTriggerRef = useRef(0);
  const autoStepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);

  const cfg: Cfg = useMemo(() => ({
    fillBuffer: Number(settings.FILL_BUFFER_SEC_BEFORE_ACTIVATION ?? "40"),
    claimLock:  Number(settings.ALPHA_FCFS_CLAIM_LOCK_AFTER_ACTIVATION_SEC ?? "1800"),
  }), [settings]);


  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) setSettings(await res.json());
      } catch { /* ignore */ }
    };
    load();
  }, []);

  // 1-second tick
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // "Trading LIVE" toast when activation passes
  useEffect(() => {
    const ap = getActivationMs(launchState);
    const isLive = ap ? now >= ap : false;
    if (isLive && !prevLivRef.current) {
      toast("⚡ Pool is now LIVE — public trading has started!", "live", 0);
    }
    prevLivRef.current = isLive;
  }, [now, launchState, toast]);

  // Step status logic
  const getStepStatus = useCallback((step: StepDef): StepStatus => {
    const curIdxRaw = phaseIdx(launchState?.phase);
    const ap = getActivationMs(launchState);
    const isLive = ap ? now >= ap : false;
    const curIdx = isLive ? Math.max(curIdxRaw, phaseIdx("launched")) : curIdxRaw;
    const fillAlreadyExecuted = step.id === "fill" && Boolean(launchState?.fillTxSignature);

    if (fillAlreadyExecuted || curIdx >= step.completesPhaseIdx) return "done";
    if (step.isAutomatic) {
      if (isLive) return "live";
      return curIdx >= step.requiresPhaseIdx ? "waiting" : "locked";
    }
    if (running[step.actionId]) return "running";
    if (curIdx < step.requiresPhaseIdx) return "locked";

    const avail = step.availableAfterMs(launchState, cfg);
    if (avail && now < avail) return "waiting";

    return "available";
  }, [launchState, cfg, now, running]);

  const stopAutoRun = useCallback((reason = "Auto-run stopped.") => {
    setAutoMode(false);
    if (autoStepTimerRef.current) {
      clearTimeout(autoStepTimerRef.current);
      autoStepTimerRef.current = null;
    }
    const active = activeAbortRef.current;
    if (active) {
      active.abort();
      activeAbortRef.current = null;
    }
    toast(reason, "warning");
  }, [toast]);

  const runStep = useCallback(async (step: StepDef) => {
    if (!step.actionId) return;

    const status = getStepStatus(step);
    if (status === "locked") {
      const curIdx = phaseIdx(launchState?.phase);
      const prevStep = STEPS.find((s) => s.completesPhaseIdx === step.requiresPhaseIdx);
      toast(
        `"${step.label}" requires "${prevStep?.label ?? `phase ${step.requiresPhaseIdx}`}" to be completed first.`,
        "warning"
      );
      return;
    }

    if (status === "waiting") {
      const reason = step.lockReason(launchState, cfg, now);
      toast(reason ?? `"${step.label}" is not available yet.`, "warning");
      return;
    }

    // Check window-close warning
    const windowMs = step.windowClosesMs(launchState, cfg);
    if (windowMs && now >= windowMs) {
      toast(`Warning: the window for "${step.label}" may have closed.`, "error");
      return;
    }

    setRunning((prev) => ({ ...prev, [step.actionId]: true }));
    setExpanded(step.id);
    setResults((prev) => ({ ...prev, [step.id]: { success: false, stdout: "", stderr: "" } }));
    const abortController = new AbortController();
    activeAbortRef.current = abortController;

    try {
      const data = await runAction(step.actionId, {
        onStdout: (text) =>
          setResults((prev) => ({
            ...prev,
            [step.id]: { ...prev[step.id], stdout: (prev[step.id]?.stdout ?? "") + text },
          })),
        onStderr: (text) =>
          setResults((prev) => ({
            ...prev,
            [step.id]: { ...prev[step.id], stderr: (prev[step.id]?.stderr ?? "") + text },
          })),
      }, abortController.signal);
      setResults((prev) => ({ ...prev, [step.id]: data }));
      if (data.success) {
        toast(`"${step.label}" completed successfully.`, "success");
        refreshLaunchState();
      } else {
        toast(`"${step.label}" failed. Check the output log.`, "error");
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        const abortedResult: ActionResult = {
          success: false,
          stderr: "Stopped by user.",
        };
        setResults((prev) => ({ ...prev, [step.id]: abortedResult }));
        toast(`"${step.label}" stopped.`, "warning");
        return;
      }
      const errResult: ActionResult = { success: false, stderr: String(e) };
      setResults((prev) => ({ ...prev, [step.id]: errResult }));
      toast(`"${step.label}" error: ${String(e)}`, "error");
    } finally {
      if (activeAbortRef.current === abortController) {
        activeAbortRef.current = null;
      }
      setRunning((prev) => ({ ...prev, [step.actionId]: false }));
    }
  }, [getStepStatus, launchState, cfg, now, toast, refreshLaunchState]);

  // Start auto-run mode when triggered by header button.
  useEffect(() => {
    if (autoRunTrigger <= 0) return;
    if (autoRunTrigger === lastAutoRunTriggerRef.current) return;
    lastAutoRunTriggerRef.current = autoRunTrigger;
    setAutoMode(true);
    toast("🤖 Auto-run started. Steps will execute automatically when available.", "info");
  }, [autoRunTrigger, toast]);

  useEffect(() => {
    if (stopAutoRunTrigger <= 0) return;
    if (stopAutoRunTrigger === lastStopAutoRunTriggerRef.current) return;
    lastStopAutoRunTriggerRef.current = stopAutoRunTrigger;
    stopAutoRun("🛑 Auto-run stopped by user.");
  }, [stopAutoRunTrigger, stopAutoRun]);

  useEffect(() => {
    onAutoModeChange?.(autoMode);
  }, [autoMode, onAutoModeChange]);

  // Auto orchestration: run next actionable step in sequence.
  useEffect(() => {
    if (!autoMode) return;
    const hasRunning = Object.values(running).some(Boolean);
    if (hasRunning) return;

    const curIdxRaw = phaseIdx(launchState?.phase);
    const ap = getActivationMs(launchState);
    const isLive = ap ? now >= ap : false;
    const curIdx = isLive ? Math.max(curIdxRaw, phaseIdx("launched")) : curIdxRaw;
    const nextStep = STEPS.find((s) => !s.isAutomatic && curIdx < s.completesPhaseIdx);
    if (!nextStep) {
      setAutoMode(false);
      toast("✅ Auto-run finished. All steps are completed.", "success");
      return;
    }

    const status = getStepStatus(nextStep);
    if (status === "available") {
      void runStep(nextStep);
      return;
    }

    // For time-locked steps (especially Fill Vault), schedule exact execution at open time
    // so we don't miss the narrow window due to polling drift.
    if (status === "waiting") {
      const openMs = nextStep.availableAfterMs(launchState, cfg);
      if (openMs && openMs > now) {
        if (autoStepTimerRef.current) clearTimeout(autoStepTimerRef.current);
        const waitMs = Math.max(0, openMs - now + 50);
        autoStepTimerRef.current = setTimeout(() => {
          void runStep(nextStep);
        }, waitMs);
      }
    }
    return () => {
      if (autoStepTimerRef.current) {
        clearTimeout(autoStepTimerRef.current);
        autoStepTimerRef.current = null;
      }
    };
  }, [autoMode, running, launchState, cfg, now, getStepStatus, runStep, toast]);

  useEffect(() => {
    if (autoMode) return;
    if (autoStepTimerRef.current) {
      clearTimeout(autoStepTimerRef.current);
      autoStepTimerRef.current = null;
    }
  }, [autoMode]);

  useEffect(() => {
    return () => {
      if (activeAbortRef.current) {
        activeAbortRef.current.abort();
        activeAbortRef.current = null;
      }
      if (autoStepTimerRef.current) {
        clearTimeout(autoStepTimerRef.current);
        autoStepTimerRef.current = null;
      }
    };
  }, []);

  // Auto-run Fill Vault when the fill window opens.
  useEffect(() => {
    const fillStep = STEPS.find((s) => s.id === "fill");
    if (!fillStep) return;

    const activationMs = getActivationMs(launchState);
    const fillOpenMs = fillStep.availableAfterMs(launchState, cfg);
    const curIdx = phaseIdx(launchState?.phase);
    const status = getStepStatus(fillStep);
    const isRunning = running[fillStep.actionId] ?? false;

    // Reset trigger marker when launch context changes before fill phase.
    const triggerKey = `${activationMs ?? "na"}:${fillOpenMs ?? "na"}:${fillStep.actionId}`;
    if (curIdx < fillStep.requiresPhaseIdx) {
      autoFillTriggerRef.current = null;
      return;
    }

    if (status !== "available" || isRunning) return;

    // Fire exactly once per fill window.
    if (autoFillTriggerRef.current === triggerKey) return;
    autoFillTriggerRef.current = triggerKey;

    toast("⏱ Fill window opened — auto-running Fill Vault now.", "info");
    void runStep(fillStep);
  }, [launchState, cfg, running, getStepStatus, runStep, toast]);


  const activationMs = getActivationMs(launchState);
  const isLive = activationMs ? now >= activationMs : false;

  return (
    <div className={`relative overflow-hidden rounded-xl border border-border/80 bg-gradient-to-br from-card via-[#121622] to-[#17131f] shadow-[0_12px_32px_rgba(0,0,0,0.35)] flex flex-col ${
      isLive ? "live-pulse-soft" : ""
    }`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-white/[0.03] to-transparent" />
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border/80 flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-text-secondary">
          Launch Actions
        </span>
        <div className="flex items-center gap-1.5">
          {autoMode && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded border border-violet-300/35 bg-violet-400/10 text-violet-200">
              AUTO MODE
            </span>
          )}
          {isLive && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded border border-cyan-300/40 bg-cyan-400/10 text-cyan-200 live-pulse-soft">
              ⚡ LIVE
            </span>
          )}
        </div>
      </div>

      {/* TRADING LIVE banner */}
      {isLive && (
        <div className="mx-3 mt-3 px-3 py-2.5 rounded-lg border border-cyan-300/25 bg-gradient-to-r from-cyan-400/10 via-blue-400/10 to-violet-400/10 live-pulse-soft">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-cyan-300 animate-pulse" />
            <span className="text-[11px] font-mono font-semibold text-cyan-100">Pool is live — trading active</span>
          </div>
          {activationMs && (
            <span className="text-[9px] font-mono text-muted mt-0.5 block">
              Activated at {fmtDate(activationMs)}
            </span>
          )}
        </div>
      )}

      {/* Step flow */}
      <div className="flex flex-col p-3 gap-1.5">
        {STEPS.map((step, stepIdx) => {
          const status = getStepStatus(step);
          const isRunning = running[step.actionId] ?? false;
          const result = results[step.id];
          const isExpanded = expanded === step.id;
          const avail = step.availableAfterMs(launchState, cfg);
          const windowClose = step.windowClosesMs(launchState, cfg);
          const lockReason = step.lockReason(launchState, cfg, now);

          return (
            <div key={step.id}>
              {/* Step card */}
              <div
                className={`
                  relative flex gap-2.5 px-3 py-2.5 rounded-lg border transition-all duration-200
                  ${status === "done"
                    ? "border-border/50 bg-card/70"
                    : status === "live"
                      ? "border-cyan-300/35 bg-cyan-400/5"
                      : status === "running"
                        ? `border-border bg-card ring-1 ${ACCENT_RING[step.accent]}`
                        : status === "available"
                          ? "border-border/90 bg-card hover:border-border"
                          : "border-border/30 bg-card/40"
                  }
                `}
              >
                <div className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-r ${
                  status === "locked" || status === "waiting" ? "bg-border" : ACCENT_DOT[step.accent]
                }`} />
                {/* Left: step number indicator */}
                <div className="flex flex-col items-center gap-1 flex-shrink-0 pt-0.5">
                  <div
                    className={`
                      w-5 h-5 rounded-full border flex items-center justify-center text-[9px] font-mono font-bold transition-all
                      ${status === "done"
                        ? "border-cyan-300/70 bg-cyan-300/70 text-bg"
                        : status === "live"
                          ? "border-cyan-300/65 bg-cyan-300/10 text-cyan-200"
                          : status === "running"
                            ? `${ACCENT_TEXT[step.accent]} border-current bg-card`
                            : status === "available"
                              ? `${ACCENT_TEXT[step.accent]} border-current bg-card`
                              : "border-border text-muted bg-card"
                      }
                    `}
                  >
                    {status === "done" ? (
                      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : status === "running" ? (
                      <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                    ) : status === "live" ? (
                      "⚡"
                    ) : (
                      stepIdx + 1
                    )}
                  </div>
                  {/* Connector line */}
                  {stepIdx < STEPS.length - 1 && (
                    <div className="w-px flex-1 min-h-[12px] bg-border" />
                  )}
                </div>

                {/* Right: content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`text-[11px] font-mono font-semibold leading-tight ${
                            status === "done"
                              ? "text-text-secondary"
                              : status === "live"
                                ? "text-cyan-100"
                              : status === "locked" || status === "waiting"
                                ? "text-muted"
                                : ACCENT_TEXT[step.accent]
                          }`}
                        >
                          {step.label}
                        </span>

                        {/* Status badge */}
                        {status === "done" && (
                          <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-card text-muted border border-border/50">DONE</span>
                        )}
                        {status === "live" && (
                          <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-cyan-400/10 text-cyan-200 border border-cyan-300/35">LIVE</span>
                        )}
                        {status === "running" && (
                          <span className="text-[8px] font-mono px-1 py-0.5 rounded bg-card border border-border text-text-secondary">
                            RUNNING
                          </span>
                        )}
                        {status === "waiting" && (
                          <span className="text-[8px] font-mono px-1 py-0.5 rounded text-amber-200 border border-amber-300/35 bg-amber-400/10">
                            {avail ? fmtCountdown(avail - now) : "WAITING"}
                          </span>
                        )}
                        {status === "locked" && (
                          <span className="text-[8px] font-mono px-1 py-0.5 rounded text-muted border border-border/40">LOCKED</span>
                        )}
                      </div>

                      <p className={`text-[9px] font-mono mt-0.5 leading-snug ${
                        status === "locked" || status === "waiting" ? "text-muted/70" : "text-text-secondary"
                      }`}>
                        {step.sublabel}
                      </p>

                      {/* Time hint */}
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-[8px] font-mono text-muted/80">
                          ⏱ {step.estimatedTime}
                        </span>

                        {/* Window closes countdown */}
                        {windowClose && now < windowClose && status !== "done" && (
                          <span className="text-[8px] font-mono text-warn/80">
                            Window: {fmtCountdown(windowClose - now)}
                          </span>
                        )}

                        {/* Claim availability countdown */}
                        {step.id === "claim" && status === "waiting" && (
                          <span className="text-[8px] font-mono text-warn animate-countdown-tick">
                            {lockReason}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action button */}
                    {!step.isAutomatic && (
                      <button
                        onClick={() => runStep(step)}
                        disabled={isRunning}
                        title={
                          status === "locked"
                            ? `Requires step ${step.requiresPhaseIdx} to be done`
                            : status === "waiting"
                              ? lockReason ?? "Not available yet"
                              : `Run: ${step.label}`
                        }
                        className={`
                          flex-shrink-0 px-2 py-1.5 text-[9px] font-mono rounded border transition-all
                          ${isRunning
                            ? "border-border text-muted cursor-not-allowed"
                            : status === "done"
                              ? "border-border/40 text-muted hover:text-text-secondary hover:border-border cursor-pointer"
                              : status === "locked" || status === "waiting"
                                ? "border-border/40 text-muted/50 cursor-pointer"
                                : ACCENT_BTN[step.accent]
                          }
                        `}
                      >
                        {isRunning ? (
                          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                          </svg>
                        ) : status === "done" ? (
                          "Re-run"
                        ) : (
                          "Run"
                        )}
                      </button>
                    )}
                  </div>

                  {/* Output toggle */}
                  {result && (
                    <button
                      onClick={() => setExpanded(isExpanded ? null : step.id)}
                      className="mt-1.5 text-[8px] font-mono text-muted hover:text-text-secondary transition-colors"
                    >
                      {isExpanded ? "▲ Hide output" : `▼ ${result.success ? "✓ Show output" : "✗ Show error"}`}
                    </button>
                  )}
                </div>
              </div>

              {/* Collapsible output */}
              {isExpanded && result && (
                <div className="mx-2 mb-1 border border-border rounded-lg overflow-hidden animate-fade-in">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-bg border-b border-border">
                    <span className={`text-[9px] font-mono font-semibold ${result.success ? "text-accent" : "text-danger"}`}>
                      {result.success ? "✓ Success" : "✗ Failed"}
                    </span>
                    <button onClick={() => setExpanded(null)} className="text-muted hover:text-text-primary text-[10px]">✕</button>
                  </div>
                  <div className="bg-bg/70 p-2.5 max-h-32 overflow-y-auto">
                    {result.stdout && (
                      <pre className="text-[9px] font-mono text-text-secondary whitespace-pre-wrap leading-relaxed">
                        {result.stdout}
                      </pre>
                    )}
                    {result.stderr && (
                      <pre className="text-[9px] font-mono text-danger whitespace-pre-wrap leading-relaxed mt-1">
                        {result.stderr}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
