import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetExceededError, ClaudeRunner, CodexRunner } from "../src/sidecar/runners.js";

// A stand-in for the claude CLI that records how it was called.
function fakeClaude(dir: string, reply: object): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input, headless: process.env.ACHAT_HEADLESS, cwd: process.cwd() }));
  const args = process.argv.slice(2);
  const flag = args.includes("--resume") ? "--resume" : "--session-id";
  const sid = args[args.indexOf(flag) + 1];
  process.stdout.write(JSON.stringify({ ...${JSON.stringify(reply)}, session_id: sid }));
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("runs claude read-only, with the prompt on stdin and a budget cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CLAUDE_PROJECTS = dir;
  const bin = fakeClaude(dir, { type: "result", result: "答案", total_cost_usd: 0.03, is_error: false });
  const runner = new ClaudeRunner(bin);

  const first = await runner.run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.5 });
  const call = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
  assert.equal(first.text, "答案");
  assert.equal(first.costUsd, 0.03);
  assert.equal(call.input, "问题");
  assert.equal(call.headless, "1");
  assert.equal(call.cwd, realpathSync(dir)); // on macOS the temp folder is reached through a symlink
  const args: string[] = call.args;
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.50");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--session-id") + 1], first.sessionId);

  const second = await runner.run({ prompt: "追问", systemPrompt: "规则", budgetUsd: 0.2, sessionId: first.sessionId });
  const call2 = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
  assert.equal(call2.args[call2.args.indexOf("--resume") + 1], first.sessionId);
  assert.ok(!call2.args.includes("--session-id"));
  assert.equal(second.sessionId, first.sessionId);
  delete process.env.ACHAT_CLAUDE_PROJECTS;
});

test("explains how to log in when claude is not logged in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CLAUDE_PROJECTS = dir;
  const bin = fakeClaude(dir, { type: "result", result: "Not logged in · Please run /login", is_error: true });
  await assert.rejects(new ClaudeRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 }), /输入 \/login 登录/);
  delete process.env.ACHAT_CLAUDE_PROJECTS;
});

test("reports claude errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CLAUDE_PROJECTS = dir;
  const bin = fakeClaude(dir, { type: "result", subtype: "error_max_budget_usd", is_error: true });
  await assert.rejects(
    new ClaudeRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 }),
    (err: unknown) => err instanceof BudgetExceededError,
  );
  delete process.env.ACHAT_CLAUDE_PROJECTS;
});

// A stand-in for the codex CLI that prints the JSONL events `codex exec --json` emits.
function fakeCodex(dir: string, events: object[]): string {
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input, headless: process.env.ACHAT_HEADLESS, cwd: process.cwd() }));
  for (const e of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(e) + "\\n");
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const CODEX_TURN = [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "item.completed", item: { id: "item_0", type: "error", message: "warning" } },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "我先搜一下" } },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "答案" } },
  { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 7 } },
];

test("runs codex in the read-only sandbox without the person's config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CODEX_SESSIONS = dir;
  const runner = new CodexRunner(fakeCodex(dir, CODEX_TURN));

  const first = await runner.run({ prompt: "问题", systemPrompt: "规则\n第二行", budgetUsd: 5 });
  const call = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
  assert.deepEqual(first, { text: "答案", sessionId: "thread-1", costUsd: 0 });
  assert.equal(call.input, "问题");
  assert.equal(call.headless, "1");
  assert.equal(call.cwd, realpathSync(dir));
  const args: string[] = call.args;
  assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
  for (const a of ["--ignore-user-config", 'sandbox_mode="read-only"', 'web_search="disabled"', "features.multi_agent=false"]) {
    assert.ok(args.includes(a), a);
  }
  assert.ok(args.includes(`developer_instructions=${JSON.stringify("规则\n第二行")}`));
  assert.equal(args.at(-1), "-");

  await runner.run({ prompt: "追问", systemPrompt: "规则", budgetUsd: 5, sessionId: "thread-1" });
  const resumed: string[] = JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).args;
  assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "--json"]);
  assert.deepEqual(resumed.slice(-2), ["thread-1", "-"]);
  assert.ok(!resumed.some((a) => a.startsWith("developer_instructions")), "the session already has the rules");
  delete process.env.ACHAT_CODEX_SESSIONS;
});

test("explains how to log in when codex is not logged in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CODEX_SESSIONS = dir;
  const bin = fakeCodex(dir, [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized)" },
    { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer" } },
  ]);
  await assert.rejects(new CodexRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 5 }), /codex login/);
  delete process.env.ACHAT_CODEX_SESSIONS;
});

test("says so when the client is not installed", async () => {
  await assert.rejects(
    new CodexRunner("/nonexistent/codex").run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 5 }),
    /找不到 codex 命令/,
  );
});
