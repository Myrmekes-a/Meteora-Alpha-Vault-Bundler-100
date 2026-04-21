import { Db, MongoClient } from "mongodb";
import { getEnvOrDefault, getRequiredEnv } from "../utils";

let clientPromise: Promise<MongoClient> | null = null;

async function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    const uri = getRequiredEnv("MONGODB_URI");
    const client = new MongoClient(uri, {
      maxPoolSize: 20,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 20000,
      connectTimeoutMS: 10000,
      family: 4,
    });
    clientPromise = client.connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  const dbName = getEnvOrDefault("MONGODB_DB_NAME", "meteora_alpha_vault_bundler");
  return client.db(dbName);
}

export async function closeMongoClient(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    clientPromise = null;
    await client.close();
  }
}
