import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { RelayClient, RelayClientError } from "../src/client.js";
import type { RunningRelay } from "../src/relay/server.js";
import { Store } from "../src/relay/store.js";
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
    // Asking again once the rounds are used up asks the person to go on, with
    // a fresh allowance once they agree.
    t = await client.postMessage(created.id, { from: CODEX, body: "还有吗" });
    assert.equal(t.status, "pending");
    assert.deepEqual(t.prior, { status: "closed", mode: "answer" });
    assert.equal(t.messages.at(-1)!.kind, "request");
    t = await client.approve(created.id, { maxRounds: 3 });
    assert.equal(t.status, "active");
    assert.equal(t.roundsUsed, 0);
    assert.equal(t.costUsd, 0);
    assert.equal(t.prior, null);
  });

  test("the asked side can add to a thread at any time, without using a round", async () => {
    const created = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "交接", message: "能接手吗？" });
    await client.approve(created.id, { maxRounds: 2, budgetUsd: 1 });
    await client.postMessage(created.id, { from: CLAUDE, body: "可以，做完告诉你", costUsd: 0.1 });

    let t = await client.postMessage(created.id, { from: CLAUDE, body: "做完了，已推送" });
    assert.equal(t.roundsUsed, 1, "adding to an answer is not a round");
    assert.equal(t.costUsd, 0.1);
    assert.equal(t.status, "active");

    await client.postMessage(created.id, { from: CODEX, body: "什么时候上线？" });
    t = await client.postMessage(created.id, { from: CLAUDE, body: "下周", costUsd: 0.1 });
    assert.equal(t.status, "closed");

    t = await client.postMessage(created.id, { from: CLAUDE, body: "已经上线了" });
    assert.equal(t.status, "closed", "a word after the end does not open it again");
    assert.equal(t.messages.at(-1)!.body, "已经上线了");
    t = await client.postMessage(created.id, { from: CODEX, body: "好的，再问一句" });
    assert.equal(t.status, "pending", "asking after the end asks the person to go on");
    t = await client.decline(created.id);
    assert.equal(t.status, "closed");
    assert.equal(t.messages.at(-1)!.body, "没有同意接着聊");

    const stopped = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "停掉的", message: "问题" });
    await client.approve(stopped.id);
    await client.stop(stopped.id);
    await assert.rejects(client.postMessage(stopped.id, { from: CLAUDE, body: "补一句" }), /停止/);
  });

  test("a message tried again after its reply was lost is not posted twice", async () => {
    const created = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "重试", message: "问题" });
    await client.approve(created.id);
    await client.postMessage(created.id, { from: CLAUDE, body: "答案", costUsd: 0.1 });
    await assert.rejects(client.postMessage(created.id, { from: CLAUDE, body: "答案", costUsd: 0.1 }), /已经发过/);
    const t = await client.getThread(created.id);
    assert.equal(t.messages.filter((m) => m.body === "答案").length, 1);
    assert.equal(t.costUsd, 0.1);
  });

  test("keeps how far the asking AI has seen, and lists threads with news from the other side", async () => {
    const created = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "看到哪了", message: "问题" });
    await client.approve(created.id);
    const unseen = async () => (await client.listThreads({ unseen: CODEX })).map((t) => t.id);
    assert.ok(!(await unseen()).includes(created.id), "its own request and Achat's notes are not news");

    const answered = await client.postMessage(created.id, { from: CLAUDE, body: "答案" });
    assert.ok((await unseen()).includes(created.id));
    assert.equal((await client.listThreads({ unseen: CLAUDE })).length, 0, "only the asker's threads");

    await client.markSeen(created.id, answered.messages.at(-1)!.seq);
    assert.ok(!(await unseen()).includes(created.id));
    const t = await client.getThread(created.id);
    assert.equal(t.askerSeen, answered.messages.at(-1)!.seq);
    assert.equal(t.updatedAt, answered.updatedAt, "seeing a thread does not move it up the list");
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

test("threads from before the asking AI's place was kept count as seen", () => {
  const path = join(mkdtempSync(join(tmpdir(), "achat-old-")), "achat.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, topic TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      status TEXT NOT NULL, max_rounds INTEGER NOT NULL, budget_usd REAL NOT NULL, rounds_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, responder_session TEXT, quiet INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id),
      seq INTEGER NOT NULL, sender TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, redactions INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (thread_id, seq));
    INSERT INTO threads VALUES ('t1', '旧的', '${CODEX}', '${CLAUDE}', 'active', 5, 5, 1, 0, NULL, 0, 'x', 'x');
    INSERT INTO messages (thread_id, seq, sender, kind, body, created_at) VALUES
      ('t1', 1, '${CODEX}', 'request', '问题', 'x'), ('t1', 2, '${CLAUDE}', 'message', '答案', 'x');
  `);
  old.close();
  const store = new Store(path);
  try {
    assert.equal(store.getThread("t1")!.askerSeen, 2);
    assert.equal(store.listThreads({ unseen: CODEX }).length, 0);
  } finally {
    store.close();
  }
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
