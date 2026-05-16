"use client";

import { useMemo } from "react";
import type { EnvSettings } from "@/lib/types";

interface Props {
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
}

function Field({
  label,
  envKey,
  settings,
  onChange,
  type = "text",
  placeholder,
  hint,
}: {
  label: string;
  envKey: string;
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
        {label}
      </label>
      <input
        type={type}
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

function Toggle({
  label,
  envKey,
  settings,
  onChange,
  hint,
}: {
  label: string;
  envKey: string;
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
  hint?: string;
}) {
  const value = (settings[envKey] ?? "false").toLowerCase();
  const checked = value === "true";

  return (
    <div className="flex items-start justify-between gap-3 p-3 bg-bg rounded border border-border">
      <div>
        <div className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
          {label}
        </div>
        {hint && (
          <div className="text-[9px] font-mono text-muted mt-0.5">{hint}</div>
        )}
      </div>
      <button
        onClick={() => onChange(envKey, checked ? "false" : "true")}
        className={`flex-shrink-0 w-10 h-5 rounded-full transition-colors relative ${
          checked ? "bg-accent" : "bg-border"
        }`}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function lamportsToSol(lamports: number): string {
  if (!Number.isFinite(lamports)) return "0.0000";
  return (lamports / 1_000_000_000).toFixed(4);
}

export default function DistributionSettings({ settings, onChange }: Props) {
  const minDepositLamports = 100_000_000; // 0.1 SOL
  const walletCount = Math.max(1, Number(settings.DISTRIBUTION_WALLET_COUNT ?? "1"));
  const totalDepositLamports = Math.max(
    0,
    Number(settings.DISTRIBUTION_TOTAL_DEPOSIT_RAW ?? "0")
  );
  const maxCapLamports = Math.max(
    0,
    Number(settings.ALPHA_FCFS_MAX_DEPOSITING_CAP_RAW ?? "0")
  );
  const isRandomize =
    (settings.DISTRIBUTION_RANDOMIZE_AMOUNTS ?? "false").toLowerCase() ===
    "true";
  const walletBufferLamports = Math.max(
    0,
    Number(settings.DISTRIBUTION_WALLET_SOL_FEE_BUFFER_LAMPORTS ?? "0")
  );
  const mainReserveLamports = Math.max(
    0,
    Number(settings.MAIN_WALLET_FEE_RESERVE_LAMPORTS ?? "0")
  );

  const isBelowMin =
    totalDepositLamports > 0 && totalDepositLamports < minDepositLamports;
  const isAboveCap =
    maxCapLamports > 0 && totalDepositLamports > maxCapLamports;

  const rangeText = useMemo(() => {
    if (maxCapLamports > 0) {
      return `${lamportsToSol(minDepositLamports)} ~ ${lamportsToSol(maxCapLamports)} SOL`;
    }
    return `${lamportsToSol(minDepositLamports)} SOL minimum`;
  }, [maxCapLamports]);

  const equalPerWalletLamports = Math.floor(totalDepositLamports / walletCount);
  const totalBuffersLamports = walletCount * walletBufferLamports + mainReserveLamports;
  const estimatedRequiredLamports = totalDepositLamports + totalBuffersLamports;

  const handleTotalDepositBlur = () => {
    if (!Number.isFinite(totalDepositLamports) || totalDepositLamports <= 0) return;
    let next = totalDepositLamports;
    if (next < minDepositLamports) next = minDepositLamports;
    if (maxCapLamports > 0 && next > maxCapLamports) next = maxCapLamports;
    if (next !== totalDepositLamports) {
      onChange("DISTRIBUTION_TOTAL_DEPOSIT_RAW", String(next));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[10px] font-mono text-muted">
        Bundler wallet distribution configuration
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Wallet Count"
          envKey="DISTRIBUTION_WALLET_COUNT"
          settings={settings}
          onChange={onChange}
          type="number"
          placeholder="10"
          hint="Number of distribution wallets to create"
        />

        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
            Total Deposit (raw lamports)
          </label>
          <input
            type="number"
            value={settings.DISTRIBUTION_TOTAL_DEPOSIT_RAW ?? ""}
            onChange={(e) =>
              onChange("DISTRIBUTION_TOTAL_DEPOSIT_RAW", e.target.value)
            }
            onBlur={handleTotalDepositBlur}
            placeholder="100000000"
            className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors placeholder:text-muted"
          />
          <span className="text-[9px] font-mono text-muted">
            Range: {rangeText}
            {settings.DISTRIBUTION_TOTAL_DEPOSIT_RAW
              ? ` | Current ≈ ${lamportsToSol(totalDepositLamports)} SOL`
              : ""}
          </span>
          {isBelowMin && (
            <span className="text-[9px] font-mono text-danger">
              Minimum is 0.1 SOL (100000000 lamports).
            </span>
          )}
          {isAboveCap && (
            <span className="text-[9px] font-mono text-danger">
              Must be lower than ALPHA_FCFS_MAX_DEPOSITING_CAP_RAW.
            </span>
          )}
        </div>
      </div>

      <Toggle
        label="Randomize Amounts"
        envKey="DISTRIBUTION_RANDOMIZE_AMOUNTS"
        settings={settings}
        onChange={onChange}
        hint="ON: random per-wallet amounts. OFF: equal per-wallet amount (total/wallet count)."
      />

      <div className="p-3 bg-bg/40 rounded border border-border/60">
        <p className="text-[10px] font-mono text-text-secondary leading-relaxed">
          {isRandomize ? (
            <>
              Randomize is <span className="text-accent">ON</span>. Wallet deposit
              amounts are randomized, but total remains{" "}
              <span className="text-warn">{lamportsToSol(totalDepositLamports)} SOL</span>.
            </>
          ) : (
            <>
              Randomize is <span className="text-warn">OFF</span>. Each wallet
              deposit = total / wallet count ={" "}
              <span className="text-accent">{lamportsToSol(equalPerWalletLamports)} SOL</span>{" "}
              ({equalPerWalletLamports} lamports).
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ReadOnlyField
          label="Wallet Fee Buffer (lamports)"
          value={settings.DISTRIBUTION_WALLET_SOL_FEE_BUFFER_LAMPORTS ?? "20000000"}
          hint={`Display only | ≈ ${lamportsToSol(walletBufferLamports)} SOL per wallet`}
        />
        <ReadOnlyField
          label="Main Wallet Reserve (lamports)"
          value={settings.MAIN_WALLET_FEE_RESERVE_LAMPORTS ?? "50000000"}
          hint={`Display only | ≈ ${lamportsToSol(mainReserveLamports)} SOL`}
        />
      </div>

      <div className="p-3 bg-bg/50 rounded border border-border/60">
        <p className="text-[10px] font-mono text-muted leading-relaxed">
          <span className="text-warn">Buffer-aware estimate:</span> main wallet
          should cover deposit + per-wallet fee buffers + reserve.
        </p>
        <div className="mt-2 grid grid-cols-1 gap-1 text-[10px] font-mono text-text-secondary">
          <div>
            Deposit total:{" "}
            <span className="text-accent">{lamportsToSol(totalDepositLamports)} SOL</span>
          </div>
          <div>
            Total buffers ({walletCount} x wallet buffer + reserve):{" "}
            <span className="text-warn">{lamportsToSol(totalBuffersLamports)} SOL</span>
          </div>
          <div>
            Estimated required in main wallet:{" "}
            <span className="text-text-primary">
              {lamportsToSol(estimatedRequiredLamports)} SOL
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
