export const CHART_HISTORY_COLLECTION = "chart_history";

export type ChartHistoryResolution = "1m";

export interface ChartHistoryEntry {
  recordKey: string;
  resolution: ChartHistoryResolution;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  source: "codex" | "pool-events";
  createdAt: string;
  updatedAt: string;
}
