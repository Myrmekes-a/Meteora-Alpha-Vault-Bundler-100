"use client";

import { useEffect, useMemo, useState } from "react";
import type { EnvSettings } from "@/lib/types";

interface Props {
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
}

function NumberField({
  label,
  envKey,
  settings,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  envKey: string;
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
        {label}
      </label>
      <input
        type="number"
        value={settings[envKey] ?? ""}
        onChange={(e) => onChange(envKey, e.target.value)}
        placeholder={placeholder}
        className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors placeholder:text-muted"
      />
      {hint && <span className="text-[9px] font-mono text-muted">{hint}</span>}
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
        {label}
      </label>
      <input
        type="text"
        value={value}
        readOnly
        className="bg-bg/60 border border-border rounded px-3 py-2 text-xs font-mono text-muted cursor-not-allowed"
      />
      {hint && <span className="text-[9px] font-mono text-muted">{hint}</span>}
    </div>
  );
}

function SliderField({
  label,
  envKey,
  settings,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  unit = "%",
  hint,
}: {
  label: string;
  envKey: string;
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
}) {
  const rawValue = settings[envKey] ?? "0";
  const parsed = parseFloat(rawValue);
  const numValue = Number.isFinite(parsed) ? parsed : 0;
  const normalizedPercent = unit === "%" ? (numValue <= 1 ? numValue * 100 : numValue) : numValue;
  const displayValue = unit === "%" ? normalizedPercent.toFixed(0) : numValue.toFixed(2);
  const sliderValue = unit === "%" ? normalizedPercent : numValue;

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    const stored = unit === "%" ? String(v) : v.toString();
    onChange(envKey, stored);
  };

  const pct = ((sliderValue - min) / (max - min)) * 100;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
          {label}
        </label>
        <span className="text-sm font-mono font-bold text-accent">
          {displayValue}{unit}
        </span>
      </div>
      <div className="relative h-6 flex items-center">
        <div className="absolute left-0 right-0 h-1 bg-border rounded-full">
          <div
            className="h-full bg-accent rounded-full"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={sliderValue}
          onChange={handleSlider}
          className="relative w-full h-1 opacity-0 cursor-pointer"
          style={{ zIndex: 1 }}
        />
        <div
          className="absolute w-4 h-4 bg-accent rounded-full border-2 border-bg shadow-lg pointer-events-none"
          style={{ left: `calc(${pct}% - 8px)` }}
        />
      </div>
      {hint && <span className="text-[9px] font-mono text-muted">{hint}</span>}
    </div>
  );
}

export default function ReplicatorSettings({ settings, onChange }: Props) {
  const [buyCount, setBuyCount] = useState(0);
  const [sellCount, setSellCount] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadCounts() {
      try {
        const res = await fetch("/api/pool-events?limit=200");
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{ event?: { eventType?: string } }>;
        if (!active) return;
        let buys = 0;
        let sells = 0;
        for (const row of rows) {
          const t = String(row?.event?.eventType ?? "").toLowerCase();
          if (t.includes("buy")) buys += 1;
          if (t.includes("sell")) sells += 1;
        }
        setBuyCount(buys);
        setSellCount(sells);
      } catch {
        // ignore
      }
    }
    loadCounts();
    const id = setInterval(loadCounts, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const slippagePercent = useMemo(() => {
    const bps = Number(settings.SLIPPAGE_BPS ?? "100");
    if (!Number.isFinite(bps)) return "1.00";
    return (bps / 100).toFixed(2);
  }, [settings.SLIPPAGE_BPS]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[10px] font-mono text-muted">
        Auto-swap replicator configuration (listen:pool)
      </p>

      <NumberField
        label="Target Buy Amount (SOL)"
        envKey="TARGET_BUY_AMOUNT"
        settings={settings}
        onChange={onChange}
        placeholder="0.01"
        hint="Amount in SOL to spend on each replicator buy"
      />

      <div className="space-y-6">
        <SliderField
          label="Sell Percentage"
          envKey="SELL_PERCENTAGE"
          settings={settings}
          onChange={onChange}
          min={0}
          max={100}
          step={1}
          unit="%"
          hint="Percentage of holdings to sell on each replicator sell signal"
        />

        <SliderField
          label="Buy Percentage"
          envKey="BUY_PERCENTAGE"
          settings={settings}
          onChange={onChange}
          min={0}
          max={100}
          step={1}
          unit="%"
          hint="Percentage of target buy amount used on each buy signal"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Wallet Numbers"
          envKey="REPLICATOR_WALLET_COUNT"
          settings={settings}
          onChange={onChange}
          placeholder="5"
          hint="Random wallet count used from deposited wallets per trigger"
        />
        <NumberField
          label="Slippage (%)"
          envKey="SLIPPAGE_BPS"
          settings={settings}
          onChange={onChange}
          placeholder="100"
          hint={`Editable. Stored in bps. Current: ${slippagePercent}%`}
        />
      </div>

      <ReadOnlyField
        label="Fill Buffer (sec before activation)"
        value={settings.FILL_BUFFER_SEC_BEFORE_ACTIVATION ?? "40"}
        hint="Display only"
      />

      <div className="p-3 bg-accent/5 rounded border border-accent/20">
        <p className="text-[10px] font-mono text-accent/80 leading-relaxed">
          <span className="font-bold text-accent">Replicator</span> mirrors
          buy/sell activity from real wallets using distribution wallets. It
          listens for pool events and executes matching trades to simulate
          organic activity.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded border border-border bg-bg/50 px-2 py-1">
            <div className="text-[9px] font-mono text-text-secondary uppercase">Buy Txs</div>
            <div className="text-sm font-mono text-accent">{buyCount}</div>
          </div>
          <div className="rounded border border-border bg-bg/50 px-2 py-1">
            <div className="text-[9px] font-mono text-text-secondary uppercase">Sell Txs</div>
            <div className="text-sm font-mono text-danger">{sellCount}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
