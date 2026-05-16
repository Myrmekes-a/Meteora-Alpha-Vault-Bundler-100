"use client";

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

export default function PoolSettings({ settings, onChange }: Props) {
  const tokenAAmount = Math.max(0, Number(settings.TOKEN_A_INPUT_AMOUNT_RAW ?? "0"));
  const tokenBAmount = Math.max(0, Number(settings.TOKEN_B_INPUT_AMOUNT_RAW ?? "0"));
  const initialMintSupply = Math.max(
    0,
    Number(settings.TOKEN_INITIAL_SUPPLY_RAW ?? "0")
  );
  const tokenDecimals = Math.max(0, Number(settings.TOKEN_DECIMALS ?? "6"));
  const tokenUnit = 10 ** tokenDecimals;

  // Token A rules are 1M~1B TOKENS, converted to raw by TOKEN_DECIMALS.
  const tokenAMin = 1_000_000 * tokenUnit;
  const tokenAMaxBySpec = 1_000_000_000 * tokenUnit;
  const tokenAMaxBySupply = initialMintSupply > 0 ? initialMintSupply : tokenAMaxBySpec;
  const tokenAMax = Math.max(tokenAMin, Math.min(tokenAMaxBySpec, tokenAMaxBySupply));
  const tokenBMin = 100_000_000; // 0.1 SOL in lamports

  const handleTokenABlur = () => {
    if (!Number.isFinite(tokenAAmount) || tokenAAmount <= 0) return;
    let next = tokenAAmount;
    if (next < tokenAMin) next = tokenAMin;
    if (next > tokenAMax) next = tokenAMax;
    if (next !== tokenAAmount) onChange("TOKEN_A_INPUT_AMOUNT_RAW", String(Math.floor(next)));
  };

  const handleTokenBBlur = () => {
    if (!Number.isFinite(tokenBAmount) || tokenBAmount <= 0) return;
    let next = tokenBAmount;
    if (next < tokenBMin) next = tokenBMin;
    if (next !== tokenBAmount) onChange("TOKEN_B_INPUT_AMOUNT_RAW", String(Math.floor(next)));
  };

  const tokenABelowMin = tokenAAmount > 0 && tokenAAmount < tokenAMin;
  const tokenAAboveMax = tokenAAmount > tokenAMax;
  const tokenBBelowMin = tokenBAmount > 0 && tokenBAmount < tokenBMin;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[10px] font-mono text-muted">
        DAMM v2 pool configuration
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
            Token A Amount (raw)
          </label>
          <input
            type="number"
            value={settings.TOKEN_A_INPUT_AMOUNT_RAW ?? ""}
            onChange={(e) => onChange("TOKEN_A_INPUT_AMOUNT_RAW", e.target.value)}
            onBlur={handleTokenABlur}
            placeholder="1000000"
            className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors placeholder:text-muted"
          />
          <span className="text-[9px] font-mono text-muted">
            Range: 1M ~ 1B tokens (raw with {tokenDecimals} decimals) and less than
            initial mint supply ({initialMintSupply || "unknown"} raw).
          </span>
          {tokenABelowMin && (
            <span className="text-[9px] font-mono text-danger">
              Minimum is 1,000,000 tokens ({tokenAMin.toLocaleString()} raw).
            </span>
          )}
          {tokenAAboveMax && (
            <span className="text-[9px] font-mono text-danger">
              Maximum allowed is {tokenAMax.toLocaleString()} raw.
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
            Token B Amount (raw)
          </label>
          <input
            type="number"
            value={settings.TOKEN_B_INPUT_AMOUNT_RAW ?? ""}
            onChange={(e) => onChange("TOKEN_B_INPUT_AMOUNT_RAW", e.target.value)}
            onBlur={handleTokenBBlur}
            placeholder="100000000"
            className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors placeholder:text-muted"
          />
          <span className="text-[9px] font-mono text-muted">
            Minimum: 0.1 SOL (100000000 lamports).
          </span>
          {tokenBBelowMin && (
            <span className="text-[9px] font-mono text-danger">Token B must be at least 0.1 SOL.</span>
          )}
        </div>
      </div>

      <ReadOnlyField
        label="Pool Activation Point (seconds from creation)"
        value={settings.POOL_ACTIVATION_POINT_TS ?? "7200"}
        hint="Read-only value"
      />

      <div className="grid grid-cols-2 gap-3">
        <Toggle
          label="Connect Alpha Vault"
          envKey="CONNECT_ALPHA_VAULT_POOL"
          settings={settings}
          onChange={onChange}
          hint="Enable alpha vault on this pool"
        />
        <Toggle
          label="Lock Liquidity"
          envKey="IS_LOCK_LIQUIDITY"
          settings={settings}
          onChange={onChange}
          hint="Lock LP position permanently"
        />
      </div>

      <Toggle
        label="DRY RUN Mode"
        envKey="DRY_RUN"
        settings={settings}
        onChange={onChange}
        hint="Prepare transactions without sending. Set false to execute on-chain."
      />
    </div>
  );
}
