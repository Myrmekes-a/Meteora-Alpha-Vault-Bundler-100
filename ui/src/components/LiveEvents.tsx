"use client";

import { useEffect, useRef, useState } from "react";

interface EventRow {
  _id: string;
  event: {
    type?: string;
    eventType?: string;
    signature?: string;
    amountA?: string | number;
    amountB?: string | number;
    timestamp?: number;
    [key: string]: unknown;
  };
  createdAt: string;
}

function getEventType(event: EventRow["event"]): string {
  // Prefer semantic event type from listener ("Buy", "Sell", etc.)
  if (event.eventType) return String(event.eventType);
  if (event.type) return String(event.type);
  const keys = Object.keys(event);
  const typeKey = keys.find((k) => k.toLowerCase().includes("type"));
  if (typeKey) return String(event[typeKey]);
  return "Event";
}

function getEventColor(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("buy") || t.includes("add") || t.includes("deposit")) return "text-accent";
  if (t.includes("sell") || t.includes("remove") || t.includes("withdraw")) return "text-danger";
  if (t.includes("fill") || t.includes("claim")) return "text-warn";
  return "text-text-secondary";
}

function getRowBg(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("buy") || t.includes("add") || t.includes("deposit")) return "bg-accent/5 hover:bg-accent/10";
  if (t.includes("sell") || t.includes("remove") || t.includes("withdraw")) return "bg-danger/5 hover:bg-danger/10";
  return "hover:bg-border/30";
}

function formatAmount(v: string | number | undefined): string {
  if (v === undefined || v === null) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  return n.toFixed(4);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

function eventSignature(event: EventRow["event"]): string | null {
  const sig = event.signature;
  if (typeof sig === "string" && sig.trim().length > 0) return sig.trim();
  return null;
}

function rowTs(row: EventRow): number {
  const t = Date.parse(row.createdAt);
  if (Number.isFinite(t) && t > 0) return t;
  // Fallback to ObjectId timestamp (first 8 hex chars).
  const raw = (row._id ?? "").slice(0, 8);
  const n = Number.parseInt(raw, 16);
  return Number.isFinite(n) ? n * 1000 : 0;
}

export default function LiveEvents() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);

  pausedRef.current = paused;

  useEffect(() => {
    const es = new EventSource("/api/pool-events/stream");

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      if (pausedRef.current) return;
      try {
        const row: EventRow = JSON.parse(e.data);
        setEvents((prev) => {
          const sig = eventSignature(row.event);
          const exists = prev.some(
            (p) => p._id === row._id || (sig && eventSignature(p.event) === sig)
          );
          if (exists) return prev;
          const next = [row, ...prev]
            .sort((a, b) => rowTs(b) - rowTs(a))
            .slice(0, 200);
          return next;
        });
      } catch {
        // ignore parse errors
      }
    };

    return () => es.close();
  }, []);

  useEffect(() => {
    if (!paused && events.length > 0) {
      listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [events, paused]);

  return (
    <div className="bg-card border border-border rounded-lg flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-accent animate-pulse" : "bg-muted"
            }`}
          />
          <span className="text-[10px] font-mono uppercase tracking-widest text-text-secondary">
            Live Pool Events
          </span>
          <span className="text-[10px] font-mono text-muted">
            ({events.length})
          </span>
        </div>
        <button
          onClick={() => setPaused((p) => !p)}
          className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-all ${
            paused
              ? "border-warn text-warn hover:bg-warn/10"
              : "border-border text-muted hover:border-text-secondary hover:text-text-secondary"
          }`}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      </div>

      {/* Column headers */}
      <div className="flex items-center px-3 py-1 border-b border-border bg-bg/40 flex-shrink-0">
        <span className="text-[9px] font-mono uppercase text-muted w-16">Type</span>
        <span className="text-[9px] font-mono uppercase text-muted w-24 text-right">Amount A</span>
        <span className="text-[9px] font-mono uppercase text-muted w-24 text-right">Amount B</span>
        <span className="text-[9px] font-mono uppercase text-muted w-20 text-right">View</span>
        <span className="text-[9px] font-mono uppercase text-muted flex-1 text-right">Time</span>
      </div>

      {/* Events */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {events.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted text-xs font-mono">
            {connected ? "Waiting for events…" : "Connecting…"}
          </div>
        )}
        {events.map((row) => {
          const type = getEventType(row.event);
          const colorClass = getEventColor(type);
          const bgClass = getRowBg(type);
          const sig = eventSignature(row.event);
          const solscanUrl = sig ? `https://solscan.io/tx/${sig}` : null;

          return (
            <div
              key={row._id}
              className={`flex items-center px-3 py-1.5 border-b border-border/40 transition-colors animate-fade-in ${bgClass}`}
            >
              <span
                className={`text-[10px] font-mono font-semibold w-16 uppercase ${colorClass}`}
              >
                {type.slice(0, 8)}
              </span>
              <span className="text-[10px] font-mono text-text-primary w-24 text-right">
                {formatAmount(row.event.amountA)}
              </span>
              <span className="text-[10px] font-mono text-text-secondary w-24 text-right">
                {formatAmount(row.event.amountB)}
              </span>
              <span className="w-20 text-right">
                {solscanUrl ? (
                  <a
                    href={solscanUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center text-[9px] font-mono px-1.5 py-0.5 rounded border border-cyan-400/35 text-cyan-200 hover:bg-cyan-400/10 hover:border-cyan-300/60 transition-colors"
                  >
                    Solscan
                  </a>
                ) : (
                  <span className="text-[9px] font-mono text-muted">—</span>
                )}
              </span>
              <span className="text-[10px] font-mono text-muted flex-1 text-right">
                {timeAgo(row.createdAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
