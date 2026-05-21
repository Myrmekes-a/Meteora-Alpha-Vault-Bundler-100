import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getMongoDb } from "@/lib/mongo";

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  const marker = path.join("src", "commands", "token-mint.ts");
  if (fs.existsSync(path.join(cwd, marker))) return cwd;
  const parent = path.resolve(cwd, "..");
  if (fs.existsSync(path.join(parent, marker))) return parent;
  return cwd;
}

const PROJECT_DIR = resolveProjectRoot();
const SETTINGS_RECORD_KEY = "ui-settings";

const ALLOWED_ACTIONS: Record<string, string> = {
  "mint-token": "mint:token",
  "distribute-funds": "distribute:funds",
  "deposit-to-vault": "deposit:to-vault",
  "simple-deposit": "simple:deposit",
  "fill-vault": "fill:vault",
  "claim-tokens": "claim:tokens",
  "listen-pool": "listen:pool",
  "init-launch-state": "init:launch-state",
  "sell-pool-token": "sell:pool:token",
  "gather-funds": "gather:funds",
  "collect-lp-fees": "collect:lp-fees",
  "distribute-and-deposit": "distribute:and:deposit",
  "wait-deposit-then-fill": "wait:deposit:then:fill",
  "launch-with-alpha-vault": "launch:with-alpha-vault",
};

function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

async function loadDbEnvOverrides(): Promise<Record<string, string>> {
  try {
    const db = await getMongoDb();
    const doc = (await db
      .collection("settings")
      .findOne({ recordKey: SETTINGS_RECORD_KEY })) as
      | { values?: Record<string, string> }
      | null;
    return doc?.values ?? {};
  } catch {
    return {};
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { action: string } }
) {
  const { action } = params;
  const npmScript = ALLOWED_ACTIONS[action];

  if (!npmScript) {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  const dbEnvOverrides = await loadDbEnvOverrides();

  let proc: ReturnType<typeof spawn> | null = null;
  let streamClosed = false;
  let finalized = false;

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (obj: unknown) => {
        if (streamClosed) return;
        try {
          controller.enqueue(enc(obj));
        } catch {
          streamClosed = true;
        }
      };

      const safeClose = () => {
        if (streamClosed) return;
        try {
          controller.close();
        } catch {
          // stream may already be closed/cancelled by client
        } finally {
          streamClosed = true;
        }
      };

      const finalize = (success: boolean, code: number | null, errText?: string) => {
        if (finalized) return;
        finalized = true;
        if (errText) safeEnqueue({ type: "stderr", text: errText });
        safeEnqueue({ type: "done", success, code });
        safeClose();
      };

      proc = spawn("npm", ["run", npmScript], {
        cwd: PROJECT_DIR,
        env: { ...process.env, ...dbEnvOverrides, FORCE_COLOR: "0" },
        shell: true,
      });

      proc.stdout?.on("data", (d: Buffer) => {
        safeEnqueue({ type: "stdout", text: d.toString() });
      });

      proc.stderr?.on("data", (d: Buffer) => {
        safeEnqueue({ type: "stderr", text: d.toString() });
      });

      proc.on("close", (code) => {
        finalize(code === 0, code);
      });

      proc.on("error", (err) => {
        finalize(false, null, String(err));
      });
    },
    cancel() {
      finalized = true;
      if (proc && !proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore kill errors
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
