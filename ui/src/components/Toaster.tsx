"use client";

import { useToast, type ToastKind } from "@/lib/toast";

const STYLE: Record<ToastKind, string> = {
  success: "border-accent/60 bg-accent/10 text-accent",
  error:   "border-danger/60 bg-danger/10 text-danger",
  warning: "border-warn/60 bg-warn/10 text-warn",
  info:    "border-border bg-card text-text-primary",
  live:    "border-accent bg-accent/20 text-accent animate-glow-live",
};

const ICON: Record<ToastKind, string> = {
  success: "✓",
  error:   "✗",
  warning: "⚠",
  info:    "ℹ",
  live:    "⚡",
};

export default function Toaster() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-[300] flex flex-col gap-2 max-w-xs w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border shadow-2xl animate-toast-in pointer-events-auto ${STYLE[t.kind]}`}
        >
          <span className="text-sm font-mono font-bold flex-shrink-0 mt-px">
            {ICON[t.kind]}
          </span>
          <span className="text-xs font-mono leading-snug flex-1">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="text-[10px] opacity-60 hover:opacity-100 flex-shrink-0 mt-px transition-opacity"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
