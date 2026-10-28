import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { RelayClient } from "../src/client.js";
import type { AchatConfig } from "../src/config.js";
import { userPromptHook } from "../src/hook.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RunningRelay } from "../src/relay/server.js";
import { BudgetExceededError } from "../src/sidecar/runners.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { CLAUDE, CODEX, ScriptedRunner, startTestRelay, until } from "./helpers.js";

type Elicit = () => ElicitResult;

async function mcpClient(relayClient: RelayClient, agentId: string, webUrl: string, elicit?: Elicit): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({
    connection: () => ({ client: relayClient, agentId, webUrl, mode: "local" }),
    waitSeconds: 10,
  }).connect(serverSide);
  const client = new Client({ name: "test", version: "1" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async () => elicit());
  await client.connect(clientSide);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

describe("experiment 0 end to end", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let config: AchatConfig;
  let runner: ScriptedRunner;
  let sidecar: Sidecar;
  const notes: string[] = [];

  before(async () => {
    ({ relay, client, config } = await startTestRelay());
  });
  after(() => relay.close());

  function startSidecar(replies: (string | Error)[], receiver = CLAUDE): void {
    runner = new ScriptedRunner(replies);
    sidecar = new Sidecar({
      client,
      agents: config.agents,
      runners: { [receiver]: runner },
      notify: (title, body) => notes.push(`${title} ${body}`),
      webUrl: relay.url,
      log: () => {},
    });
    sidecar.start();
  }
  afterEach(() => sidecar?.stop());

  test("Codex asks, the person approves on the web, Claude answers in the background", async () => {
    startSidecar(["第一步写分镜，第二步出图。联系 me@example.com", "风格参数用 --stylize 250"]);
    const codex = await mcpClient(client, CODEX, relay.url);

    const asking = codex.callTool({
      name: "send_request",
      arguments: { to: "我的 Claude", topic: "视频制作流程", message: "上次的视频是怎么做的？" },
    });
    const pending = await until(async () => (await client.listThreads({ status: "pending", to: CLAUDE }))[0]);
    await until(async () => notes.some((n) => n.includes("[待批准] 视频制作流程")));
    assert.equal(runner.calls.length, 0, "nothing runs before approval");

    await client.approve(pending.id, { maxRounds: 3 });
    const first = textOf(await asking);
    assert.match(first, /第一步写分镜/);
    assert.match(first, /已自动过滤 1 处/);
    assert.doesNotMatch(first, /me@example\.com/);
    assert.match(first, /第 1\/3 轮/);
    assert.match(runner.calls[0].prompt, /话题：视频制作流程/);
    assert.match(runner.calls[0].prompt, /<message>\n上次的视频是怎么做的？\n<\/message>/);
    assert.equal(runner.calls[0].sessionId, undefined);

    const second = textOf(
      await codex.callTool({ name: "send_message", arguments: { thread_id: pending.id, message: "风格参数呢？" } }),
    );
    assert.match(second, /--stylize 250/);
    assert.equal(runner.calls[1].sessionId, "session-1", "follow-ups continue the same session");
    assert.doesNotMatch(runner.calls[1].prompt, /话题：/);

    const closed = textOf(await codex.callTool({ name: "close_thread", arguments: { thread_id: pending.id } }));
    assert.match(closed, /已结束/);
    assert.equal((await client.getThread(pending.id)).status, "closed");
  });

  test("Claude asks Codex, which searches its own history", async () => {
    startSidecar(["周末定了三件事"], CODEX);
    const claude = await mcpClient(client, CLAUDE, relay.url);
    const asking = claude.callTool({
      name: "send_request",
      arguments: { to: "我的 Codex", topic: "周末的方案", message: "周末讨论的方案定了哪些？" },
    });
    const pending = await until(async () => (await client.listThreads({ status: "pending", to: CODEX }))[0]);
    await client.approve(pending.id);
    assert.match(textOf(await asking), /周末定了三件事/);
    assert.match(runner.calls[0].systemPrompt, /Codex 对话记录/);
    assert.match(runner.calls[0].systemPrompt, /你是「我的 Codex」/);
    await claude.callTool({ name: "close_thread", arguments: { thread_id: pending.id } });
  });

  test("a declined request costs nothing and tells the asker", async () => {
    startSidecar([]);
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({
      name: "send_request",
      arguments: { to: "claude@local", topic: "不会被接受", message: "问题" },
    });
    const pending = await until(async () =>
      (await client.listThreads({ status: "pending", to: CLAUDE })).find((t) => t.topic === "不会被接受"),
    );
    await client.decline(pending.id);
    assert.match(textOf(await asking), /没有接受/);
    assert.equal(runner.calls.length, 0);
  });

  test("the person approves inside Claude through an elicitation dialog", async () => {
    startSidecar(["好的"]);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "对话框批准", message: "问题" });

    const hook = await userPromptHook(client, CLAUDE);
    assert.ok(hook);
    assert.match(hook, /1 个待批准/);
    assert.doesNotMatch(hook, /对话框批准|问题/, "the hook never reveals the request");

    const claude = await mcpClient(client, CLAUDE, relay.url, () => ({
      action: "accept",
      content: { maxRounds: 2, budgetUsd: 0.5 },
    }));
    const result = textOf(await claude.callTool({ name: "review_pending", arguments: {} }));
    assert.match(result, /已同意 1 个/);
    assert.doesNotMatch(result, /对话框批准/, "the model only learns the outcome");

    const done = await until(async () => {
      const d = await client.getThread(t.id);
      return d.roundsUsed === 1 && d;
    });
    assert.deepEqual(done.scope, { maxRounds: 2, budgetUsd: 0.5 });
  });

  test("without elicitation support the person is sent to the web page", async () => {
    startSidecar([]);
    await client.createRequest({ from: CODEX, to: CLAUDE, topic: "网页批准", message: "问题" });
    const claude = await mcpClient(client, CLAUDE, relay.url);
    const result = textOf(await claude.callTool({ name: "review_pending", arguments: {} }));
    assert.match(result, new RegExp(relay.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const pending = await client.listThreads({ status: "pending", to: CLAUDE });
    for (const p of pending) await client.decline(p.id);
  });

  test("a failing answer ends the thread with the reason", async () => {
    startSidecar([new Error("预算用完")]);
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({ name: "send_request", arguments: { to: "我的 Claude", topic: "会出错", message: "问题" } });
    const pending = await until(async () =>
      (await client.listThreads({ status: "pending", to: CLAUDE })).find((t) => t.topic === "会出错"),
    );
    await client.approve(pending.id);
    assert.match(textOf(await asking), /接收方出错：预算用完/);
  });

  test("running out of budget ends the thread with a plain explanation", async () => {
    startSidecar([new BudgetExceededError("error_max_budget_usd")]);
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({ name: "send_request", arguments: { to: "我的 Claude", topic: "超预算", message: "问题" } });
    const pending = await until(async () =>
      (await client.listThreads({ status: "pending", to: CLAUDE })).find((t) => t.topic === "超预算"),
    );
    await client.approve(pending.id);
    const outcome = textOf(await asking);
    assert.match(outcome, /花费额度用完了/);
    assert.doesNotMatch(outcome, /error_max_budget_usd|出错/);
  });

  test("a round is not started when too little budget is left", async () => {
    startSidecar(["第一轮回答"]);
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({ name: "send_request", arguments: { to: "我的 Claude", topic: "额度很少", message: "问题" } });
    const pending = await until(async () =>
      (await client.listThreads({ status: "pending", to: CLAUDE })).find((t) => t.topic === "额度很少"),
    );
    await client.approve(pending.id, { budgetUsd: 0.12 });
    assert.match(textOf(await asking), /完整转给主人/);
    const second = textOf(
      await codex.callTool({ name: "send_message", arguments: { thread_id: pending.id, message: "追问" } }),
    );
    assert.match(second, /花费额度用完了/);
    assert.equal(runner.calls.length, 1, "the second round never ran");
  });

  test("the hook stays quiet inside headless runs", async () => {
    await client.createRequest({ from: CODEX, to: CLAUDE, topic: "无声", message: "问题" });
    process.env.ACHAT_HEADLESS = "1";
    try {
      assert.equal(await userPromptHook(client, CLAUDE), null);
    } finally {
      delete process.env.ACHAT_HEADLESS;
    }
  });
});
