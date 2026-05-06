export interface ActionResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  code?: number | null;
}

export interface RunActionCallbacks {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/**
 * Calls POST /api/actions/:actionId with SSE streaming.
 * Streams stdout/stderr via callbacks and resolves with the final result.
 * No artificial timeout — process runs until it exits naturally.
 */
export async function runAction(
  actionId: string,
  callbacks: RunActionCallbacks = {},
  signal?: AbortSignal
): Promise<ActionResult> {
  const res = await fetch(`/api/actions/${actionId}`, { method: "POST", signal });

  if (!res.ok || !res.body) {
    return { success: false, stderr: `HTTP ${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stdout = "";
  let stderr = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // keep incomplete trailing line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as {
          type: "stdout" | "stderr" | "done";
          text?: string;
          success?: boolean;
          code?: number | null;
        };

        if (event.type === "stdout" && event.text) {
          stdout += event.text;
          callbacks.onStdout?.(event.text);
        } else if (event.type === "stderr" && event.text) {
          stderr += event.text;
          callbacks.onStderr?.(event.text);
        } else if (event.type === "done") {
          return {
            success: event.success ?? false,
            stdout: stdout.slice(-6000),
            stderr: stderr.slice(-3000),
            code: event.code,
          };
        }
      } catch {
        // malformed SSE line – skip
      }
    }
  }

  // Stream ended without a "done" event
  return { success: false, stdout, stderr: stderr || "Stream closed unexpectedly" };
}
