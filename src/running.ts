import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { RelayClient, RelayClientError } from "./client.js";

export type Running = { state: "current"; pid: number } | { state: "stale"; pid: number | null } | { state: "down" };

// Compares the running Achat with the build on disk. A process started before
// the last `npm run build` keeps running the old code until it is restarted.
export async function checkRunning(client: RelayClient, cliPath: string): Promise<Running> {
  const builtAt = statSync(cliPath).mtimeMs;
  try {
    const { pid, startedAt } = await client.health();
    return startedAt >= builtAt ? { state: "current", pid } : { state: "stale", pid };
  } catch (err) {
    // Versions before /api/health answer 404.
    return err instanceof RelayClientError ? { state: "stale", pid: null } : { state: "down" };
  }
}

// The process listening on the port, but only if it is an `achat start`.
export function achatOnPort(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pid = Number(out.trim().split("\n")[0]);
    if (!pid) return null;
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return /cli\.js"?\s+start\b/.test(command) ? pid : null;
  } catch {
    return null;
  }
}

async function waitFor(client: RelayClient, cliPath: string, ms: number): Promise<Running> {
  const deadline = Date.now() + ms;
  for (;;) {
    const running = await checkRunning(client, cliPath);
    if (running.state === "current" || Date.now() >= deadline) return running;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// After setup restarts the background service: if an older Achat, usually
// one started in a terminal, still holds the port, stop it so the new
// service can take over, and report what is running.
export async function takeOver(client: RelayClient, cliPath: string, port: number, log: string): Promise<string> {
  let running = await waitFor(client, cliPath, 3000);
  let stopped = "";
  if (running.state === "stale") {
    const pid = running.pid ?? achatOnPort(port);
    if (pid) {
      process.kill(pid, "SIGTERM");
      stopped = `已停止更新前的 Achat（进程 ${pid}）。`;
      // The service retries the port every 5 seconds.
      running = await waitFor(client, cliPath, 15_000);
    }
  }
  if (running.state === "current") return `✓ ${stopped}新版 Achat 已在运行。`;
  if (running.state === "stale") {
    return `• 端口 ${port} 上还在运行更新前的 Achat，多半是之前在终端里运行的 start。在那个终端按 Ctrl+C，新版会在几秒内接上。`;
  }
  return `• Achat 没有启动起来，看看日志：${log}`;
}
