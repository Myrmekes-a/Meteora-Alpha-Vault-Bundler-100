"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLaunchState } from "@/lib/launchState";

interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface PoolEventRow {
  event?: {
    type?: string;
    eventType?: string;
    timestamp?: number;
    [key: string]: unknown;
  };
  createdAt?: string;
}

type ChartStyle = "candles" | "line" | "area";
type CandleApiResponse = { bars?: OhlcvBar[]; source?: string };

function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(10)}`;
}

function fmtPriceAxis(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(6);
  return value.toFixed(10);
}

function flatAutoscale(
  original: () => { priceRange?: { minValue: number; maxValue: number } } | null
): { priceRange?: { minValue: number; maxValue: number } } | null {
  const info = original();
  const range = info?.priceRange;
  if (!range) return info;
  if (Math.abs(range.maxValue - range.minValue) > 1e-15) return info;
  const pad = range.maxValue * 0.003 || 0.0000000001;
  return { priceRange: { minValue: range.minValue - pad, maxValue: range.maxValue + pad } };
}

function buildSyntheticCandles(basePrice: number, count: number, spacingSec = 60): OhlcvBar[] {
  const now = Math.floor(Date.now() / 1000);
  const bars: OhlcvBar[] = [];
  let prevClose = basePrice;

  for (let i = count - 1; i >= 0; i--) {
    const t = now - i * spacingSec;
    // Deterministic tiny random-walk to avoid repetitive "comb" pattern.
    const wave = Math.sin(t / 37) * 0.0009 + Math.cos(t / 73) * 0.0006;
    const drift = (Math.sin(t / 131) + Math.cos(t / 97)) * 0.0002;
    const nextClose = Math.max(basePrice * 0.9, prevClose * (1 + wave + drift));
    const open = prevClose;
    const close = nextClose;
    const wick = Math.max(basePrice * 0.0004, Math.abs(close - open) * 0.55);
    const high = Math.max(open, close) + wick;
    const low = Math.max(basePrice * 0.0000001, Math.min(open, close) - wick);

    bars.push({ time: t, open, high, low, close });
    prevClose = close;
  }

  return bars;
}


async function fetchCandles(
  primaryAddress: string,
  secondaryAddress?: string | null
): Promise<{ bars: OhlcvBar[]; source: string | null }> {
  // Main path: server-side Birdeye fetch.
  const tryFetch = async (address: string): Promise<{ bars: OhlcvBar[]; source: string | null }> => {
    try {
      const res = await fetch(`/api/chart-candles?address=${encodeURIComponent(address)}`);
      if (res.ok) {
        const payload = (await res.json()) as CandleApiResponse;
        if (Array.isArray(payload?.bars) && payload.bars.length > 0) {
          return { bars: payload.bars, source: payload.source ?? "birdeye" };
        }
      }
    } catch {
      // ignore and continue fallback
    }
    return { bars: [], source: null };
  };

  const primary = await tryFetch(primaryAddress);
  if (primary.bars.length > 0) return primary;

  if (secondaryAddress && secondaryAddress !== primaryAddress) {
    const secondary = await tryFetch(secondaryAddress);
    if (secondary.bars.length > 0) return secondary;
  }
  return primary;
}

async function fetchDerivedDevnetCandles(): Promise<OhlcvBar[]> {
  try {
    const [statsRes, settingsRes] = await Promise.all([
      fetch("/api/pool-stats"),
      fetch("/api/settings"),
    ]);
    if (!statsRes.ok || !settingsRes.ok) return [];
    const stats = await statsRes.json();
    const settings = await settingsRes.json();
    const isDevnet = String(settings?.CLUSTER ?? "").toLowerCase().trim() === "devnet";
    if (!isDevnet) return [];

    const price = Number(stats?.priceUsd ?? "0");
    if (!Number.isFinite(price) || price <= 0) return [];

    return buildSyntheticCandles(price, 34);
  } catch {
    return [];
  }
}

function isBuyEventType(raw: unknown): boolean {
  const t = String(raw ?? "").toLowerCase();
  return t.includes("buy") || t.includes("deposit") || t.includes("add");
}

async function fetchBuyMarkers(bars: OhlcvBar[]): Promise<Array<{ time: number; text: string }>> {
  if (bars.length === 0) return [];
  try {
    const res = await fetch("/api/pool-events?limit=200");
    if (!res.ok) return [];
    const rows = (await res.json()) as PoolEventRow[];
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const minTs = bars[0].time;
    const maxTs = bars[bars.length - 1].time;
    const markers: Array<{ time: number; text: string }> = [];
    const used = new Set<number>();

    for (const row of rows) {
      const evt = row?.event ?? {};
      const type = evt.type ?? evt.eventType ?? "";
      if (!isBuyEventType(type)) continue;
      const tsCandidate = Number(evt.timestamp ?? 0);
      let t = Number.isFinite(tsCandidate) && tsCandidate > 0
        ? Math.floor(tsCandidate)
        : Math.floor(new Date(row?.createdAt ?? "").getTime() / 1000);
      if (!Number.isFinite(t) || t <= 0) continue;
      if (t < minTs || t > maxTs) continue;
      if (used.has(t)) continue;
      used.add(t);
      markers.push({ time: t, text: "BUY" });
    }

    return markers.sort((a, b) => a.time - b.time).slice(-12);
  } catch {
    return [];
  }
}

export default function PriceChart() {
  const { launchState } = useLaunchState();
  const poolAddress = launchState?.poolAddress ?? null;
  const tokenAddress = launchState?.tokenMint ?? launchState?.tokenMintAddress ?? null;
  const chartAddress = poolAddress ?? tokenAddress;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<unknown>(null);
  const seriesRef = useRef<unknown>(null);
  const lastBarsRef = useRef<OhlcvBar[]>([]);
  const markersRef = useRef<Array<{ time: number; position: string; color: string; shape: string; text: string }>>([]);
  const [chartReady, setChartReady] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [lastPrice, setLastPrice] = useState<string | null>(null);
  const [isDerivedFallback, setIsDerivedFallback] = useState(false);
  const [dataSource, setDataSource] = useState<string | null>(null);
  const [buyMarkerCount, setBuyMarkerCount] = useState(0);
  const [chartStyle, setChartStyle] = useState<ChartStyle>("line");

  const applySeriesData = useCallback((series: unknown, bars: OhlcvBar[], style: ChartStyle) => {
    if (!series || bars.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = series as any;
    if (style === "candles") {
      s.setData(bars);
      return;
    }
    s.setData(bars.map((b) => ({ time: b.time, value: b.close })));
  }, []);

  const createSeries = useCallback((chart: unknown, style: ChartStyle): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = chart as any;
    if (style === "line") {
      return c.addLineSeries({
        color: "#5eead4",
        lineWidth: 2.6,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 5,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: "rgba(94,234,212,0.55)",
        priceFormat: {
          type: "custom",
          formatter: fmtPriceAxis,
          minMove: 0.0000000001,
        },
        autoscaleInfoProvider: (original: () => { priceRange?: { minValue: number; maxValue: number } } | null) => {
          return flatAutoscale(original);
        },
      });
    }
    if (style === "area") {
      return c.addAreaSeries({
        lineColor: "#22d3ee",
        lineWidth: 2.8,
        topColor: "rgba(6,182,212,0.35)",
        bottomColor: "rgba(6,182,212,0.03)",
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 5,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: "rgba(34,211,238,0.55)",
        priceFormat: {
          type: "custom",
          formatter: fmtPriceAxis,
          minMove: 0.0000000001,
        },
        autoscaleInfoProvider: (original: () => { priceRange?: { minValue: number; maxValue: number } } | null) =>
          flatAutoscale(original),
      });
    }
    return c.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#f43f5e",
      borderUpColor: "#10b981",
      borderDownColor: "#f43f5e",
      wickUpColor: "#10b981",
      wickDownColor: "#f43f5e",
      lastValueVisible: true,
      priceLineVisible: true,
      priceFormat: {
        type: "custom",
        formatter: fmtPriceAxis,
        minMove: 0.0000000001,
      },
      autoscaleInfoProvider: (original: () => { priceRange?: { minValue: number; maxValue: number } } | null) =>
        flatAutoscale(original),
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    let chart: unknown;
    let cleanup: (() => void) | null = null;

    import("lightweight-charts").then(({ createChart, ColorType, CrosshairMode }) => {
      if (!containerRef.current) return;

      chart = createChart(containerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: "#070b13" },
          textColor: "#a8b3cf",
        },
        grid: {
          vertLines: { color: "rgba(148,163,184,0.06)" },
          horzLines: { color: "rgba(148,163,184,0.06)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "rgba(148,163,184,0.22)", labelBackgroundColor: "#0f172a" },
          horzLine: { color: "rgba(148,163,184,0.22)", labelBackgroundColor: "#0f172a" },
        },
        rightPriceScale: {
          borderColor: "rgba(148,163,184,0.2)",
          scaleMargins: { top: 0.1, bottom: 0.12 },
        },
        timeScale: {
          borderColor: "rgba(148,163,184,0.2)",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 3,
          barSpacing: 7,
          minBarSpacing: 4.5,
        },
        width: containerRef.current.clientWidth,
        height: 390,
      });

      chartRef.current = chart;
      seriesRef.current = createSeries(chart, chartStyle);
      setChartReady(true);

      const ro = new ResizeObserver(() => {
        if (containerRef.current) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (chart as any).applyOptions({ width: containerRef.current.clientWidth });
        }
      });
      ro.observe(containerRef.current);

      cleanup = () => {
        ro.disconnect();
        setChartReady(false);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (chart as any).remove();
      };
    });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = chartRef.current as any;
    if (seriesRef.current && c.removeSeries) {
      c.removeSeries(seriesRef.current);
    }
    seriesRef.current = createSeries(chartRef.current, chartStyle);
    if (lastBarsRef.current.length > 0) {
      applySeriesData(seriesRef.current, lastBarsRef.current, chartStyle);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((seriesRef.current as any)?.setMarkers) (seriesRef.current as any).setMarkers(markersRef.current);
      c?.timeScale?.().fitContent?.();
    }
  }, [chartStyle, createSeries, applySeriesData]);

  useEffect(() => {
    if (!chartAddress || !seriesRef.current || !chartReady) return;

    async function load() {
      if (!chartAddress) return;
      const secondaryAddress = chartAddress === poolAddress ? tokenAddress : poolAddress;
      let bars = await fetchCandles(chartAddress, secondaryAddress);
      setDataSource(bars.source);
      let derived = false;
      if (bars.bars.length === 0) {
        const fallbackBars = await fetchDerivedDevnetCandles();
        derived = fallbackBars.length > 0;
        bars = { bars: fallbackBars, source: fallbackBars.length > 0 ? "devnet-derived" : bars.source };
      }
      if (bars.bars.length === 0) return;
      setIsDerivedFallback(derived);
      setHasData(true);
      setDataSource(bars.source);
      lastBarsRef.current = bars.bars;
      setLastPrice(fmtUsd(bars.bars[bars.bars.length - 1].close));
      applySeriesData(seriesRef.current, bars.bars, chartStyle);
      const buyEvents = await fetchBuyMarkers(bars.bars);
      const markers = buyEvents.map((m) => ({
        time: m.time,
        position: "belowBar",
        color: "#22c55e",
        shape: "arrowUp",
        text: m.text,
      }));
      markersRef.current = markers;
      setBuyMarkerCount(markers.length);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((seriesRef.current as any)?.setMarkers) (seriesRef.current as any).setMarkers(markers);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chartRef.current as any)?.timeScale?.().fitContent?.();
    }

    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [chartAddress, chartReady, chartStyle, applySeriesData]);

  useEffect(() => {
    setHasData(false);
    setLastPrice(null);
    setIsDerivedFallback(false);
    setDataSource(null);
    setBuyMarkerCount(0);
    markersRef.current = [];
  }, [chartAddress]);

  return (
    <div className="relative bg-[radial-gradient(120%_120%_at_80%_0%,rgba(14,116,144,0.16)_0%,rgba(7,11,19,0.9)_45%,rgba(7,11,19,1)_100%)] border border-slate-700/50 rounded-xl overflow-hidden flex-shrink-0 shadow-[0_16px_40px_rgba(0,0,0,0.42)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-cyan-300/6 via-transparent to-transparent" />
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/45">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-slate-300">
            Price Chart
          </span>
          {lastPrice && (
            <span className="text-base font-mono font-bold text-cyan-200">
              {lastPrice}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-1">
            {(["candles", "line", "area"] as ChartStyle[]).map((style) => (
              <button
                key={style}
                onClick={() => setChartStyle(style)}
                className={`text-[9px] font-mono px-2.5 py-1 rounded-md border transition-colors ${
                  chartStyle === style
                    ? "border-cyan-300/55 bg-cyan-400/18 text-cyan-100"
                    : "border-slate-600/70 text-slate-400 hover:text-slate-200"
                }`}
              >
                {style === "candles" ? "Candles" : style === "line" ? "Line" : "Area"}
              </button>
            ))}
          </div>
          
        </div>
      </div>

      {!hasData && chartAddress && (
        <div className="absolute inset-x-0 top-[50px] bottom-0 flex items-center justify-center pointer-events-none bg-[#070b13]/60 backdrop-blur-[1px]">
          <span className="text-xs font-mono text-slate-400">
            Waiting for price data…
          </span>
        </div>
      )}

      {!chartAddress && (
        <div className="flex items-center justify-center h-[390px]">
          <div className="text-center">
            <div className="text-slate-500 text-4xl mb-3">📊</div>
            <p className="text-sm font-mono text-slate-400">No pool launched yet</p>
            <p className="text-xs font-mono text-slate-500 mt-1">
              Create a pool to see live price data
            </p>
          </div>
        </div>
      )}

      <div ref={containerRef} className={chartAddress ? "h-[390px] w-full" : "hidden"} />
    </div>
  );
}
