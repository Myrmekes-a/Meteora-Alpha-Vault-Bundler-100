import { NextRequest, NextResponse } from "next/server";
import { getMongoDb } from "@/lib/mongo";
import type { UiSettingsDoc } from "@/lib/types";

const HIDDEN_KEYS = new Set([
  "WALLET_SECRET_KEY",
  "PINATA_API_KEY",
  "PINATA_SECRET_API_KEY",
  "LASERSTREAM_API_KEY",
  "BIRDEYE_API_KEY",
  "MONGODB_URI",
]);
const SETTINGS_COLLECTION = "settings";
const SETTINGS_RECORD_KEY = "ui-settings";

function filterVisibleSettings(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!HIDDEN_KEYS.has(k)) out[k] = v;
  }
  return out;
}

async function getSettingsCollection() {
  const db = await getMongoDb();
  const collection = db.collection<UiSettingsDoc>(SETTINGS_COLLECTION);
  await collection.createIndex({ recordKey: 1 }, { unique: true });
  return collection;
}

async function loadSettingsFromDb(): Promise<Record<string, string> | null> {
  const collection = await getSettingsCollection();
  const doc = await collection.findOne({ recordKey: SETTINGS_RECORD_KEY });
  return doc?.values ?? null;
}

async function saveSettingsToDb(values: Record<string, string>): Promise<void> {
  const collection = await getSettingsCollection();
  const now = new Date().toISOString();
  await collection.updateOne(
    { recordKey: SETTINGS_RECORD_KEY },
    {
      $set: {
        values,
        updatedAt: now,
      },
      $setOnInsert: {
        recordKey: SETTINGS_RECORD_KEY,
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

export async function GET() {
  try {
    const dbValues = filterVisibleSettings((await loadSettingsFromDb()) ?? {});
    return NextResponse.json(dbValues);
  } catch {
    return NextResponse.json({}, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const updates: { key: string; value: string }[] = body.updates ?? [];
    const visibleUpdates = updates.filter((u) => !HIDDEN_KEYS.has(u.key));
    const current = filterVisibleSettings((await loadSettingsFromDb()) ?? {});
    for (const { key, value } of visibleUpdates) {
      current[key] = value;
    }

    await saveSettingsToDb(current);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
