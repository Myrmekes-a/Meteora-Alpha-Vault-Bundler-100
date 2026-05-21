import { NextRequest, NextResponse } from "next/server";
import { getMongoDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get("limit") ?? "50", 10);

    const db = await getMongoDb();
    const events = await db
      .collection("pool_events")
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return NextResponse.json(
      events.map(({ _id, ...rest }) => ({ _id: _id.toString(), ...rest }))
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
