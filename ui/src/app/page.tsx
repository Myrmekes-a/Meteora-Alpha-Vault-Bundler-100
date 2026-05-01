"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Header from "@/components/Header";
import LaunchProgress from "@/components/LaunchProgress";
import LiveEvents from "@/components/LiveEvents";
import ActionsPanel from "@/components/ActionsPanel";
import BundlersPanel from "@/components/BundlersPanel";
import UtilitiesPanel from "@/components/UtilitiesPanel";
import SettingsModal from "@/components/modals/SettingsModal";

// Lazy load chart (uses browser APIs)
const PriceChart = dynamic(() => import("@/components/PriceChart"), {
  ssr: false,
  loading: () => (
    <div className="bg-card border border-border rounded-lg flex items-center justify-center h-[374px]">
      <div className="flex flex-col items-center gap-2">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-mono text-muted">Loading chart…</span>
      </div>
    </div>
  ),
});

type ModalType = "settings" | "replicator" | null;

export default function Dashboard() {
  const [modal, setModal] = useState<ModalType>(null);
  const [autoRunTrigger, setAutoRunTrigger] = useState(0);
  const [stopAutoRunTrigger, setStopAutoRunTrigger] = useState(0);
  const [autoModeEnabled, setAutoModeEnabled] = useState(false);
  const [progressVisible, setProgressVisible] = useState(true);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <Header
        onOpenSettings={() => setModal("settings")}
        onOpenActions={() => {
          if (autoModeEnabled) {
            setStopAutoRunTrigger((v) => v + 1);
            return;
          }
          setAutoRunTrigger((v) => v + 1);
        }}
        onOpenReplicator={() => setModal("replicator")}
        autoModeEnabled={autoModeEnabled}
      />

      {/* Main content */}
      <main className="flex-1 overflow-hidden p-3 gap-3 flex flex-col min-h-0">
        {/* Launch progress bar (collapsible with centered slide icon) */}
        <div className="relative">
          <div
            className={`overflow-hidden transition-all duration-300 ease-out ${
              progressVisible ? "max-h-[220px] opacity-100" : "max-h-0 opacity-0"
            }`}
          >
            <LaunchProgress />
          </div>
          <div className={`flex justify-center ${progressVisible ? "mt-1" : "mt-0"}`}>
            <button
              onClick={() => setProgressVisible((v) => !v)}
              className="w-10 h-5 rounded-full border border-border bg-bg/85 text-muted hover:text-text-primary hover:border-text-secondary transition-colors flex items-center justify-center"
              title={progressVisible ? "Hide launch progress" : "Show launch progress"}
              aria-label={progressVisible ? "Hide launch progress" : "Show launch progress"}
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                  progressVisible ? "rotate-180" : ""
                }`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body: left sidebar + chart/events + right sidebar */}
        <div className="flex-1 min-h-0 flex gap-3 overflow-hidden">

          {/* Left sidebar: post-launch tools + bundler wallets */}
          <div className="w-[27rem] flex-shrink-0 overflow-y-auto">
            <div className="flex flex-col gap-3 pb-2">
              <UtilitiesPanel />
              <BundlersPanel />
            </div>
          </div>

          {/* Center: chart + events */}
          <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">
            <PriceChart />
            <div className="flex-1 min-h-0 overflow-hidden">
              <LiveEvents />
            </div>
          </div>

          {/* Right sidebar: launch actions */}
          <div className="w-[22rem] flex-shrink-0 overflow-y-auto">
            <div className="flex flex-col gap-3 pb-2">
              <ActionsPanel
                autoRunTrigger={autoRunTrigger}
                stopAutoRunTrigger={stopAutoRunTrigger}
                onAutoModeChange={setAutoModeEnabled}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Modals */}
      <SettingsModal
        open={modal === "settings" || modal === "replicator"}
        onClose={() => setModal(null)}
        initialTab={modal === "replicator" ? "replicator" : "token"}
      />

    </div>
  );
}
