import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { RelayClient } from "../src/client.js";
import type { AchatConfig } from "../src/config.js";
import { userPromptHook } from "../src/hook.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RunningRelay } from "../src/relay/server.js";
import type { Answer, ApprovalPrompt } from "../src/sidecar/dialog.js";
import { BudgetExceededError, LoginExpiredError } from "../src/sidecar/runners.js";
import { loginAdvice, Sidecar } from "../src/sidecar/sidecar.js";
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

  // `alsoHere`: another AI on the same computer, which only asks.
  function startSidecar(replies: (string | Error)[], receiver = CLAUDE, alsoHere?: string): void {
    runner = new ScriptedRunner(replies);
    sidecar = new Sidecar({
      client,
      agents: config.agents,
      runners: { [receiver]: runner, ...(alsoHere ? { [alsoHere]: new ScriptedRunner([]) } : {}) },
      notify: (title, body) => notes.push(`${title} ${body}`),
      webUrl: relay.url,
      seenWaitMs: 300,
      log: () => {},
    });
    sidecar.start();
  }
  afterEach(() => sidecar?.stop());

  test("the asked side says the work is done in the same thread, and it comes back to the session that asked", async () => {
    startSidecar(["可以接，做完告诉你", "已经上线了"], CLAUDE, CODEX);
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({ name: "send_request", arguments: { to: "我的 Claude", topic: "交接", message: "能接手吗？" } });
    const pending = await until(async () =>
      (await client.listThreads({ status: "pending", to: CLAUDE })).find((t) => t.topic === "交接"),
    );
    await client.approve(pending.id);
    assert.match(textOf(await asking), /可以接/);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!notes.some((n) => n.includes("「交接」")), "an answer the asker got while waiting is not news");

    // The person on the other side, in their own Claude, later reports back.
    const claude = await mcpClient(client, CLAUDE, relay.url);
    const listed = textOf(await claude.callTool({ name: "check_thread", arguments: {} }));
    assert.match(listed, new RegExp(`${pending.id} · 我的 Codex 问你：交接（进行中）`));
    const started = Date.now();
    const sent = textOf(
      await claude.callTool({ name: "send_message", arguments: { thread_id: pending.id, message: "做完了，已推送" } }),
    );
    assert.ok(Date.now() - started < 2000, "adding to a thread does not wait for an answer");
    assert.match(sent, /已发给我的 Codex/);
    assert.equal(runner.calls.length, 1, "the background does not answer its own side");

    // The asker's computer tells the person, and the session that asked is reminded.
    await until(async () => notes.some((n) => n === "我的 Claude 回复了 「交接」，回到问它的会话说句话就能接上"));
    const dir = mkdtempSync(join(tmpdir(), "achat-transcript-"));
    const asked = join(dir, "asked.jsonl");
    const other = join(dir, "other.jsonl");
    writeFileSync(asked, JSON.stringify({ content: `请求已发出（协作 ${pending.id}）` }) + "\n");
    writeFileSync(other, JSON.stringify({ content: "别的事" }) + "\n");
    const reminder = await userPromptHook(client, CODEX, { transcriptPath: asked });
    assert.match(reminder ?? "", new RegExp(`我的 Claude 在你之前发起的协作「交接」（${pending.id}）里有新消息`));
    assert.match(reminder ?? "", /check_thread/);
    assert.equal(await userPromptHook(client, CODEX, { transcriptPath: other }), null, "other sessions are left alone");
    assert.equal(await userPromptHook(client, CODEX), null);

    assert.match(textOf(await codex.callTool({ name: "check_thread", arguments: {} })), /你问我的 Claude：交接（进行中，有新消息）/);
    const read = textOf(await codex.callTool({ name: "check_thread", arguments: { thread_id: pending.id } }));
    assert.match(read, /我的 Claude：做完了，已推送/);
    assert.match(read, /要追问，用 send_message/);
    assert.equal(await userPromptHook(client, CODEX, { transcriptPath: asked }), null, "once seen, no more reminders");

    // The next round in the background knows what was said in the foreground.
    const next = textOf(await codex.callTool({ name: "send_message", arguments: { thread_id: pending.id, message: "上线了吗？" } }));
    assert.match(next, /已经上线了/);
    assert.match(runner.calls[1].prompt, /<added>\n做完了，已推送\n<\/added>/);
    const t = await client.getThread(pending.id);
    assert.equal(t.roundsUsed, 2, "the word in between was not a round");
    await codex.callTool({ name: "close_thread", arguments: { thread_id: pending.id } });
  });

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

test("a dialog on the computer approves or declines, one at a time, and goes away when handled on the web", async () => {
  const { relay, client, config } = await startTestRelay();
  let sidecar: Sidecar | undefined;
  try {
    const asked: ApprovalPrompt[] = [];
    const answers: ((a: Answer) => void)[] = [];
    let closed = 0;
    const runner = new ScriptedRunner(["分镜、出图、剪辑", "网页上同意的也照常回答"]);
    sidecar = new Sidecar({
      client,
      agents: config.agents,
      runners: { [CLAUDE]: runner },
      ask: (prompt) => {
        asked.push(prompt);
        let resolve!: (a: Answer) => void;
        const answer = new Promise<Answer>((r) => (resolve = r));
        answers.push(resolve);
        return {
          answer,
          close: () => {
            closed += 1;
            resolve("later");
          },
        };
      },
      notify: () => assert.fail("a dialog was shown, so no notification"),
      webUrl: relay.url,
      log: () => {},
    });
    sidecar.start();

    const first = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "对话框同意", message: "怎么做的？" });
    const second = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "对话框拒绝", message: "问题" });
    await until(async () => asked.length === 1);
    assert.deepEqual(asked[0], { title: "我的 Codex 想问你的 Claude", topic: "对话框同意", body: "怎么做的？", scope: "只读 · 5 轮 · $5.00" });
    answers[0]("approve");
    await until(async () => (await client.getThread(first.id)).status !== "pending");
    await until(async () => runner.calls.length === 1);

    await until(async () => asked.length === 2);
    answers[1]("decline");
    await until(async () => (await client.getThread(second.id)).status === "declined");

    const third = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "网页上处理", message: "问题" });
    await until(async () => asked.length === 3);
    await client.approve(third.id);
    await until(async () => closed === 1);
    assert.equal(asked.length, 3);
  } finally {
    sidecar?.stop();
    await relay.close();
  }
});

test("when the credential from achat claude-token ran out, the person is told to renew it, not to log in", () => {
  assert.equal(loginAdvice(new LoginExpiredError("claude", "401", true)), "再运行一次 achat claude-token 换个新凭证，等着的问题会自动接着回答。");
  assert.match(loginAdvice(new LoginExpiredError("codex", "401")), /codex login/);
});

test("when Claude's login runs out the thread waits, both sides are told, and the answer comes once it is back", async () => {
  const { relay, client, config } = await startTestRelay();
  const expired = new LoginExpiredError("claude", "API Error: 401 OAuth access token has expired");
  const runner = new ScriptedRunner([expired, expired, "恢复后的回答"]);
  const alerts: string[] = [];
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: runner },
    alert: (title, message) => alerts.push(`${title}｜${message}`),
    notify: () => {},
    webUrl: relay.url,
    loginRetryMs: 30,
    log: () => {},
  });
  sidecar.start();
  try {
    const codex = await mcpClient(client, CODEX, relay.url);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "登录过期", message: "问题" });
    await client.approve(t.id);
    await until(async () => runner.calls.length === 3, 5000);
    const done = await until(async () => {
      const d = await client.getThread(t.id);
      return d.messages.some((m) => m.body === "恢复后的回答") && d;
    });
    assert.equal(done.status, "active", "the thread waited instead of failing");
    assert.deepEqual(
      done.messages.filter((m) => m.kind === "system").map((m) => m.body).slice(-1),
      ["回答的 Claude 需要重新登录，登录后会自动接着回答"],
      "the asker is told once, not on every retry",
    );
    assert.deepEqual(alerts, ["你的 Claude 需要重新登录｜打开 Claude Code 发一句话就能恢复，等着的问题会自动接着回答。运行一次 achat claude-token 就不会再过期。"]);
    const checked = textOf(await codex.callTool({ name: "check_thread", arguments: { thread_id: t.id } }));
    assert.match(checked, /需要重新登录/);
  } finally {
    sidecar.stop();
    await relay.close();
  }
});
