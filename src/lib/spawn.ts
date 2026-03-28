import { spawn } from "node:child_process";

export function run(command: string, env = { NODE_NO_WARNINGS: "1" }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env },
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Command exited with ${code}`))));
    child.on("error", reject);
  });
}
