import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { secretStore } from "../src/device.js";
import { BudgetExceededError, ClaudeRunner, CodexRunner, LoginExpiredError } from "../src/sidecar/runners.js";

// The keychain on this computer may hold the person's own credential. The tests
// never read it: the fake claude below writes down what it was given.
process.env.ACHAT_KEYSTORE = "file";
process.env.ACHAT_HOME = mkdtempSync(join(tmpdir(), "achat-runner-home-"));

// A stand-in for the claude CLI that records how it was called.
function fakeClaude(dir: string, reply: object): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input, headless: process.env.ACHAT_HEADLESS, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, apiTimeout: process.env.API_TIMEOUT_MS, cwd: process.cwd(), files: fs.readdirSync(process.cwd(), { recursive: true }) }));
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

// One conversation in the person's Claude Code history.
function claudeHistory(dir: string): void {
  mkdirSync(join(dir, "-Users-me-shop"), { recursive: true });
  writeFileSync(
    join(dir, "-Users-me-shop", "s1.jsonl"),
    JSON.stringify({ type: "user", cwd: "/Users/me/shop", timestamp: "2026-11-06T06:03:00Z", message: { content: "上线商城" } }) + "\n",
  );
}

test("runs claude read-only on a plain copy of the history, with the prompt on stdin and a budget cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CLAUDE_PROJECTS = dir;
  claudeHistory(dir);
  const bin = fakeClaude(dir, { type: "result", result: "答案", total_cost_usd: 0.03, is_error: false });
  const runner = new ClaudeRunner(bin);

  const first = await runner.run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.5 });
  const call = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
  assert.equal(first.text, "答案");
  assert.equal(first.costUsd, 0.03);
  assert.equal(call.input, "问题");
  assert.equal(call.headless, "1");
  // It works in the plain copy, made before it starts, and may open the originals.
  const copies = join(process.env.ACHAT_HOME!, "history", "claude");
  assert.equal(call.cwd, realpathSync(copies)); // on macOS the temp folder is reached through a symlink
  assert.ok(call.files.includes(join("-Users-me-shop", "s1.md")));
  assert.ok(readFileSync(join(copies, "-Users-me-shop", "s1.md"), "utf8").includes("上线商城"));
  const args: string[] = call.args;
  assert.equal(args[args.indexOf("--add-dir") + 1], dir);
  // Folders it is given, such as the thread's files, are readable too.
  await runner.run({ prompt: "看附件", systemPrompt: "规则", budgetUsd: 0.5, readDirs: ["/achat/files/t1"] });
  const withFiles: string[] = JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).args;
  assert.deepEqual(withFiles.slice(withFiles.indexOf("--add-dir") + 1, withFiles.indexOf("--add-dir") + 3), [dir, "/achat/files/t1"]);
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

// A request stuck on a dead connection is given up after 90 seconds and sent
// again on a new one, instead of waiting out the whole round.
test("claude gives up on a request that gets no reply within 90 seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CLAUDE_PROJECTS = dir;
  const bin = fakeClaude(dir, { type: "result", result: "答案", is_error: false });
  await new ClaudeRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 });
  assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).apiTimeout, "90000");
  delete process.env.ACHAT_CLAUDE_PROJECTS;
});

test("a missing or expired claude login is told apart from other errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CLAUDE_PROJECTS = dir;
  for (const result of [
    "Not logged in · Please run /login",
    "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
  ]) {
    const bin = fakeClaude(dir, { type: "result", result, is_error: true });
    await assert.rejects(
      new ClaudeRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 }),
      (err: unknown) => err instanceof LoginExpiredError && err.client === "claude" && !err.withToken,
    );
  }
  delete process.env.ACHAT_CLAUDE_PROJECTS;
});

test("background answers use the long-lived credential from achat claude-token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  const saved = { home: process.env.ACHAT_HOME, keystore: process.env.ACHAT_KEYSTORE };
  process.env.ACHAT_HOME = dir;
  process.env.ACHAT_KEYSTORE = "file";
  process.env.ACHAT_CLAUDE_PROJECTS = dir;
  try {
    const bin = fakeClaude(dir, { type: "result", result: "答案", is_error: false });
    await new ClaudeRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 });
    assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).token, undefined);
    secretStore("claude-token").save("sk-ant-oat01-example");
    await new ClaudeRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 });
    assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).token, "sk-ant-oat01-example");
    // When that credential itself has run out, the error says so.
    const expired = fakeClaude(dir, { type: "result", result: "API Error: 401 OAuth access token has expired", is_error: true });
    await assert.rejects(
      new ClaudeRunner(expired).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 }),
      (err: unknown) => err instanceof LoginExpiredError && err.withToken,
    );
  } finally {
    for (const [key, value] of [["ACHAT_HOME", saved.home], ["ACHAT_KEYSTORE", saved.keystore]]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    delete process.env.ACHAT_CLAUDE_PROJECTS;
  }
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
  fs.writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input, headless: process.env.ACHAT_HEADLESS, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, cwd: process.cwd() }));
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

test("runs codex in the read-only sandbox without the person's config, on a plain copy of the history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CODEX_SESSIONS = dir;
  mkdirSync(join(dir, "2026", "11", "08"), { recursive: true });
  writeFileSync(
    join(dir, "2026", "11", "08", "rollout-1.jsonl"),
    [
      { type: "session_meta", payload: { cwd: "/Users/me/video" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "做个产品视频" }] } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const runner = new CodexRunner(fakeCodex(dir, CODEX_TURN));

  const first = await runner.run({ prompt: "问题", systemPrompt: "规则\n第二行", budgetUsd: 5 });
  const call = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
  assert.deepEqual(first, { text: "答案", sessionId: "thread-1", costUsd: 0 });
  assert.equal(call.input, "问题");
  assert.equal(call.headless, "1");
  const copies = join(process.env.ACHAT_HOME!, "history", "codex");
  assert.equal(call.cwd, realpathSync(copies));
  assert.ok(readFileSync(join(copies, "2026", "11", "08", "rollout-1.md"), "utf8").includes("做个产品视频"));
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

test("a codex that is not logged in is told apart from other errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-runner-"));
  process.env.ACHAT_CODEX_SESSIONS = dir;
  const bin = fakeCodex(dir, [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "error", message: "Reconnecting... 1/5 (unexpected status 401 Unauthorized)" },
    { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer" } },
  ]);
  await assert.rejects(
    new CodexRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 5 }),
    (err: unknown) => err instanceof LoginExpiredError && err.client === "codex",
  );
  delete process.env.ACHAT_CODEX_SESSIONS;
});

test("says so when the client is not installed", async () => {
  await assert.rejects(
    new CodexRunner("/nonexistent/codex").run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 5 }),
    /找不到 codex 命令/,
  );
});
