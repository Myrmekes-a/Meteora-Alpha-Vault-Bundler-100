import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "..", "image", "xd-icon.jpg"),
    path.join(cwd, "image", "xd-icon.jpg"),
    path.join(cwd, "..", "xd-icon.jpg"),
    path.join(cwd, "xd-icon.jpg"),
  ];

  for (const p of candidates) {
    try {
      const file = await fs.readFile(p);
      return new Response(file, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=86400, immutable",
        },
      });
    } catch {
      // try next location
    }
  }

  return new Response("Icon not found", { status: 404 });
}

