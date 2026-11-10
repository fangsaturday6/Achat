import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RelayClient } from "../src/client.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { userPromptHook } from "../src/hook.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RunningRelay } from "../src/relay/server.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import type { ThreadDetail } from "../src/types.js";
import { addComputer, Browser, CLAUDE, CODEX, logIn, ScriptedRunner, startTestCloud, startTestRelay, until, type MemoryMailer } from "./helpers.js";

// The other side's person writes in a thread to the AI that asked: that AI,
// or its computer in the background, answers them, and the answer does not
// wake the other side's AI.

async function mcpClient(relayClient: RelayClient, agentId: string, webUrl: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client: relayClient, agentId, webUrl, mode: "local" }), waitSeconds: 10 }).connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

function lastSpoken(t: ThreadDetail) {
  return t.messages.filter((m) => m.kind !== "system").at(-1)!;
}

describe("the asked side's person and the AI that asked, on the relay", () => {
  let relay: RunningRelay;
  let client: RelayClient;

  before(async () => {
    ({ relay, client } = await startTestRelay());
  });
  after(() => relay.close());

  // Claude asked Codex, Codex answered, and Codex's person then wrote.
  async function personAsked(topic: string, maxRounds?: number): Promise<string> {
    const t = await client.createRequest({ from: CLAUDE, to: CODEX, topic, message: "问题" });
    await client.approve(t.id, maxRounds ? { maxRounds } : {});
    await client.postMessage(t.id, { from: CODEX, body: "答案" });
    await client.postMessage(t.id, { from: CODEX, body: "mr是什么", byPerson: true });
    return t.id;
  }

  test("the asker's next word answers the person: no round, and the asker may ask the other AI right after", async () => {
    const id = await personAsked("回本人");
    const reply = await client.postMessage(id, { from: CLAUDE, body: "MR 是合并请求" });
    assert.equal(lastSpoken(reply).toPerson, true);
    assert.equal(lastSpoken(reply).kind, "message");
    assert.equal(reply.roundsUsed, 1);
    assert.equal(reply.status, "active");

    const asked = await client.postMessage(id, { from: CLAUDE, body: "那分支呢？" });
    assert.equal(lastSpoken(asked).toPerson, false);
    const answered = await client.postMessage(id, { from: CODEX, body: "分支在 release" });
    assert.equal(answered.roundsUsed, 2);
  });

  test("answering the person in a thread that ended keeps it ended instead of asking to go on", async () => {
    const id = await personAsked("结束后回本人", 1);
    assert.equal((await client.getThread(id)).status, "closed");
    const reply = await client.postMessage(id, { from: CLAUDE, body: "MR 是合并请求" });
    assert.equal(reply.status, "closed");
    assert.equal(lastSpoken(reply).toPerson, true);
  });

  test("the asked side's computer does not answer what was said to its person", async () => {
    const id = await personAsked("不叫醒");
    await client.postMessage(id, { from: CLAUDE, body: "MR 是合并请求" });
    const runner = new ScriptedRunner(["不该有这一轮"]);
    const sidecar = new Sidecar({ client, agents: [], runners: { [CODEX]: runner }, notify: () => {}, webUrl: relay.url, log: () => {} });
    await sidecar.answer(id);
    sidecar.stop();
    assert.equal(runner.calls.length, 0);
  });

  test("against a relay from before answers to a person, the computer only tells its person", async (t) => {
    // An older relay sends messages without toPerson, and would take the
    // answer as a question for the other AI.
    const real = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const res = await real(input, init);
      if ((init?.method ?? "GET") !== "GET" || !/\/api\/threads\/[^/]+$/.test(new URL(String(input)).pathname)) return res;
      const thread = await res.json();
      for (const m of thread.messages) delete m.toPerson;
      return new Response(JSON.stringify(thread), { status: res.status, headers: { "content-type": "application/json" } });
    });
    const runner = new ScriptedRunner(["不该答"]);
    const notes: string[] = [];
    const sidecar = new Sidecar({
      client,
      agents: [],
      runners: { [CLAUDE]: runner },
      notify: (title) => notes.push(title),
      webUrl: relay.url,
      seenWaitMs: 100,
      log: () => {},
    });
    sidecar.start();
    t.after(() => sidecar.stop());
    await personAsked("旧服务");
    await until(async () => notes.some((n) => n.endsWith("回复了")));
    assert.equal(runner.calls.length, 0);
  });
});

describe("the other side's person asks the AI that asked, in the cloud", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  let fang: Browser;
  let wang: Browser;
  let fangMac: Awaited<ReturnType<typeof addComputer>>;
  let wangPc: Awaited<ReturnType<typeof addComputer>>;
  let fangClaude: string;
  let wangCodex: string;
  let sidecar: Sidecar | null = null;
  const notes: string[] = [];
  // Computers sign with the real time, so the service's clock starts there.
  let clock = Date.now();

  before(async () => {
    ({ cloud, mailer } = await startTestCloud(() => new Date(clock)));
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    fangMac = await addComputer(cloud, fang, "MacBook Air", ["claude"]);
    wangPc = await addComputer(cloud, wang, "PC", ["codex"]);
    fangClaude = fangMac.agent("claude");
    wangCodex = wangPc.agent("codex");
    const invite = await fangMac.client.createInvite();
    await wang.call("POST", `/api/invites/${invite.url.split("/").at(-1)}/accept`, {});
  });
  afterEach(() => {
    sidecar?.stop();
    sidecar = null;
  });
  after(() => cloud.close());

  // 老方's Claude asked 老王's Codex, which answered while it waited.
  async function asked(topic: string): Promise<string> {
    const t = await fangMac.client.createRequest({ from: fangClaude, to: wangCodex, topic, message: "能接手吗？" });
    await wang.call("POST", `/api/threads/${t.id}/approve`, {});
    const answered = await wangPc.client.postMessage(t.id, { from: wangCodex, body: "可以接" });
    await fangMac.client.markSeen(t.id, answered.messages.at(-1)!.seq);
    return t.id;
  }

  // Read on 老方's web page: a computer's signed reads of the same thread in
  // the same millisecond would be taken for one sent twice.
  function read(id: string): Promise<ThreadDetail> {
    return fang.call("GET", `/api/threads/${id}`);
  }

  // 老王 himself writes on the web page, in the box that says 发给老方的 Claude.
  async function wangSays(id: string, body: string): Promise<ThreadDetail> {
    return wang.call("POST", `/api/threads/${id}/messages`, { from: wangCodex, body, byPerson: true });
  }

  function startSidecar(replies: (string | Error)[]): ScriptedRunner {
    const runner = new ScriptedRunner(replies);
    sidecar = new Sidecar({
      client: fangMac.client,
      agents: [],
      runners: { [fangClaude]: runner },
      notify: (title, body) => notes.push(`${title} ${body}`),
      webUrl: cloud.url,
      seenWaitMs: 300,
      relayRetryMs: 50,
      log: () => {},
    });
    sidecar.start();
    return runner;
  }

  test("a question that came while the computer was away is answered once it connects", async () => {
    const id = await asked("不在的时候");
    await wangSays(id, "什么时候上线？");
    startSidecar(["这个要老方定，我转告他"]);
    const t = await until(async () => {
      const now = await read(id);
      return lastSpoken(now).sender === fangClaude && now;
    });
    assert.equal(lastSpoken(t).toPerson, true);
  });

  test("a minute on, the computer that asked answers the person from this thread, and tells its own person", async () => {
    const runner = startSidecar(["MR 是 GitLab 的合并请求，就是把四个分支合到 release"]);
    const id = await asked("合并上线");
    const before = await read(id);
    await wangSays(id, "mr是什么");

    const t = await until(async () => {
      const now = await read(id);
      return lastSpoken(now).sender === fangClaude && now;
    });
    assert.equal(lastSpoken(t).body, "MR 是 GitLab 的合并请求，就是把四个分支合到 release");
    assert.equal(lastSpoken(t).toPerson, true);
    assert.equal(t.roundsUsed, before.roundsUsed, "not a round of 老王's Codex");
    assert.equal(t.askerSeen, before.askerSeen, "the session that asked is still told when it comes back");

    const call = runner.calls[0];
    assert.equal(call.only, id, "reads only the conversations about this thread");
    assert.equal(call.budgetUsd, 1);
    assert.match(call.prompt, /能接手吗？/);
    assert.match(call.prompt, /老王本人/);
    assert.match(call.prompt, /mr是什么/);
    assert.match(call.systemPrompt, /老方定/);
    await until(async () => notes.includes("老王问了我的 Claude mr是什么"));
    assert.ok(!notes.some((n) => n.includes("回复了") && n.includes("合并上线")), "no reminder to go back for it");
  });

  test("when the session that asked picks it up within the minute, the computer does not answer it again", async () => {
    const runner = startSidecar(["不该答"]);
    const id = await asked("前台在等");
    const said = await wangSays(id, "今天能合吗？");
    await fangMac.client.markSeen(id, said.messages.at(-1)!.seq);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(runner.calls.length, 0);
    assert.ok(!notes.some((n) => n.includes("今天能合吗")));
  });

  test("the AI that asked answers the person without waiting, and 老王's Codex is not asked", async () => {
    const id = await asked("前台回本人");
    const claude = await mcpClient(fangMac.client, fangClaude, cloud.url);

    // Waiting for an answer, it gets the person's words, and is told how to answer them.
    const asking = claude.callTool({ name: "send_message", arguments: { thread_id: id, message: "哪天开始？" } });
    await until(async () => lastSpoken(await read(id)).body === "哪天开始？");
    await wangSays(id, "你先说下 mr 是什么");
    const got = textOf(await asking);
    assert.match(got, /这条是老王本人写的/);
    assert.match(got, /回他用 send_message/);

    const shown = textOf(await claude.callTool({ name: "check_thread", arguments: { thread_id: id } }));
    assert.match(shown, /老王本人：你先说下 mr 是什么/);
    assert.match(shown, /老王本人在问你，回他用 send_message/);

    const started = Date.now();
    const sent = textOf(await claude.callTool({ name: "send_message", arguments: { thread_id: id, message: "MR 是合并请求" } }));
    assert.ok(Date.now() - started < 2000, "an answer to the person does not wait");
    assert.match(sent, /已回给老王/);
    const t = await read(id);
    assert.equal(lastSpoken(t).toPerson, true);
  });

  test("the reminder in the session that asked names the person", async () => {
    const id = await asked("提醒叫法");
    await wangSays(id, "mr是什么");
    const transcript = join(mkdtempSync(join(tmpdir(), "achat-transcript-")), "asked.jsonl");
    writeFileSync(transcript, JSON.stringify({ content: `请求已发出（协作 ${id}）` }) + "\n");
    const reminder = await userPromptHook(fangMac.client, fangClaude, { transcriptPath: transcript });
    assert.match(reminder ?? "", new RegExp(`老王本人在你之前发起的协作「提醒叫法」（${id}）里有新消息`));
  });

  test("when the computer cannot answer, its person is told under the person's name", async () => {
    startSidecar([new Error("claude 意外退出"), new Error("claude 意外退出")]);
    const id = await asked("答不了");
    await wangSays(id, "mr是什么");
    await until(async () => notes.includes("老王回复了 「答不了」，回到问它的会话说句话就能接上"));
  });

  test("half an hour on, the person's words are mailed under their name, unless they were answered", async () => {
    clock = Date.now();
    const unanswered = await asked("没人回的");
    await wangSays(unanswered, "mr是什么");
    const answered = await asked("回过的");
    await wangSays(answered, "mr是什么");
    await fangMac.client.postMessage(answered, { from: fangClaude, body: "MR 是合并请求" });
    clock += 31 * 60 * 1000;
    await cloud.sweep();
    await until(async () => mailer.sent.some((m) => m.to === "fang@example.com" && m.subject === "老王回复了你的 Claude：没人回的"));
    assert.ok(!mailer.sent.some((m) => m.subject.endsWith("：回过的")));
  });
});
