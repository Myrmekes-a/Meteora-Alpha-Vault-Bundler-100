import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  const marker = path.join("src", "commands", "token-mint.ts");
  if (fs.existsSync(path.join(cwd, marker))) return cwd;
  const parent = path.resolve(cwd, "..");
  if (fs.existsSync(path.join(parent, marker))) return parent;
  return cwd;
}

const IMAGE_UPLOAD_DIR = path.resolve(resolveProjectRoot(), "image", "uploads");

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing image file" }, { status: 400 });
    }

    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ error: "Only image uploads are allowed" }, { status: 400 });
    }

    await fs.promises.mkdir(IMAGE_UPLOAD_DIR, { recursive: true });

    const safeName = sanitizeFileName(file.name || "token-image");
    const storedName = `${Date.now()}-${safeName}`;
    const absPath = path.join(IMAGE_UPLOAD_DIR, storedName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.promises.writeFile(absPath, buffer);

    const relativePath = path.posix.join("image", "uploads", storedName);
    return NextResponse.json({ path: relativePath });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
