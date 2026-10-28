import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_AGENTS } from "../src/config.js";
import { until } from "./helpers.js";

const cli = [
  "--no-warnings=ExperimentalWarning",
  "--import",
  "tsx",
  join(import.meta.dirname, "..", "src", "cli.ts"),
];

test("start waits for a busy port when asked to, and otherwise says Achat is running", async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), "achat-cli-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ port, token: "t", agents: DEFAULT_AGENTS }));
  const env = { ...process.env, ACHAT_HOME: home };

  const plain = spawnSync(process.execPath, [...cli, "start"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /已经在运行/);

  const waiting = spawn(process.execPath, [...cli, "start", "--wait"], { env });
  let out = "";
  waiting.stdout.on("data", (d) => (out += d));
  try {
    await until(async () => out.includes("被占用"), 30_000);
    await new Promise((r) => blocker.close(r));
    await until(async () => out.includes(`Achat 已启动：http://127.0.0.1:${port}`), 30_000);
  } finally {
    waiting.kill("SIGTERM");
    blocker.close();
  }
});
