import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import { RelayClient, RelayClientError } from "../src/client.js";
import type { RunningRelay } from "../src/relay/server.js";
import { CLAUDE, CODEX, startTestRelay } from "./helpers.js";

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("relay", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let token: string;

  before(async () => {
    const started = await startTestRelay();
    relay = started.relay;
    client = started.client;
    token = started.config.token;
  });
  after(() => relay.close());

  test("rejects requests without the token or for another host", async () => {
    assert.equal(await rawGet(relay.port, "/api/agents", { host: `127.0.0.1:${relay.port}` }), 401);
    assert.equal(
      await rawGet(relay.port, "/api/agents", { host: `127.0.0.1:${relay.port}`, "x-achat-token": token }),
      200,
    );
    assert.equal(await rawGet(relay.port, "/api/agents", { host: "evil.example:80", "x-achat-token": token }), 403);
    assert.equal(await rawGet(relay.port, "/", { host: "evil.example:80" }), 403);
  });

  test("serves the web page with the token filled in", async () => {
    const res = await fetch(`${relay.url}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes(token));
    assert.ok(!html.includes("__ACHAT_TOKEN__"));
  });

  test("runs a request through approval, rounds and the round limit", async () => {
    const created = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "怎么做的？" });
    assert.equal(created.status, "pending");
    await assert.rejects(client.postMessage(created.id, { from: CLAUDE, body: "抢答" }), /还没被批准/);

    const approved = await client.approve(created.id, { maxRounds: 2, budgetUsd: 1 });
    assert.equal(approved.status, "active");
    assert.deepEqual(approved.scope, { maxRounds: 2, budgetUsd: 1 });

    await assert.rejects(client.postMessage(created.id, { from: CODEX, body: "再问一句" }), /还没轮到你/);
    let t = await client.postMessage(created.id, { from: CLAUDE, body: "第一轮回答", costUsd: 0.1, sessionId: "s1" });
    assert.equal(t.roundsUsed, 1);
    assert.equal(t.responderSession, "s1");

    t = await client.postMessage(created.id, { from: CODEX, body: "追问" });
    t = await client.postMessage(created.id, { from: CLAUDE, body: "第二轮回答", costUsd: 0.1 });
    assert.equal(t.status, "closed");
    assert.equal(t.roundsUsed, 2);
    assert.equal(t.costUsd, 0.2);
    assert.match(t.messages.at(-1)!.body, /2 轮上限/);
    await assert.rejects(client.postMessage(created.id, { from: CODEX, body: "还有吗" }), /已经结束/);
  });

  test("closes when the budget runs out", async () => {
    const t0 = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "预算", message: "问题" });
    await client.approve(t0.id, { budgetUsd: 0.5 });
    const t = await client.postMessage(t0.id, { from: CLAUDE, body: "很贵的回答", costUsd: 0.6 });
    assert.equal(t.status, "closed");
    assert.match(t.messages.at(-1)!.body, /花费到了上限/);
  });

  test("decline and stop end a thread with a note", async () => {
    const a = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "拒绝", message: "问题" });
    const declined = await client.decline(a.id);
    assert.equal(declined.status, "declined");
    await assert.rejects(client.approve(a.id), /已经处理过/);

    const b = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "停止", message: "问题" });
    await client.approve(b.id);
    const stopped = await client.stop(b.id);
    assert.equal(stopped.status, "stopped");
    assert.match(stopped.messages.at(-1)!.body, /停止/);
  });

  test("wait returns as soon as the other side answers", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "等待", message: "问题" });
    await client.approve(t.id);
    const lastSeq = (await client.getThread(t.id)).messages.at(-1)!.seq;
    const waiting = client.wait(t.id, lastSeq, 10_000);
    setTimeout(() => void client.postMessage(t.id, { from: CLAUDE, body: "答案" }), 50);
    const started = Date.now();
    const detail = await waiting;
    assert.ok(Date.now() - started < 5000);
    assert.equal(detail.messages.at(-1)!.body, "答案");
  });

  test("validates scope and participants", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "校验", message: "问题" });
    await assert.rejects(client.approve(t.id, { maxRounds: 0 }), /轮数/);
    await assert.rejects(client.createRequest({ from: CODEX, to: CODEX, topic: "x", message: "y" }), /自己/);
    await assert.rejects(client.createRequest({ from: "nobody", to: CLAUDE, topic: "x", message: "y" }), /不认识/);
  });
});

describe("relay limits", () => {
  test("keeps extra requests from one contact quiet and blocks floods", async () => {
    const { relay, client } = await startTestRelay({ limits: { surfacedPerContactPerDay: 2, sentPerDay: 3 } });
    try {
      const quietness: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: `第 ${i + 1} 个`, message: "问题" });
        quietness.push(t.quiet);
      }
      assert.deepEqual(quietness, [false, false, true]);
      const surfaced = await client.listThreads({ to: CLAUDE, status: "pending", surfaced: true });
      assert.equal(surfaced.length, 2);
      await assert.rejects(
        client.createRequest({ from: CODEX, to: CLAUDE, topic: "第 4 个", message: "问题" }),
        (err: unknown) => err instanceof RelayClientError && err.status === 429,
      );
    } finally {
      await relay.close();
    }
  });
});
