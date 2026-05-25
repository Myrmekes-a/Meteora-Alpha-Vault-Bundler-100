import { getMongoDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastId: string | null = null;

      const send = (data: unknown) => {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      // Load the last 20 events on connect
      try {
        const db = await getMongoDb();
        const initial = await db
          .collection("pool_events")
          .find({})
          .sort({ createdAt: -1 })
          .limit(20)
          .toArray();

        initial.reverse().forEach((doc) => {
          const { _id, ...rest } = doc;
          lastId = _id.toString();
          send({ _id: lastId, ...rest });
        });
      } catch {
        // MongoDB not available — still keep stream open
      }

      // Poll every 2s for new events
      const interval = setInterval(async () => {
        try {
          const db = await getMongoDb();
          const query = lastId
            ? { _id: { $gt: new (await import("mongodb")).ObjectId(lastId) } }
            : {};

          const docs = await db
            .collection("pool_events")
            .find(query)
            .sort({ _id: 1 })
            .toArray();

          for (const doc of docs) {
            const { _id, ...rest } = doc;
            lastId = _id.toString();
            send({ _id: lastId, ...rest });
          }
        } catch {
          // Ignore transient errors
        }
      }, 2000);

      // Clean up on close
      return () => {
        clearInterval(interval);
      };
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
