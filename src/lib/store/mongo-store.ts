import type { Collection } from "mongodb";
import type { DistributionWallet, LaunchState } from "../types";
import { getMongoDb } from "./mongo";
import type {
  ArtifactDoc,
  ArtifactKind,
  DistributionWalletsPayload,
  LaunchStateDoc,
  PoolEventDoc,
} from "./types";

let indexesReady = false;

const LAUNCH_STATES_COLLECTION = "launch_states";
const ARTIFACTS_COLLECTION = "artifacts";
const POOL_EVENTS_COLLECTION = "pool_events";

async function launchStatesCollection(): Promise<Collection<LaunchStateDoc>> {
  const db = await getMongoDb();
  return db.collection<LaunchStateDoc>(LAUNCH_STATES_COLLECTION);
}

async function artifactsCollection(): Promise<Collection<ArtifactDoc>> {
  const db = await getMongoDb();
  return db.collection<ArtifactDoc>(ARTIFACTS_COLLECTION);
}

async function poolEventsCollection(): Promise<Collection<PoolEventDoc>> {
  const db = await getMongoDb();
  return db.collection<PoolEventDoc>(POOL_EVENTS_COLLECTION);
}

export async function ensureMongoIndexes(): Promise<void> {
  if (indexesReady) return;

  const [launch, artifacts, events] = await Promise.all([
    launchStatesCollection(),
    artifactsCollection(),
    poolEventsCollection(),
  ]);

  await Promise.all([
    launch.createIndex({ recordKey: 1 }, { unique: true }),
    artifacts.createIndex({ kind: 1, recordKey: 1 }, { unique: true }),
    events.createIndex({ recordKey: 1, createdAt: -1 }),
  ]);
  // Prevent duplicate tx events for the same listener stream key.
  // If legacy duplicates already exist, keep app running and rely on upsert-based dedupe.
  try {
    await events.createIndex(
      { recordKey: 1, "event.signature": 1 },
      {
        unique: true,
        partialFilterExpression: { "event.signature": { $exists: true, $type: "string" } },
      }
    );
  } catch {
    // ignore index creation error on old duplicate data
  }

  indexesReady = true;
}

export async function getLaunchStateByKey(recordKey: string): Promise<LaunchState | null> {
  await ensureMongoIndexes();
  const launch = await launchStatesCollection();
  const doc = await launch.findOne({ recordKey });
  if (!doc) return null;
  // Strip persistence-only fields.
  const { recordKey: _, createdAt: __, ...state } = doc;
  return state as LaunchState;
}

export async function upsertLaunchStateByKey(recordKey: string, state: LaunchState): Promise<void> {
  await ensureMongoIndexes();
  const launch = await launchStatesCollection();
  const now = new Date().toISOString();
  await launch.updateOne(
    { recordKey },
    {
      $set: {
        ...state,
        recordKey,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

export async function createLaunchStateIfMissing(recordKey: string, state: LaunchState): Promise<boolean> {
  await ensureMongoIndexes();
  const launch = await launchStatesCollection();
  const now = new Date().toISOString();
  const res = await launch.updateOne(
    { recordKey },
    {
      $setOnInsert: {
        ...state,
        recordKey,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true }
  );
  return res.upsertedCount > 0;
}

export async function saveArtifactByKey<T extends Record<string, unknown>>(
  kind: ArtifactKind,
  recordKey: string,
  payload: T
): Promise<void> {
  await ensureMongoIndexes();
  const artifacts = await artifactsCollection();
  const now = new Date().toISOString();
  await artifacts.updateOne(
    { kind, recordKey },
    {
      $set: { payload, updatedAt: now },
      $setOnInsert: { kind, recordKey, createdAt: now },
    },
    { upsert: true }
  );
}

export async function getArtifactByKey<T extends Record<string, unknown>>(
  kind: ArtifactKind,
  recordKey: string
): Promise<T | null> {
  await ensureMongoIndexes();
  const artifacts = await artifactsCollection();
  const doc = await artifacts.findOne({ kind, recordKey });
  return (doc?.payload as T | undefined) ?? null;
}

export async function saveDistributionWalletsByKey(
  recordKey: string,
  wallets: DistributionWalletsPayload
): Promise<void> {
  await saveArtifactByKey("distribution-wallets", recordKey, { wallets });
}

export async function getDistributionWalletsByKey(recordKey: string): Promise<DistributionWallet[] | null> {
  const payload = await getArtifactByKey<{ wallets?: DistributionWallet[] }>("distribution-wallets", recordKey);
  return payload?.wallets ?? null;
}

export async function saveMiddleWalletsByKey(
  recordKey: string,
  middleWallets: Array<Record<string, unknown>>
): Promise<void> {
  await saveArtifactByKey("middle-wallets", recordKey, { wallets: middleWallets });
}

export async function appendPoolEvent(recordKey: string, event: Record<string, unknown>): Promise<void> {
  await ensureMongoIndexes();
  const events = await poolEventsCollection();
  const signature = typeof event.signature === "string" ? event.signature.trim() : "";
  if (signature) {
    await events.updateOne(
      { recordKey, "event.signature": signature },
      {
        $setOnInsert: {
          recordKey,
          event,
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true }
    );
    return;
  }
  await events.insertOne({
    recordKey,
    event,
    createdAt: new Date().toISOString(),
  });
}
