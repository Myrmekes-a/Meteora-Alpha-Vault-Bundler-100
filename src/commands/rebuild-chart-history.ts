import "dotenv/config";

import type { WithId } from "mongodb";
import { closeMongoClient, getMongoDb } from "../lib/store/mongo";

type ChartHistoryDoc = {
  recordKey?: string;
  resolution?: string;
  time?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  source?: "codex" | "pool-events";
  createdAt?: string;
  updatedAt?: string;
};

function isNewer(a?: string, b?: string): boolean {
  if (!a && !b) return false;
  if (!a) return false;
  if (!b) return true;
  return new Date(a).getTime() > new Date(b).getTime();
}

async function main(): Promise<void> {
  const db = await getMongoDb();
  const col = db.collection<ChartHistoryDoc>("chart_history");

  const all = (await col.find({}).toArray()) as WithId<ChartHistoryDoc>[];
  console.log(`Loaded ${all.length} chart_history rows`);
  if (all.length === 0) {
    console.log("No rows to rebuild.");
    return;
  }

  // 1) Deduplicate by (recordKey, resolution, time), keeping latest updatedAt.
  const byPair = new Map<string, Map<number, WithId<ChartHistoryDoc>>>();
  for (const row of all) {
    const recordKey = String(row.recordKey ?? "").trim();
    const resolution = String(row.resolution ?? "1m").trim() || "1m";
    const time = Number(row.time ?? 0);
    const close = Number(row.close ?? 0);
    if (!recordKey || !Number.isFinite(time) || time <= 0 || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    const pairKey = `${recordKey}::${resolution}`;
    let m = byPair.get(pairKey);
    if (!m) {
      m = new Map<number, WithId<ChartHistoryDoc>>();
      byPair.set(pairKey, m);
    }
    const existing = m.get(time);
    if (!existing || isNewer(row.updatedAt, existing.updatedAt)) {
      m.set(time, row);
    }
  }

  // 2) Keep only meaningful price changes (drop same-price consecutive rows).
  const out: ChartHistoryDoc[] = [];
  const nowIso = new Date().toISOString();
  const epsilonBase = 1e-18;
  for (const [pairKey, mapByTime] of byPair.entries()) {
    const [recordKey, resolution] = pairKey.split("::");
    const rows = [...mapByTime.values()].sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0));
    let prevClose = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const close = Number(r.close ?? 0);
      if (!Number.isFinite(close) || close <= 0) continue;
      if (i > 0) {
        const sameClose = Math.abs(close - prevClose) <= Math.max(epsilonBase, prevClose * 1e-8);
        if (sameClose) continue;
      }
      const open = Number(r.open ?? close);
      const high = Number(r.high ?? close);
      const low = Number(r.low ?? close);
      out.push({
        recordKey,
        resolution,
        time: Number(r.time ?? 0),
        open: Number.isFinite(open) && open > 0 ? open : close,
        high: Number.isFinite(high) && high > 0 ? high : close,
        low: Number.isFinite(low) && low > 0 ? low : close,
        close,
        volume: Number.isFinite(Number(r.volume ?? 0)) ? Number(r.volume ?? 0) : 0,
        source: r.source === "pool-events" ? "pool-events" : "codex",
        createdAt: r.createdAt ?? nowIso,
        updatedAt: nowIso,
      });
      prevClose = close;
    }
  }

  // 3) Rewrite collection with filtered rows.
  await col.deleteMany({});
  if (out.length > 0) {
    await col.insertMany(out, { ordered: false });
  }

  // 4) Recreate indexes for serving path.
  await Promise.all([
    col.createIndex({ recordKey: 1, resolution: 1, time: 1 }, { unique: true }),
    col.createIndex({ recordKey: 1, time: -1 }),
  ]);

  console.log(`Rebuilt chart_history: ${all.length} -> ${out.length}`);
}

main()
  .finally(() => closeMongoClient())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

