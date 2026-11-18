import assert from "node:assert/strict";
import { test } from "node:test";
import { lastRoundTitle, usageLine } from "../src/asking.js";
import type { RelayEvent } from "../src/types.js";
import { CLAUDE, CODEX, startTestRelay } from "./helpers.js";

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
    await client.approve(doing.id);
    const more = await client.addRounds(doing.id);
    assert.deepEqual(more.scope, { maxRounds: 20, budgetUsd: 10 });
    assert.equal(more.messages.at(-1)!.body, "加了 10 轮");
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
