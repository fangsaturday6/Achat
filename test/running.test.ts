import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelayClient } from "../src/client.js";
import { DEFAULT_AGENTS } from "../src/config.js";
import { checkRunning, takeOver } from "../src/running.js";
import { startTestRelay, until } from "./helpers.js";

function build(dir: string, at: Date): string {
  const file = join(dir, "cli.js");
  writeFileSync(file, "");
  utimesSync(file, at, at);
  return file;
}

test("a relay started after the build is current, one started before is stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-running-"));
  const { relay, client } = await startTestRelay();
  try {
    assert.deepEqual(await checkRunning(client, build(dir, new Date(Date.now() - 60_000))), {
      state: "current",
      pid: process.pid,
    });
    assert.deepEqual(await checkRunning(client, build(dir, new Date(Date.now() + 60_000))), {
      state: "stale",
      pid: process.pid,
    });
  } finally {
    await relay.close();
  }
});

test("a relay without the health endpoint is stale, and no relay is down", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-running-"));
  const old = createServer((_, res) => res.writeHead(404, { "content-type": "application/json" }).end('{"error":"没有这个接口"}'));
  await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
  const port = (old.address() as { port: number }).port;
  const cli = build(dir, new Date());
  assert.deepEqual(await checkRunning(new RelayClient(`http://127.0.0.1:${port}`, "t"), cli), { state: "stale", pid: null });
  await new Promise((r) => old.close(r));
  assert.deepEqual(await checkRunning(new RelayClient(`http://127.0.0.1:${port}`, "t"), cli), { state: "down" });
});

test("after an update, the waiting service takes over from the old terminal copy", async () => {
  const free = createNetServer();
  await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
  const port = (free.address() as { port: number }).port;
  await new Promise((r) => free.close(r));
  const home = mkdtempSync(join(tmpdir(), "achat-running-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ port, token: "t", agents: DEFAULT_AGENTS }));
  const env = { ...process.env, ACHAT_HOME: home };
  const cliArgs = ["--no-warnings=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts")];
  const client = new RelayClient(`http://127.0.0.1:${port}`, "t");
  const children: ChildProcess[] = [];

  try {
    const old = spawn(process.execPath, [...cliArgs, "start"], { env });
    children.push(old);
    await until(async () => (await checkRunning(client, build(home, new Date(0)))).state === "current", 30_000);

    const cli = build(home, new Date()); // npm run build
    const service = spawn(process.execPath, [...cliArgs, "start", "--wait"], { env });
    children.push(service);
    let out = "";
    service.stdout.on("data", (d) => (out += d));
    await until(async () => out.includes("被占用"), 30_000);

    const result = await takeOver(client, cli, port, "log");
    assert.match(result, new RegExp(`已停止更新前的 Achat（进程 ${old.pid}）。新版 Achat 已在运行`));
    assert.deepEqual(await checkRunning(client, cli), { state: "current", pid: service.pid });
  } finally {
    for (const c of children) c.kill("SIGTERM");
  }
});
