import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RelayClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp/server.js";
import { lastRoundTitle, usageLine } from "../src/asking.js";
import type { RelayEvent } from "../src/types.js";
import type { Choice, ChoicePrompt } from "../src/sidecar/dialog.js";
import type { RunInput, RunOutput } from "../src/sidecar/runners.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { CLAUDE, CODEX, ScriptedRunner, startTestRelay, until } from "./helpers.js";

test("the asker's question that opens the last round says so, and the asked side's person adds ten more", async () => {
  const { relay, client } = await startTestRelay();
  const events: RelayEvent[] = [];
  const off = relay.service.onEvent((e) => events.push(e));
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    await client.postMessage(t.id, { from: CLAUDE, body: "先写分镜", costUsd: 0.1 });
    assert.equal(events.filter((e) => e.type === "thread.lastRound").length, 0, "rounds left");

    const last = await client.postMessage(t.id, { from: CODEX, body: "封面图怎么出的？" });
    assert.deepEqual(
      last.messages.slice(-2).map((m) => [m.kind, m.body]),
      [
        ["system", "最后 1 轮"],
        ["message", "封面图怎么出的？"],
      ],
    );
    const opened = events.filter((e) => e.type === "thread.lastRound");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].seq, last.messages.at(-1)!.seq);

    const more = await client.addRounds(t.id);
    assert.deepEqual(more.scope, { maxRounds: 12, budgetUsd: 11 });
    assert.equal(more.messages.at(-1)!.body, "加了 10 轮 · $10.00");

    const answered = await client.postMessage(t.id, { from: CLAUDE, body: "用 Midjourney 出的", costUsd: 0.1 });
    assert.equal(answered.status, "active", "more rounds, so it goes on");
    assert.equal(answered.roundsUsed, 2);
  } finally {
    off();
    await relay.close();
  }
});

test("rounds that just ran out can still be added; a thread waiting or stopped cannot; 动手 gets no money", async () => {
  const { relay, client } = await startTestRelay();
  try {
    const pending = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "还没批", message: "问题" });
    await assert.rejects(client.addRounds(pending.id), /进行中/);

    const ran = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "一轮就完", message: "问题" });
    await client.approve(ran.id, { maxRounds: 1, budgetUsd: 1 });
    const closed = await client.postMessage(ran.id, { from: CLAUDE, body: "答完了", costUsd: 0.1 });
    assert.equal(closed.status, "closed");
    const reopened = await client.addRounds(ran.id);
    assert.equal(reopened.status, "active");
    assert.equal(reopened.scope.maxRounds, 11);
    await client.postMessage(ran.id, { from: CODEX, body: "接着问" });
    assert.equal((await client.getThread(ran.id)).status, "active", "a question, not a request to go on");

    const stopped = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "停了", message: "问题" });
    await client.approve(stopped.id);
    await client.stop(stopped.id);
    await assert.rejects(client.addRounds(stopped.id), /进行中/);

    const doing = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "写脚本", message: "写一个", mode: "do" });
    await client.approve(doing.id, { maxRounds: 1 });
    const more = await client.addRounds(doing.id);
    assert.deepEqual(more.scope, { maxRounds: 11, budgetUsd: 10 });
    assert.equal(more.messages.at(-1)!.body, "加了 10 轮");
  } finally {
    await relay.close();
  }
});

test("one rule: 加 10 轮 shows when the last round opens or the allowance ran out, money included, never between one's own AIs", async () => {
  const { relay, client } = await startTestRelay();
  try {
    const early = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "还早", message: "问题" });
    await client.approve(early.id);
    assert.equal((await client.getThread(early.id)).canAddRounds, false);
    await assert.rejects(client.addRounds(early.id), /还没到最后一轮/);

    const broke = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "钱用完", message: "问题" });
    await client.approve(broke.id, { maxRounds: 5, budgetUsd: 0.5 });
    const closed = await client.postMessage(broke.id, { from: CLAUDE, body: "答了", costUsd: 0.5 });
    assert.equal(closed.status, "closed");
    assert.ok(closed.roundsUsed < closed.scope.maxRounds);
    assert.equal(closed.canAddRounds, true);
    const revived = await client.addRounds(broke.id);
    assert.equal(revived.status, "active");
    assert.deepEqual(revived.scope, { maxRounds: 15, budgetUsd: 10.5 });
    assert.equal(revived.canAddRounds, false);

    const own = await relay.service.createRequest({ from: CODEX, to: CLAUDE, topic: "自己的", message: "问题" }, { autoApprove: true });
    assert.equal(own.canAddRounds, false);
    await assert.rejects(client.addRounds(own.id), /自己的 AI 之间不用加轮数/);
  } finally {
    await relay.close();
  }
});

test("lastRound is true only while the asker's last question waits for its answer, in details and in lists", async () => {
  const { relay, client } = await startTestRelay();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "最后一轮", message: "第一步？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    assert.equal((await client.getThread(t.id)).lastRound, false, "before the question");
    await client.postMessage(t.id, { from: CLAUDE, body: "先写分镜", costUsd: 0.1 });
    assert.equal((await client.getThread(t.id)).lastRound, false);
    await client.postMessage(t.id, { from: CODEX, body: "封面图？" });
    const detail = await client.getThread(t.id);
    assert.equal(detail.lastRound, true);
    assert.equal(detail.canAddRounds, true);
    const row = (await client.listThreads({ agent: CLAUDE })).find((r) => r.id === t.id)!;
    assert.equal(row.lastRound, true);
    assert.equal(row.canAddRounds, true);
    const answered = await client.postMessage(t.id, { from: CLAUDE, body: "Midjourney", costUsd: 0.1 });
    assert.equal(answered.lastRound, false);
    const after = (await client.listThreads({ agent: CLAUDE })).find((r) => r.id === t.id)!;
    assert.equal(after.lastRound, false);
    assert.equal(after.canAddRounds, true, "ran out");
  } finally {
    await relay.close();
  }
});

test("the last-round dialog names both AIs and what was used", () => {
  assert.equal(lastRoundTitle("老王的 Codex", "你的 Claude"), "老王的 Codex 和你的 Claude 到最后 1 轮了");
  const t = { mode: "answer" as const, roundsUsed: 9, costUsd: 3.2, scope: { maxRounds: 10, budgetUsd: 10 } };
  assert.equal(usageLine(t), "问答 · 9 / 10 轮 · $3.20 / $10.00");
  assert.equal(usageLine({ ...t, mode: "do" }), "动手 · 9 / 10 轮");
});

// Holds the second answer until the test lets it go, so the dialog is shown
// while the last round is still being answered.
class HeldRunner extends ScriptedRunner {
  private release!: () => void;
  private held = new Promise<void>((r) => (this.release = r));
  letGo(): void {
    this.release();
  }
  async run(input: RunInput): Promise<RunOutput> {
    if (this.calls.length === 1) await this.held;
    return super.run(input);
  }
}

test("the computer asks once, when the last round opens, and 加 10 轮 lets the thread go on", async () => {
  const { relay, client, config } = await startTestRelay();
  const asked: ChoicePrompt[] = [];
  const answers: ((c: Choice) => void)[] = [];
  const runner = new HeldRunner(["先写分镜", "用 Midjourney 出的"]);
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: runner },
    choose: (prompt) => {
      asked.push(prompt);
      let resolve!: (c: Choice) => void;
      const answer = new Promise<Choice>((r) => (resolve = r));
      answers.push(resolve);
      return { answer, close: () => resolve("stop") };
    },
    notify: () => {},
    webUrl: relay.url,
    log: () => {},
  });
  sidecar.start();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);
    assert.equal(asked.length, 0, "rounds left, nothing to ask");

    await client.postMessage(t.id, { from: CODEX, body: "封面图怎么出的？" });
    await until(async () => asked.length === 1);
    assert.deepEqual(asked[0], {
      icon: "answer",
      title: "我的 Codex 和你的 Claude 到最后 1 轮了",
      body: "视频制作流程\n\n问答 · 1 / 2 轮 · $0.05 / $1.00",
      more: "加 10 轮",
      stop: "用完就停",
    });
    answers[0]("more");
    await until(async () => (await client.getThread(t.id)).scope.maxRounds === 12);

    runner.letGo();
    const done = await until(async () => {
      const d = await client.getThread(t.id);
      return d.roundsUsed === 2 ? d : null;
    });
    assert.equal(done.status, "active");
    assert.equal(asked.length, 1, "asked once");
  } finally {
    sidecar.stop();
    await relay.close();
  }
});

test("where no dialog can be shown, a notification points to the conversation", async () => {
  const { relay, client, config } = await startTestRelay();
  const told: string[][] = [];
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: new ScriptedRunner(["先写分镜", "用 Midjourney 出的"]) },
    choose: () => null,
    notify: (title, body, url) => told.push([title, body, url]),
    webUrl: relay.url,
    log: () => {},
  });
  sidecar.start();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);
    await client.postMessage(t.id, { from: CODEX, body: "封面图怎么出的？" });
    await until(async () => told.some(([title]) => title.includes("最后 1 轮")));
    assert.deepEqual(
      told.find(([title]) => title.includes("最后 1 轮")),
      ["我的 Codex 和你的 Claude 到最后 1 轮了", "视频制作流程", `${relay.url}/#/t/${t.id}`],
    );
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

test("the asked AI adds ten rounds with add_rounds when its person says so", async () => {
  const { relay, client } = await startTestRelay();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    const claude = await mcp(client, CLAUDE, relay.url);
    const early = await claude.callTool({ name: "add_rounds", arguments: { thread_id: t.id } });
    assert.equal(early.isError, true);
    assert.match(textOf(early), /还没到最后一轮/);
    await client.postMessage(t.id, { from: CLAUDE, body: "先写分镜", costUsd: 0.1 });
    const added = await claude.callTool({ name: "add_rounds", arguments: { thread_id: t.id } });
    assert.equal(textOf(added), `协作 ${t.id} 加了 10 轮 · $10.00，现在最多 12 轮 · $11.00。`);

    const codex = await mcp(client, CODEX, relay.url);
    const refused = await codex.callTool({ name: "add_rounds", arguments: { thread_id: t.id } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /不是别人问你的协作/);
  } finally {
    await relay.close();
  }
});

// A sidecar whose dialog counts how often it was closed from outside.
async function withLastRoundDialog(body: (ctx: { client: RelayClient; runner: HeldRunner; closes: () => number; asked: () => number; threadId: string }) => Promise<void>) {
  const { relay, client, config } = await startTestRelay();
  let asked = 0;
  let closes = 0;
  const runner = new HeldRunner(["先写分镜", "用 Midjourney 出的"]);
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: runner },
    choose: () => {
      asked++;
      let resolve!: (c: Choice) => void;
      const answer = new Promise<Choice>((r) => (resolve = r));
      return {
        answer,
        close: () => {
          closes++;
          resolve("stop");
        },
      };
    },
    notify: () => {},
    webUrl: relay.url,
    log: () => {},
  });
  sidecar.start();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);
    await client.postMessage(t.id, { from: CODEX, body: "封面图怎么出的？" });
    await until(async () => asked === 1);
    await body({ client, runner, closes: () => closes, asked: () => asked, threadId: t.id });
  } finally {
    sidecar.stop();
    await relay.close();
  }
}

test("the last-round dialog goes away once the rounds were added elsewhere, and 加 10 轮 is not added twice", async () => {
  await withLastRoundDialog(async ({ client, runner, closes, threadId }) => {
    await client.addRounds(threadId);
    await until(async () => closes() === 1);
    runner.letGo();
    const done = await until(async () => {
      const d = await client.getThread(threadId);
      return d.roundsUsed === 2 ? d : null;
    });
    assert.equal(done.scope.maxRounds, 12);
    assert.equal(done.status, "active");
  });
});

test("the last-round dialog goes away once the thread was stopped", async () => {
  await withLastRoundDialog(async ({ client, closes, threadId }) => {
    await client.stop(threadId);
    await until(async () => closes() === 1);
  });
});

test("the last-round dialog stays when the last answer uses the rounds up, so 加 10 轮 can still be chosen", async () => {
  await withLastRoundDialog(async ({ client, runner, closes, threadId }) => {
    runner.letGo();
    await until(async () => {
      const d = await client.getThread(threadId);
      return d.roundsUsed === 2 && d.status === "closed" ? d : null;
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(closes(), 0);
  });
});
