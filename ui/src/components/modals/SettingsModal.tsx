"use client";

import { useEffect, useState, useCallback } from "react";
import type { EnvSettings } from "@/lib/types";
import TokenSettings from "./TokenSettings";
import PoolSettings from "./PoolSettings";
import VaultSettings from "./VaultSettings";
import DistributionSettings from "./DistributionSettings";
import ReplicatorSettings from "./ReplicatorSettings";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  initialTab?: TabId;
}

const TABS = [
  { id: "token", label: "Token" },
  { id: "pool", label: "Pool" },
  { id: "vault", label: "Alpha Vault" },
  { id: "distribution", label: "Distribution" },
  { id: "replicator", label: "Replicator" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function SettingsModal({ open, onClose, initialTab = "token" }: SettingsModalProps) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [settings, setSettings] = useState<EnvSettings>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Record<string, string>>({});

  const loadSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (res.ok) setSettings(await res.json());
  }, []);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      loadSettings();
      setPendingChanges({});
    }
  }, [open, loadSettings, initialTab]);

  const handleChange = useCallback((key: string, value: string) => {
    setPendingChanges((prev) => ({ ...prev, [key]: value }));
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const updates = Object.entries(pendingChanges).map(([key, value]) => ({
      key,
      value,
    }));
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      setPendingChanges({});
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (!open) return null;

  const hasChanges = Object.keys(pendingChanges).length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-sm font-mono font-bold text-text-primary">
              Settings
            </h2>
            <p className="text-[10px] font-mono text-text-secondary mt-0.5">
              Editing parent project .env file
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text-primary transition-colors p-1 rounded"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border px-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-[11px] font-mono font-semibold uppercase tracking-wider border-b-2 transition-all -mb-px ${
                tab === t.id
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === "token" && (
            <TokenSettings settings={settings} onChange={handleChange} />
          )}
          {tab === "pool" && (
            <PoolSettings settings={settings} onChange={handleChange} />
          )}
          {tab === "vault" && (
            <VaultSettings settings={settings} onChange={handleChange} />
          )}
          {tab === "distribution" && (
            <DistributionSettings settings={settings} onChange={handleChange} />
          )}
          {tab === "replicator" && (
            <ReplicatorSettings settings={settings} onChange={handleChange} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border">
          <span className="text-[10px] font-mono text-muted">
            {hasChanges
              ? `${Object.keys(pendingChanges).length} unsaved change(s)`
              : saved
                ? "✓ Saved successfully"
                : "No changes"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-mono text-muted border border-border rounded hover:text-text-primary transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || saving}
              className={`px-4 py-1.5 text-xs font-mono font-semibold rounded transition-all ${
                hasChanges && !saving
                  ? "bg-accent text-bg hover:bg-accent/80"
                  : "bg-border text-muted cursor-not-allowed"
              }`}
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
