import { NextResponse } from "next/server";
import { getMongoDb } from "@/lib/mongo";

export async function GET() {
  try {
    const db = await getMongoDb();
    // Find the most recently updated launch state regardless of key
    const doc = await db
      .collection("launch_states")
      .findOne({}, { sort: { updatedAt: -1 } });

    if (!doc) {
      return NextResponse.json(null);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, ...rest } = doc;
    return NextResponse.json(rest);
  } catch {
    // Graceful fallback: don't hard-fail UI polling when Mongo is unavailable.
    return NextResponse.json(null);
  }
}
