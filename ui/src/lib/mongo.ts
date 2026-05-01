import { Db, MongoClient } from "mongodb";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

let clientPromise: Promise<MongoClient> | null = null;

function loadParentEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), "..", ".env");
  if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    return parsed;
  }
  return {};
}

function getMongoUri(): string {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const env = loadParentEnv();
  return env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
}

function getDbName(): string {
  if (process.env.MONGODB_DB_NAME) return process.env.MONGODB_DB_NAME;
  const env = loadParentEnv();
  return env.MONGODB_DB_NAME ?? "meteora_alpha_vault_bundler";
}

async function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    const uri = getMongoUri();
    const client = new MongoClient(uri, {
      maxPoolSize: 20,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 20000,
      connectTimeoutMS: 10000,
      family: 4, // Atlas is more stable over IPv4 in some environments.
    });
    clientPromise = client.connect().catch((err) => {
      // Important: clear cached rejected promise so next request can retry.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getDbName());
}
