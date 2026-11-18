import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RelayClientError, type RelayClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp/server.js";
import { claudeLabel, NO_PICK, readOffer, resolveUse, type AgentModels, type ModelOffer } from "../src/models.js";
import { claudeOffer, claudeStartsOn, codexOffer } from "../src/sidecar/models.js";
import { bundledClaude, claudeCommand } from "../src/which.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { claudeTaskArgs, codexTaskArgs, TaskBook } from "../src/sidecar/tasks.js";
import { addComputer, CLAUDE, CODEX, logIn, ScriptedRunner, startTestCloud, startTestRelay, until } from "./helpers.js";

process.env.ACHAT_KEYSTORE = "file";
process.env.ACHAT_HOME = mkdtempSync(join(tmpdir(), "achat-models-home-"));

const CLAUDE_OFFER: ModelOffer = {
  models: [
    { id: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ],
  default: { id: "claude-opus-4-8[1m]", label: "Opus 4.8 1M", efforts: ["low", "medium", "high", "xhigh", "max"], effort: "medium" },
};

test("Claude models are named the way people call them", () => {
  assert.equal(claudeLabel("claude-opus-4-8[1m]"), "Opus 4.8 1M");
  assert.equal(claudeLabel("claude-sonnet-5"), "Sonnet 5");
  assert.equal(claudeLabel("claude-fable-5-2"), "Fable 5.2");
  assert.equal(claudeLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(claudeLabel("opus"), "Opus");
  assert.equal(claudeLabel("something-else"), "something-else");
});

test("a conversation runs on its own pick, else the AI's, else the AI's default, in a 推理档位 the model has", () => {
  const models: AgentModels = {
    models: [
      { id: "gpt-a", label: "GPT-A", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { id: "gpt-b", label: "GPT-B", efforts: ["low", "medium", "high"] },
    ],
    default: { id: "gpt-a", label: "GPT-A", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], effort: "medium" },
    picked: NO_PICK,
  };
  assert.deepEqual(resolveUse(models), { model: "gpt-a", label: "GPT-A", effort: "medium" });
  const picked = { ...models, picked: { model: "gpt-b", effort: "high" as const } };
  assert.deepEqual(resolveUse(picked), { model: "gpt-b", label: "GPT-B", effort: "high" });
  assert.deepEqual(resolveUse(picked, { model: "gpt-a", effort: "ultra" }), { model: "gpt-a", label: "GPT-A", effort: "ultra" });
  // GPT-B has no 极限: the nearest one it has.
  assert.equal(resolveUse(picked, { model: null, effort: "ultra" }).effort, "high");
  // A model the computer no longer offers falls back to the default.
  assert.equal(resolveUse({ ...models, picked: { model: "gone", effort: null } }).model, "gpt-a");
  assert.equal(readOffer({ models: "nope" }), null);
  assert.equal(readOffer({ models: [], default: { id: "x", label: "X", efforts: [], effort: "fast" } }), null);
});

test("Codex offers what the codex Achat runs can use, defaulting to config.toml", async () => {
  const home = mkdtempSync(join(tmpdir(), "achat-codex-home-"));
  writeFileSync(join(home, "config.toml"), 'model = "gpt-b"\nmodel_reasoning_effort = "high"\n\n[mcp_servers.achat]\nmodel = "not-this"\n');
  writeFileSync(
    join(home, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-a", display_name: "GPT-A", visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: ["low", "medium", "ultra"] },
        { slug: "gpt-b", display_name: "GPT-B", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
        { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: ["low"] },
      ],
    }),
  );
  // A codex without `debug models`: the list Codex keeps.
  const old = join(home, "codex-old");
  writeFileSync(old, "#!/bin/sh\nexit 2\n");
  chmodSync(old, 0o755);
  const offer = (await codexOffer(home, old))!;
  assert.deepEqual(offer.models.map((m) => m.id), ["gpt-a", "gpt-b"]);
  assert.deepEqual(offer.models[1].efforts, ["low", "high"]);
  assert.deepEqual(offer.default, { id: "gpt-b", label: "GPT-B", efforts: ["low", "high"], effort: "high" });

  // Without a setting, the first model Codex lists, at its own 推理档位.
  writeFileSync(join(home, "config.toml"), "");
  assert.deepEqual((await codexOffer(home, old))!.default, { id: "gpt-a", label: "GPT-A", efforts: ["low", "medium", "ultra"], effort: "low" });
  assert.equal(await codexOffer(mkdtempSync(join(tmpdir(), "achat-codex-none-")), old), null);

  // The codex Achat runs says what it can use, whatever an older one last wrote there.
  const current = join(home, "codex-new");
  const catalog = { models: [{ slug: "gpt-new", display_name: "GPT-New", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }] };
  writeFileSync(current, `#!/bin/sh\n[ "$1 $2" = "debug models" ] && echo '${JSON.stringify(catalog)}'\n`);
  chmodSync(current, 0o755);
  writeFileSync(join(home, "config.toml"), 'model = "gpt-new"\n');
  assert.deepEqual((await codexOffer(home, current))!.models, [{ id: "gpt-new", label: "GPT-New", efforts: ["low", "max"] }]);
});

// A claude that says which model it starts on, by default or for --model,
// then would go on to ask; it writes down what it was given by default.
function fakeClaude(dir: string, model: string, aliases: Record<string, string> = {}): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const asked = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
if (!asked) require("node:fs").writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }));
const model = asked ? (${JSON.stringify(aliases)}[asked] ?? asked) : ${JSON.stringify(model)};
process.stdout.write(JSON.stringify({ type: "system", subtype: "hook_started" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model }) + "\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: "asked anyway" }) + "\\n"), 20000);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

test("Claude Code's default is what it starts on with the person's own login, found before it asks anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-claude-probe-"));
  const bin = fakeClaude(dir, "claude-opus-5-5", { fable: "claude-fable-5-2", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "long-lived";
  try {
    const started = Date.now();
    assert.equal(await claudeStartsOn(bin), "claude-opus-5-5");
    assert.equal(await claudeStartsOn(bin, "sonnet"), "claude-sonnet-5-5");
    assert.ok(Date.now() - started < 15000, "it stops once it knows, without waiting for an answer");
    const call = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
    assert.equal(call.token, null, "not the credential from achat claude-token, which starts on another model");
    assert.ok(call.args.includes("stream-json"));
  } finally {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  const config = mkdtempSync(join(tmpdir(), "achat-claude-config-"));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ effortLevel: "high" }));
  const offer = (await claudeOffer(bin, config))!;
  assert.deepEqual(offer.default, { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], effort: "high" });
  // Picked by alias, so they follow Claude Code to newer models, and named by what they start on now.
  assert.deepEqual(
    offer.models.map((m) => [m.id, m.label]),
    [
      ["fable", "Fable 5.2"],
      ["opus", "Opus 5.5"],
      ["sonnet", "Sonnet 5.5"],
      ["haiku", "Haiku"],
    ],
  );
  // No effortLevel: 中.
  assert.equal((await claudeOffer(bin, mkdtempSync(join(tmpdir(), "achat-claude-empty-"))))!.default.effort, "medium");
});

test("动手 opens Claude Code and Codex on the model and 推理档位 picked", () => {
  const start = { threadId: "t1", topic: "做图", prompt: "做", systemPrompt: "规则", model: "opus", label: "Opus", effort: "low" as const };
  const claude = claudeTaskArgs(start);
  assert.equal(claude[claude.indexOf("--model") + 1], "opus");
  assert.equal(claude[claude.indexOf("--effort") + 1], "low");
  const codex = codexTaskArgs({ ...start, model: "gpt-6.1-sol", effort: "xhigh" });
  assert.equal(codex[codex.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.ok(codex.includes('model_reasoning_effort="xhigh"'));
  const resumed = codexTaskArgs({ ...start, model: "gpt-6.1-sol", from: { sessionId: "s1", dir: "/tmp/x" } });
  assert.ok(resumed.indexOf("-m") < resumed.indexOf("s1"), "options come before the session it resumes");
  assert.ok(!claudeTaskArgs({ ...start, model: undefined, effort: undefined }).includes("--model"));
});

test("the asked side's person picks the model for their AI and for one conversation; the asker sees what answered", async () => {
  const { relay, client } = await startTestRelay();
  try {
    // Before its computer says what it can use, nothing can be picked.
    await assert.rejects(client.pickModels(CLAUDE, { model: "opus" }), (err: RelayClientError) => err.status === 409);
    await client.reportModels(CLAUDE, CLAUDE_OFFER);
    const listed = (await client.agents()).find((a) => a.id === CLAUDE)!;
    assert.deepEqual(listed.models!.default.label, "Opus 4.8 1M");
    assert.deepEqual(listed.models!.picked, NO_PICK);

    await assert.rejects(client.pickModels(CLAUDE, { model: "gpt-x" }), /没有这个模型/);
    await assert.rejects(client.pickModels(CLAUDE, { effort: "ultra" }), /没有「极限」这一档/);
    const picked = await client.pickModels(CLAUDE, { model: "sonnet", effort: "low" });
    assert.deepEqual(resolveUse(picked), { model: "sonnet", label: "Sonnet", effort: "low" });

    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频", message: "怎么做的？" });
    assert.deepEqual(t.uses, { model: "sonnet", label: "Sonnet", effort: "low" });
    // Approved on another model for this conversation only.
    const approved = await client.approve(t.id, { model: "opus", effort: "high" });
    assert.equal(approved.messages.at(-1)!.body, "已同意：Opus · 高 · 问答 · 5 轮 · $5.00");
    assert.deepEqual(approved.uses, { model: "opus", label: "Opus", effort: "high" });
    assert.equal(resolveUse((await client.agents()).find((a) => a.id === CLAUDE)!.models!).model, "sonnet", "the AI's own pick stays");

    // The answer says what it ran on; what the asker writes does not.
    const answered = await client.postMessage(t.id, { from: CLAUDE, body: "分三步", sessionId: "s1", model: "Opus 4.8", effort: "high" });
    assert.equal(answered.messages.at(-1)!.model, "Opus 4.8");
    assert.equal(answered.messages.at(-1)!.effort, "high");
    const asked = await client.postMessage(t.id, { from: CODEX, body: "第二步呢？", model: "made up" });
    assert.equal(asked.messages.at(-1)!.model, null);

    // Mid-way, from the next answer on, with a note both sides see.
    const changed = await client.pickThreadModels(t.id, { model: "default", effort: "low" });
    assert.deepEqual(changed.uses, { model: "sonnet", label: "Sonnet", effort: "low" });
    assert.equal(changed.messages.at(-1)!.body, "换成 Sonnet · 低");
    const same = await client.pickThreadModels(t.id, { effort: "low" });
    assert.equal(same.messages.length, changed.messages.length, "nothing changed, nothing said");

    // A 动手 under way works in its own window.
    const work = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "部署", message: "帮我部署", mode: "do" });
    await client.approve(work.id);
    await assert.rejects(client.pickThreadModels(work.id, { model: "opus" }), /动手已经开始/);
  } finally {
    await relay.close();
  }
});

test("the computer says what its AIs can use, and answers on what was picked", async () => {
  const { relay, client, config } = await startTestRelay();
  const runner = new ScriptedRunner(["分三步"]);
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: runner },
    offers: { [CLAUDE]: async () => CLAUDE_OFFER },
    notify: () => {},
    webUrl: relay.url,
    log: () => {},
  });
  sidecar.start();
  try {
    await until(async () => (await client.agents()).find((a) => a.id === CLAUDE)?.models);
    await client.pickModels(CLAUDE, { effort: "low" });
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频", message: "怎么做的？" });
    await client.approve(t.id);
    const done = await until(async () => {
      const now = await client.getThread(t.id);
      return now.messages.some((m) => m.sender === CLAUDE) && now;
    });
    assert.equal(runner.calls[0].model, "claude-opus-4-8[1m]");
    assert.equal(runner.calls[0].effort, "low");
    // The runner did not say, so the answer carries the name of what it was given.
    const answer = done.messages.find((m) => m.sender === CLAUDE)!;
    assert.equal(answer.model, "Opus 4.8 1M");
    assert.equal(answer.effort, "low");
  } finally {
    sidecar.stop();
    await relay.close();
  }
});

async function mcp(client: RelayClient, agentId: string, url: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client, agentId, webUrl: url, mode: "local" }), waitSeconds: 5 }).connect(serverSide);
  const c = new Client({ name: "test", version: "1" });
  await c.connect(clientSide);
  return c;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

test("an AI sees and changes what its person's AIs use with set_model, and hands back 动手 with what it worked on", async () => {
  const { relay, client } = await startTestRelay();
  try {
    await client.reportModels(CLAUDE, CLAUDE_OFFER);
    const claude = await mcp(client, CLAUDE, relay.url);
    const contacts = textOf(await claude.callTool({ name: "list_contacts", arguments: {} }));
    assert.match(contacts, /你在后台用 Opus 4\.8 1M · 中（默认）回答和动手/);

    const shown = textOf(await claude.callTool({ name: "set_model", arguments: {} }));
    assert.match(shown, /我的 Claude现在用 Opus 4\.8 1M · 中（默认）/);
    assert.match(shown, /Sonnet（sonnet）/);
    const set = textOf(await claude.callTool({ name: "set_model", arguments: { model: "Sonnet", effort: "low" } }));
    assert.match(set, /改成用 Sonnet · 低/);
    const wrong = await claude.callTool({ name: "set_model", arguments: { model: "gpt-9" } });
    assert.ok(wrong.isError);

    // The 动手 conversation's record says what it works with; its result says so too.
    const work = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "部署", message: "帮我部署", mode: "do" });
    await client.approve(work.id);
    new TaskBook().set(work.id, { sessionId: "s1", dir: "/tmp/x", model: "Sonnet", effort: "low" });
    // It waits for the asker to say more.
    const handing = claude.callTool({ name: "send_message", arguments: { thread_id: work.id, message: "部署好了" } });
    const handed = await until(async () => (await client.getThread(work.id)).messages.find((m) => m.body === "部署好了"));
    assert.equal(handed.model, "Sonnet");
    assert.equal(handed.effort, "low");
    await client.postMessage(work.id, { from: CODEX, body: "好的" });
    assert.match(textOf(await handing), /好的/);

    const codex = await mcp(client, CODEX, relay.url);
    const checked = textOf(await codex.callTool({ name: "check_thread", arguments: { thread_id: work.id } }));
    assert.match(checked, /我的 Claude（Sonnet · 低）：部署好了/);
  } finally {
    await relay.close();
  }
});

test("in the cloud a computer reports for its own AIs, and only their person sees and picks what they use", async () => {
  const { cloud, mailer } = await startTestCloud();
  try {
    const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    const fangPc = await addComputer(cloud, fang, "MacBook", ["claude"]);
    const wangPc = await addComputer(cloud, wang, "iMac", ["codex"]);
    const claude = fangPc.agent("claude");
    // Ids carry the computer: "<device>/claude".
    await fangPc.client.reportModels(claude, CLAUDE_OFFER);
    await assert.rejects(wangPc.client.reportModels(claude, CLAUDE_OFFER), (err: RelayClientError) => err.status === 403);

    const mine = (await fang.call("GET", "/api/agents")).find((a: any) => a.id === claude);
    assert.equal(mine.models.uses.label, "Opus 4.8 1M");
    const after = await fang.call("POST", `/api/agents/${encodeURIComponent(claude)}/models`, { model: "sonnet", effort: "high" });
    assert.deepEqual(after.uses, { model: "sonnet", label: "Sonnet", effort: "high" });
    await assert.rejects(wang.call("POST", `/api/agents/${encodeURIComponent(claude)}/models`, { model: "opus" }), /只能换自己的 AI/);

    // A friend sees the AI, not what it runs on.
    const invite = await fang.call("POST", "/api/invites", { email: "wang@example.com" });
    const [request] = await wang.call("GET", "/api/invites");
    await wang.call("POST", `/api/invites/${request.id}/accept`, {});
    assert.ok(invite);
    const seen = (await wang.call("GET", "/api/agents")).find((a: any) => a.id === claude);
    assert.ok(seen && !seen.models);
  } finally {
    await cloud.close();
  }
});

test("Achat runs the newest Claude Code the desktop app brings, which starts on newer models than an old one on the PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "achat-claude-app-"));
  const add = (version: string, withProgram = true): string => {
    const dir = join(root, version, "c4434d650cb3", "claude.app", "Contents", "MacOS");
    mkdirSync(dir, { recursive: true });
    if (withProgram) writeFileSync(join(dir, "claude"), "");
    return join(dir, "claude");
  };
  add("2.1.9");
  const newest = add("2.1.10");
  add("2.1.11", false); // still being downloaded
  assert.equal(bundledClaude(root), newest, "2.1.10 is newer than 2.1.9");
  assert.equal(claudeCommand({}, () => bundledClaude(root)), newest);
  assert.equal(claudeCommand({ ACHAT_CLAUDE_BIN: "/opt/claude" }, () => bundledClaude(root)), "/opt/claude");
  assert.equal(claudeCommand({}, () => bundledClaude(join(root, "none"))), "claude");
});
