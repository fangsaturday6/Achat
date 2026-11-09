import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RelayClientError, type RelayClient } from "../src/client.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { LOCAL_PERSON, type AchatConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RunningRelay } from "../src/relay/server.js";
import type { Answer, ApprovalPrompt } from "../src/sidecar/dialog.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import type { RelayEvent } from "../src/types.js";
import { addComputer, Browser, CLAUDE, CODEX, logIn, ScriptedRunner, startTestCloud, startTestRelay, until, type MemoryMailer } from "./helpers.js";

const HOUR = 60 * 60 * 1000;

async function mcpClient(relayClient: RelayClient, agentId: string, webUrl: string, waitSeconds = 10): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client: relayClient, agentId, webUrl, mode: "local" }), waitSeconds }).connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

describe("going on, reminding and giving up, on the relay", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let clock = Date.parse("2026-11-09T08:00:00Z");
  const events: RelayEvent[] = [];

  before(async () => {
    ({ relay, client } = await startTestRelay({}, () => new Date(clock)));
    relay.service.onEvent((e) => events.push(e));
  });
  after(() => relay.close());

  test("a request nobody handles is brought up once after 4 hours and given up after 3 days", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "没人管", message: "在吗？" });
    clock += 3 * HOUR;
    relay.service.sweep();
    assert.ok(!events.some((e) => e.type === "thread.reminded" && e.threadId === t.id));
    clock += 2 * HOUR;
    relay.service.sweep();
    relay.service.sweep();
    assert.equal(events.filter((e) => e.type === "thread.reminded" && e.threadId === t.id).length, 1);
    clock += 3 * 24 * HOUR;
    relay.service.sweep();
    const expired = await client.getThread(t.id);
    assert.equal(expired.status, "expired");
    assert.equal(expired.messages.at(-1)!.body, "3 天没人处理，已过期");
    await assert.rejects(client.postMessage(t.id, { from: CLAUDE, body: "现在才看到" }), /过期/);

    // The asker can still ask again; it waits for approval like the first time.
    const again = await client.postMessage(t.id, { from: CODEX, body: "在吗？" });
    assert.equal(again.status, "pending");
  });

  test("asking to go on that nobody handles for 3 days leaves the thread ended", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "接着聊没人管", message: "问题" });
    await client.approve(t.id, { maxRounds: 1 });
    await client.postMessage(t.id, { from: CLAUDE, body: "答案" });
    await client.postMessage(t.id, { from: CODEX, body: "再问一句" });
    clock += 3 * 24 * HOUR + 1;
    relay.service.sweep();
    const back = await client.getThread(t.id);
    assert.equal(back.status, "closed");
    assert.equal(back.prior, null);
    assert.equal(back.messages.at(-1)!.body, "3 天没人处理，没有接着聊");
  });

  test("running out of money mid-answer pauses the question for the person instead of ending", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "钱不够", message: "问题" });
    await client.approve(t.id);
    const paused = await client.askMore(t.id, "花费到了上限 $5.00，再同意一次就接着答");
    assert.equal(paused.status, "pending");
    assert.deepEqual(paused.prior, { status: "closed", mode: "answer" });
    const declined = await client.decline(t.id);
    assert.equal(declined.status, "closed");
    assert.equal(declined.messages.at(-1)!.body, "没有同意接着聊");
  });

  test("a reply the asking AI has not seen for half an hour is reported once", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "没看到的回复", message: "问题" });
    await client.approve(t.id);
    await client.postMessage(t.id, { from: CLAUDE, body: "回复" });
    assert.ok(!relay.service.unseenReplies(new Date(clock - 30 * 60 * 1000)).some((r) => r.thread.id === t.id));
    clock += 31 * 60 * 1000;
    const found = relay.service.unseenReplies(new Date(clock - 30 * 60 * 1000)).filter((r) => r.thread.id === t.id);
    assert.deepEqual(found.map((r) => r.message.body), ["回复"]);
    assert.ok(!relay.service.unseenReplies(new Date(clock)).some((r) => r.thread.id === t.id), "reported once");

    const seen = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "看到了的回复", message: "问题" });
    await client.approve(seen.id);
    const answered = await client.postMessage(seen.id, { from: CLAUDE, body: "回复" });
    await client.markSeen(seen.id, answered.messages.at(-1)!.seq);
    clock += 31 * 60 * 1000;
    assert.ok(!relay.service.unseenReplies(new Date(clock)).some((r) => r.thread.id === seen.id));
  });

  test("the person asks their own AI from the web page without approval, and writes in their AIs' threads as themselves", async () => {
    const t = await client.createRequest({ from: LOCAL_PERSON.id, to: CLAUDE, topic: "我自己问", message: "上次的视频怎么做的？" });
    assert.equal(t.status, "active");
    assert.equal(t.messages[0].byPerson, true);

    const asked = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "我插一句", message: "问题" });
    await client.approve(asked.id);
    await client.postMessage(asked.id, { from: CLAUDE, body: "答案" });
    const said = await client.postMessage(asked.id, { from: CODEX, body: "我本人再问一句", byPerson: true });
    assert.equal(said.messages.at(-1)!.byPerson, true);
    assert.equal(said.messages.at(-1)!.sender, CODEX);
  });
});

describe("going on and reminders on the receiving computer", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let config: AchatConfig;
  let sidecar: Sidecar;
  let runner: ScriptedRunner;
  let clock = Date.parse("2026-11-09T08:00:00Z");
  const notes: string[] = [];
  const asked: ApprovalPrompt[] = [];
  const answers: ((a: Answer) => void)[] = [];

  before(async () => {
    ({ relay, client, config } = await startTestRelay({}, () => new Date(clock)));
  });
  after(() => relay.close());
  afterEach(() => sidecar?.stop());

  function startSidecar(replies: (string | Error)[]): void {
    runner = new ScriptedRunner(replies);
    sidecar = new Sidecar({
      client,
      agents: config.agents,
      runners: { [CLAUDE]: runner },
      ask: (prompt) => {
        asked.push(prompt);
        let resolve!: (a: Answer) => void;
        const answer = new Promise<Answer>((r) => (resolve = r));
        answers.push(resolve);
        return { answer, close: () => resolve("later") };
      },
      notify: (title, body) => notes.push(`${title} ${body}`),
      webUrl: relay.url,
      log: () => {},
    });
    sidecar.start();
  }

  test("asking again after the rounds are used up shows the dialog again, saying why", async () => {
    startSidecar(["第一个回答", "接着的回答"]);
    const codex = await mcpClient(client, CODEX, relay.url, 1);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "用完了", message: "第一个问题" });
    await until(async () => asked.find((p) => p.topic === "用完了"));
    // Approved on the web with one round; the dialog goes away.
    await client.approve(t.id, { maxRounds: 1 });
    const closed = await until(async () => {
      const now = await client.getThread(t.id);
      return now.status === "closed" ? now : null;
    });
    assert.equal(closed.messages.at(-1)!.body, "已到 1 轮上限，协作结束");

    const reply = textOf(await codex.callTool({ name: "send_message", arguments: { thread_id: t.id, message: "第二个问题" } }));
    assert.match(reply, /同意接着聊/);
    assert.match(reply, /不用一直等/);

    const again = await until(async () => asked.filter((p) => p.topic === "用完了")[1]);
    assert.equal(again.title, "我的 Codex 想接着问你的 Claude");
    assert.equal(again.body, "第二个问题");
    assert.equal(again.reason, "已到 1 轮上限，协作结束");
    answers[asked.lastIndexOf(again)]("approve");
    await until(async () => (await client.getThread(t.id)).messages.some((m) => m.body === "接着的回答"));
    assert.equal(runner.calls.length, 2);
  });

  test("a slow answer is tried once more before the thread ends", async () => {
    startSidecar([new Error("回答超时"), "第二次答上了"]);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "慢", message: "问题" });
    await client.approve(t.id);
    await until(async () => (await client.getThread(t.id)).messages.some((m) => m.body === "第二次答上了"));
    assert.equal((await client.getThread(t.id)).status, "active");
    assert.equal(runner.calls.length, 2);
  });

  test("a request waiting for hours is brought up again on the computer", async () => {
    startSidecar([]);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "等了很久", message: "问题" });
    await until(async () => asked.find((p) => p.topic === "等了很久"));
    clock += 5 * HOUR;
    relay.service.sweep();
    await until(async () => notes.some((n) => n === "我的 Codex 还在等你批准 等了很久"));
    assert.equal((await client.getThread(t.id)).status, "pending");
  });
});

describe("the person on the web page, in the cloud", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  let fang: Browser;
  let wang: Browser;
  let fangMac: Awaited<ReturnType<typeof addComputer>>;
  // Computers sign with the real time, so the service's clock starts there.
  let clock = Date.now();

  before(async () => {
    ({ cloud, mailer } = await startTestCloud(() => new Date(clock)));
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    fangMac = await addComputer(cloud, fang, "MacBook Air", ["claude"]);
    const invite = await fangMac.client.createInvite();
    await wang.call("POST", `/api/invites/${invite.url.split("/").at(-1)}/accept`, {});
  });
  after(() => cloud.close());

  test("a person starts a conversation with a friend's AI from the web; the friend sees the person asking", async () => {
    const agents = await wang.call("GET", "/api/agents");
    const me = agents.find((a: any) => a.client === "person" && a.name === "我");
    const claude = agents.find((a: any) => a.name === "老方的 Claude");
    assert.ok(me && claude);
    const contacts = await wang.call("GET", "/api/contacts");
    assert.ok(!contacts[0].agents.some((a: any) => a.client === "person"), "a seat is not one of the AIs");

    const t = await wang.call("POST", "/api/threads", { from: me.id, to: claude.id, topic: "剪辑节奏", message: "剪辑节奏是怎么卡的？" });
    assert.equal(t.status, "pending");
    assert.equal(t.messages[0].byPerson, true);
    const mail = mailer.sent.filter((m) => m.to === "fang@example.com").at(-1)!;
    assert.match(mail.subject, /^老王想问你的 Claude：剪辑节奏/);
    const onMac = (await fangMac.client.agents()).find((a) => a.id === me.id);
    assert.equal(onMac?.name, "老王");

    // Not as someone else's seat, and not as an AI.
    await assert.rejects(wang.call("POST", "/api/threads", { from: claude.id, to: claude.id, topic: "x", message: "y" }), (e: unknown) => e instanceof RelayClientError && e.status === 403);
  });

  test("a reminder after 4 hours, and a reply nobody saw for half an hour, are mailed", async () => {
    const [me, claude] = await (async () => {
      const agents = await wang.call("GET", "/api/agents");
      return [agents.find((a: any) => a.client === "person" && a.name === "我"), agents.find((a: any) => a.name === "老方的 Claude")];
    })();
    const t = await wang.call("POST", "/api/threads", { from: me.id, to: claude.id, topic: "要提醒的", message: "问题" });
    clock += 5 * HOUR;
    await cloud.sweep();
    await until(async () => mailer.sent.some((m) => m.subject.startsWith("老王还在等你批准：要提醒的")));

    await fang.call("POST", `/api/threads/${t.id}/approve`, {});
    clock = Date.now();
    await fangMac.client.postMessage(t.id, { from: claude.id, body: "按鼓点卡" });
    clock += 31 * 60 * 1000;
    await cloud.sweep();
    const reply = await until(async () => mailer.sent.find((m) => m.to === "wang@example.com" && m.subject.startsWith("老方的 Claude 回复了你：要提醒的")));
    assert.match(reply.text, /按鼓点卡/);
    await cloud.sweep();
    assert.equal(mailer.sent.filter((m) => m.subject.startsWith("老方的 Claude 回复了你")).length, 1, "mailed once");
  });
});
