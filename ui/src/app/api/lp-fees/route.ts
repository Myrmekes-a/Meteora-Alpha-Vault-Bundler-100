import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  const marker = path.join("src", "commands", "get-lp-fees.ts");
  if (fs.existsSync(path.join(cwd, marker))) return cwd;
  const parent = path.resolve(cwd, "..");
  if (fs.existsSync(path.join(parent, marker))) return parent;
  return cwd;
}

const PROJECT_DIR = resolveProjectRoot();

export interface LpFeesResult {
  pool?: string;
  positionNftMint?: string;
  position?: string;
  feeTokenARaw?: string;
  feeTokenBRaw?: string;
  feeTokenA?: number;
  feeTokenB?: number;
  tokenAMint?: string;
  tokenBMint?: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  error?: string;
}

export async function GET(): Promise<NextResponse> {
  return new Promise<NextResponse>((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn("npm", ["run", "get:lp-fees"], {
      cwd: PROJECT_DIR,
      env: { ...process.env, FORCE_COLOR: "0" },
      shell: true,
    });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve(
        NextResponse.json(
          { error: "timeout" },
          {
            status: 504,
            headers: {
              "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
              Pragma: "no-cache",
              Expires: "0",
            },
          }
        )
      );
    }, 30_000);

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      // The script writes JSON to stdout; npm may prepend noise so we
      // extract the first JSON object.
      const match = stdout.match(/\{[\s\S]*\}/);
      if (!match) {
        resolve(
          NextResponse.json(
            { error: "No JSON output from get:lp-fees", detail: stderr.slice(-500) },
            {
              status: 500,
              headers: {
                "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                Pragma: "no-cache",
                Expires: "0",
              },
            }
          )
        );
        return;
      }
      try {
        const data: LpFeesResult = JSON.parse(match[0]);
        resolve(
          NextResponse.json(data, {
            headers: {
              "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
              Pragma: "no-cache",
              Expires: "0",
            },
          })
        );
      } catch {
        resolve(
          NextResponse.json(
            { error: "Failed to parse LP fees JSON" },
            {
              status: 500,
              headers: {
                "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                Pragma: "no-cache",
                Expires: "0",
              },
            }
          )
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve(
        NextResponse.json(
          { error: String(err) },
          {
            status: 500,
            headers: {
              "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
              Pragma: "no-cache",
              Expires: "0",
            },
          }
        )
      );
    });
  });
}
