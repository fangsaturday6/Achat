import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeRunner } from "../src/sidecar/runners.js";

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
  assert.equal(call.cwd, dir);
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
  await assert.rejects(new ClaudeRunner(bin).run({ prompt: "问题", systemPrompt: "规则", budgetUsd: 0.1 }), /error_max_budget_usd/);
  delete process.env.ACHAT_CLAUDE_PROJECTS;
});
