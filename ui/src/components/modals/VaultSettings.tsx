"use client";

import { useEffect, useMemo, useState } from "react";
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

function SelectField({
  label,
  envKey,
  options,
  settings,
  onChange,
  hint,
}: {
  label: string;
  envKey: string;
  options: { value: string; label: string }[];
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
        {label}
      </label>
      <select
        value={settings[envKey] ?? ""}
        onChange={(e) => onChange(envKey, e.target.value)}
        className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
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

export default function VaultSettings({ settings, onChange }: Props) {
  const [distributedWallets, setDistributedWallets] = useState<string[]>([]);
  const whitelistMode = (settings.ALPHA_FCFS_WHITELIST_MODE ?? "permissionless").toLowerCase();

  useEffect(() => {
    let active = true;
    async function loadWallets() {
      try {
        const res = await fetch("/api/bundlers");
        if (!res.ok) return;
        const data = await res.json();
        if (!active) return;

        // API may return payload object or array depending on artifact shape.
        const raw =
          Array.isArray(data?.wallets)
            ? data.wallets
            : Array.isArray(data?.wallets?.wallets)
              ? data.wallets.wallets
              : [];

        const keys = raw
          .map((w: { publicKey?: string }) => w?.publicKey)
          .filter((k: unknown): k is string => typeof k === "string");

        setDistributedWallets(keys);
      } catch {
        // ignore
      }
    }

    loadWallets();
    return () => {
      active = false;
    };
  }, []);

  const whitelistCsv = useMemo(
    () => distributedWallets.join(","),
    [distributedWallets]
  );

  useEffect(() => {
    if (whitelistMode !== "whitelist") return;
    // Persist selected whitelist wallets into settings when whitelist mode is enabled.
    onChange("ALPHA_FCFS_WHITELIST_WALLETS", whitelistCsv);
  }, [whitelistMode, whitelistCsv, onChange]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[10px] font-mono text-muted">
        Alpha Vault FCFS configuration
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Max Depositing Cap (raw)"
          envKey="ALPHA_FCFS_MAX_DEPOSITING_CAP_RAW"
          settings={settings}
          onChange={onChange}
          type="number"
          placeholder="1000000000"
          hint="Max total deposit. Lamports for WSOL, 6-dec for USDC."
        />
        <Field
          label="Individual Cap (raw)"
          envKey="ALPHA_FCFS_INDIVIDUAL_CAP_RAW"
          settings={settings}
          onChange={onChange}
          type="number"
          placeholder="1000000000"
          hint="Per-wallet deposit limit"
        />
      </div>

      <SelectField
        label="Whitelist Mode"
        envKey="ALPHA_FCFS_WHITELIST_MODE"
        settings={settings}
        onChange={onChange}
        options={[
          { value: "permissionless", label: "Permissionless (anyone can deposit)" },
          { value: "permission_with_authority", label: "Whitelist only" },
        ]}
        hint="Controls who can deposit to the vault"
      />

      {whitelistMode === "whitelist" && (
        <div className="p-3 bg-bg/50 rounded border border-border/60">
          <p className="text-[10px] font-mono text-text-secondary">
            Whitelist-only mode enabled. Current distribution wallets are used as
            whitelist wallets.
          </p>
          <div className="mt-2 max-h-32 overflow-y-auto border border-border rounded bg-bg/40">
            {distributedWallets.length === 0 ? (
              <div className="px-3 py-2 text-[10px] font-mono text-warn">
                No distribution wallets found yet. Run distribute first.
              </div>
            ) : (
              distributedWallets.map((pk, idx) => (
                <div
                  key={pk}
                  className="px-3 py-1.5 text-[10px] font-mono text-text-primary border-b last:border-b-0 border-border/40"
                >
                  #{idx + 1} {pk}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <ReadOnlyField
          label="Deposit Open Buffer (sec)"
          value={settings.ALPHA_FCFS_DEPOSIT_OPEN_BUFFER_SEC ?? "900"}
          hint="Read-only value"
        />
        <ReadOnlyField
          label="Claim Lock After Activation (sec)"
          value={settings.ALPHA_FCFS_CLAIM_LOCK_AFTER_ACTIVATION_SEC ?? "1800"}
          hint="Read-only value"
        />
      </div>

      <ReadOnlyField
        label="Fill Buffer Before Activation (sec)"
        value={settings.FILL_BUFFER_SEC_BEFORE_ACTIVATION ?? "40"}
        hint="Read-only value"
      />
    </div>
  );
}
