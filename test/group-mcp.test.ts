import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RelayClient } from "../src/client.js";
import { userPromptHook } from "../src/hook.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { Answer } from "../src/sidecar/dialog.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { actKey, TaskBook, type TaskOpener, type TaskRecord, type TaskStart } from "../src/sidecar/tasks.js";
import { addComputer, type Browser, JudgingRunner, logIn, ScriptedRunner, startTestCloud, until } from "./helpers.js";

// `task`: the 动手 it does, as a 动手 conversation's MCP server finds in the TaskBook.
async function mcp(client: RelayClient, agentId: string, task: { key: string; given: number } | null = null): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client, agentId, webUrl: "https://achat.test", mode: "cloud" }), waitSeconds: 10, task: () => task }).connect(serverSide);
  const c = new Client({ name: "test", version: "1" });
  await c.connect(clientSide);
  return c;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

async function befriend(a: Browser, b: Browser, bEmail: string): Promise<void> {
  await a.call("POST", "/api/invites", { email: bEmail });
  const request = (await b.call("GET", "/api/invites")).find((f: any) => f.direction === "in" && f.status === "pending");
  await b.call("POST", `/api/invites/${request.id}/accept`, {});
}

class FakeOpener implements TaskOpener {
  starts: TaskStart[] = [];
  async open(start: TaskStart): Promise<TaskRecord> {
    this.starts.push(start);
    return { sessionId: `session-${this.starts.length}`, dir: start.from?.dir ?? `/tmp/${start.topic}` };
  }
}

test("an AI makes a group, talks in it, reads it, sets its 每天次数 and 叫停, with the tools", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
  const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
  const wangCodex = wangLaptop.agent("codex");
  // 老王's computer is on and answers; 老方's Codex is not.
  let connected = false;
  const stayOn = wangLaptop.client.subscribe(undefined, () => {}, () => (connected = true));
  const sidecar = new Sidecar({
    client: wangLaptop.client,
    agents: [],
    runners: { [wangCodex]: new ScriptedRunner(["订单和回调在我这边", "微信还没商户号"]) },
    notify: () => {},
    webUrl: cloud.url,
    log: () => {},
  });
  sidecar.start();
  try {
    await until(async () => connected);
    const ai = await mcp(fangMac.client, fangMac.agent("claude"));

    const creating = ai.callTool({ name: "create_group", arguments: { name: "支付对接", members: ["老王", "我的 Codex"], message: "@所有人 说说现状" } });
    const invited = await until(async () => (await wang.call("GET", "/api/groups")).find((g: any) => g.role === "invited"));
    await wang.call("POST", `/api/groups/${invited.id}/invites/${invited.myInvite.id}/accept`, { agents: [wangCodex] });
    const created = textOf(await creating);
    assert.match(created, /已建群「支付对接」/);
    assert.match(created, /老王的 Codex：\n订单和回调在我这边/);
    assert.match(created, /我的 Codex 不在线/);
    // What create_group brought back is no news for the session that made the group.
    const made = join(mkdtempSync(join(tmpdir(), "achat-transcript-")), "made.jsonl");
    writeFileSync(made, JSON.stringify({ content: created }) + "\n");
    assert.equal(await userPromptHook(fangMac.client, fangMac.agent("claude"), { transcriptPath: made }), null);

    const said = textOf(await ai.callTool({ name: "send_group_message", arguments: { group: "支付对接", message: "@老王的 Codex 微信呢", mentions: ["老王的 Codex"] } }));
    assert.match(said, /微信还没商户号/);

    assert.match(textOf(await ai.callTool({ name: "check_group", arguments: { group: "支付对接" } })), /微信还没商户号/);
    assert.match(textOf(await ai.callTool({ name: "check_group", arguments: {} })), /支付对接/);
    assert.match(textOf(await ai.callTool({ name: "list_contacts", arguments: {} })), /支付对接/);
    assert.match(textOf(await ai.callTool({ name: "set_group_quota", arguments: { group: "支付对接", per_day: 50, agent: "我的 Codex" } })), /每天最多被叫醒 50 次/);
    // 加一份 from the dialog on 老方's computer: today's total is the 每天次数 and what was added.
    const pay = (await fangMac.client.groups()).find((x) => x.name === "支付对接")!;
    await fangMac.client.addGroupExtra(pay.id, fangMac.agent("codex"));
    assert.match(textOf(await ai.callTool({ name: "check_group", arguments: { group: "支付对接" } })), /我的 Codex 今天被叫醒 0\/100 次（主人今天多加了 50 次）/);
    assert.match(textOf(await ai.callTool({ name: "set_group_quota", arguments: { group: "支付对接", per_day: 50, agent: "我的 Codex" } })), /每天最多被叫醒 50 次，今天用了 0 次，主人今天另加了 50 次。/);
    assert.match(textOf(await ai.callTool({ name: "stop_group", arguments: { group: "支付对接" } })), /已叫停/);
    assert.match(textOf(await ai.callTool({ name: "stop_group", arguments: { group: "支付对接", resume: true } })), /接着聊/);
  } finally {
    sidecar.stop();
    stayOn();
    await cloud.close();
  }
});

test("an AI opens a group with files, as on the web; @所有人 alone opens nothing", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
  const dir = mkdtempSync(join(tmpdir(), "achat-group-file-"));
  const path = join(dir, "发版清单.txt");
  writeFileSync(path, "1. 支付宝回调\n");
  try {
    const ai = await mcp(fangMac.client, fangMac.agent("claude"));
    const made = textOf(await ai.callTool({ name: "create_group", arguments: { name: "发版计划", members: ["我的 Codex"], message: "@所有人 看看清单", files: [path] } }));
    assert.match(made, /已建群「发版计划」/);
    const g = (await fangMac.client.groups()).find((x) => x.name === "发版计划")!;
    const opener = (await fangMac.client.group(g.id)).messages[0];
    assert.deepEqual([opener.body, opener.files.map((f) => f.name)], ["@所有人 看看清单", ["发版清单.txt"]]);

    const missing = await ai.callTool({ name: "create_group", arguments: { name: "找不到", members: ["我的 Codex"], files: ["/没有/这个.txt"] } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /找不到文件：\/没有\/这个\.txt/);
    assert.ok(!(await fangMac.client.groups()).some((x) => x.name === "找不到"), "nothing is made");

    await ai.callTool({ name: "create_group", arguments: { name: "只有点名", members: ["我的 Codex"], message: "@所有人" } });
    const bare = (await fangMac.client.groups()).find((x) => x.name === "只有点名")!;
    assert.equal((await fangMac.client.group(bare.id)).openerSeq, null);
  } finally {
    await cloud.close();
  }
});

test("an AI that is not in the group is told to pull itself in with invite_to_group, and can", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
  const wangId = (await wang.call("GET", "/api/me")).account.id;
  try {
    // Only 老方's Codex is in the group; his Claude is not.
    await fangMac.client.createGroup({ from: fangMac.agent("codex"), name: "只有 Codex", members: [{ account: wangId }] });
    const ai = await mcp(fangMac.client, fangMac.agent("claude"));
    const refused = await ai.callTool({ name: "send_group_message", arguments: { group: "只有 Codex", message: "我来了" } });
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused), "你不在「只有 Codex」里，先用 invite_to_group 把自己拉进来（members 填「我的 Claude」）");
    const pulled = await ai.callTool({ name: "invite_to_group", arguments: { group: "只有 Codex", members: ["我的 Claude"] } });
    assert.notEqual(pulled.isError, true);
    assert.match(textOf(await ai.callTool({ name: "send_group_message", arguments: { group: "只有 Codex", message: "我来了" } })), /已发到群「只有 Codex」/);
  } finally {
    await cloud.close();
  }
});

test("a reply that comes later in a group is brought up in the session that spoke there, until it reads the group", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
  const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
  const claude = fangMac.agent("claude");
  const wangCodex = wangLaptop.agent("codex");
  const wangId = (await wang.call("GET", "/api/me")).account.id;
  const g = await fangMac.client.createGroup({ from: claude, name: "支付对接", members: [{ account: wangId }] });
  const invited = (await wang.call("GET", "/api/groups")).find((x: any) => x.id === g.id);
  await wang.call("POST", `/api/groups/${g.id}/invites/${invited.myInvite.id}/accept`, { agents: [wangCodex] });
  let sidecar: Sidecar | null = null;
  try {
    const ai = await mcp(fangMac.client, claude);
    const quiet = textOf(await ai.callTool({ name: "send_group_message", arguments: { group: "支付对接", message: "我先看看" } }));
    assert.equal(quiet, `已发到群「支付对接」（${g.id}），没有叫醒谁，不用等回复。后面有人回你，主人下次跟你说话时会提醒你。`);

    // 老王's computer is off: the tool comes back at once, and his Codex answers once it is on.
    const asked = textOf(await ai.callTool({ name: "send_group_message", arguments: { group: "支付对接", message: "@老王的 Codex 微信呢", mentions: ["老王的 Codex"] } }));
    assert.match(asked, /老王的 Codex 不在线/);
    sidecar = new Sidecar({
      client: wangLaptop.client,
      agents: [],
      runners: { [wangCodex]: new ScriptedRunner(["微信还没商户号"]) },
      notify: () => {},
      webUrl: cloud.url,
      log: () => {},
    });
    sidecar.start();
    await until(async () => (await fangMac.client.group(g.id)).messages.some((m) => m.sender === wangCodex));

    const dir = mkdtempSync(join(tmpdir(), "achat-transcript-"));
    const spoke = join(dir, "spoke.jsonl");
    const other = join(dir, "other.jsonl");
    writeFileSync(spoke, JSON.stringify({ content: asked }) + "\n");
    writeFileSync(other, JSON.stringify({ content: "别的事" }) + "\n");
    const reminder = await userPromptHook(fangMac.client, claude, { transcriptPath: spoke });
    assert.equal(
      JSON.parse(reminder ?? "{}").hookSpecificOutput?.additionalContext,
      `Achat：群「支付对接」（${g.id}）里有人回了你发的消息。先用 achat 的 check_group（group: ${g.id}）看，再接着回答主人。`,
    );
    assert.equal(await userPromptHook(fangMac.client, claude, { transcriptPath: other }), null, "not in a session that never spoke there");
    assert.equal(await userPromptHook(fangMac.client, fangMac.agent("codex"), { transcriptPath: spoke }), null, "nor for another AI");

    // Saying more there does not show it what came back: the tool says so, and it is still brought up.
    const more = textOf(await ai.callTool({ name: "send_group_message", arguments: { group: "支付对接", message: "我再想想" } }));
    assert.ok(more.endsWith(`\n你之前在这个群里说的话也有人回了，用 check_group（group: ${g.id}）看。`), more);
    assert.notEqual(await userPromptHook(fangMac.client, claude, { transcriptPath: spoke }), null, "still brought up");

    assert.match(textOf(await ai.callTool({ name: "check_group", arguments: { group: "支付对接" } })), /微信还没商户号/);
    assert.equal(await userPromptHook(fangMac.client, claude, { transcriptPath: spoke }), null, "once read, no more reminders");

    // A day's more counts in what check_group says it may use today.
    await fangMac.client.addGroupExtra(g.id, claude);
    assert.match(textOf(await ai.callTool({ name: "check_group", arguments: { group: "支付对接" } })), /我的 Claude 今天被叫醒 0\/60 次/);
  } finally {
    sidecar?.stop();
    await cloud.close();
  }
});

test("a send_group_message given up while it waits does not count the answers it got as seen", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude"]);
  const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
  const claude = fangMac.agent("claude");
  const wangCodex = wangLaptop.agent("codex");
  const wangId = (await wang.call("GET", "/api/me")).account.id;
  const g = await fangMac.client.createGroup({ from: claude, name: "支付对接", members: [{ account: wangId }] });
  const invited = (await wang.call("GET", "/api/groups")).find((x: any) => x.id === g.id);
  await wang.call("POST", `/api/groups/${g.id}/invites/${invited.myInvite.id}/accept`, { agents: [wangCodex] });
  const sidecar = new Sidecar({
    client: wangLaptop.client,
    agents: [],
    runners: { [wangCodex]: new ScriptedRunner(["微信还没商户号"]) },
    notify: () => {},
    webUrl: cloud.url,
    log: () => {},
  });
  sidecar.start();
  try {
    await until(async () => (await fangMac.client.group(g.id)).members.find((m) => m.agent === wangCodex)?.online);
    const ai = await mcp(fangMac.client, claude);
    const marked: number[] = [];
    const markGroupSeen = fangMac.client.markGroupSeen.bind(fangMac.client);
    fangMac.client.markGroupSeen = async (id, agent, seq) => {
      marked.push(seq);
      return markGroupSeen(id, agent, seq);
    };
    // The answer comes, and the call is given up before the tool hands it back.
    const giveUp = new AbortController();
    let waited = false;
    fangMac.client.waitGroup = async (id, _timeoutMs, signal) => {
      const answered = await until(async () => {
        const d = await fangMac.client.group(id);
        return d.messages.some((m) => m.sender === wangCodex) && d;
      });
      giveUp.abort();
      await until(async () => signal?.aborted);
      waited = true;
      return answered;
    };
    const asking = ai.callTool({ name: "send_group_message", arguments: { group: "支付对接", message: "@老王的 Codex 微信呢", mentions: ["老王的 Codex"] } }, undefined, { signal: giveUp.signal });
    await assert.rejects(asking);
    await until(async () => waited);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(marked, []);
    assert.deepEqual((await fangMac.client.unseenGroups(claude)).map((u) => u.id), [g.id], "brought up when its person next talks to it");
  } finally {
    sidecar.stop();
    await cloud.close();
  }
});

test("an AI asking another person's AI to 动手 hears that it waits for that person, then that it is under way; the result goes back with reply_to, not waiting", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude"]);
  const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
  const claude = fangMac.agent("claude");
  const wangCodex = wangLaptop.agent("codex");
  const fangId = (await fang.call("GET", "/api/me")).account.id;
  // 老方's computer is on: its Claude judges 动手, and he says yes in the dialog.
  const opener = new FakeOpener();
  const answers: ((a: Answer) => void)[] = [];
  const sidecar = new Sidecar({
    client: fangMac.client,
    agents: [],
    runners: { [claude]: new JudgingRunner([], ["do", "do"]) },
    doers: { [claude]: opener },
    tasks: new TaskBook(mkdtempSync(join(tmpdir(), "achat-tasks-"))),
    ask: () => {
      let resolve!: (a: Answer) => void;
      const answer = new Promise<Answer>((r) => (resolve = r));
      answers.push(resolve);
      return { answer, close: () => resolve("later") };
    },
    notify: () => {},
    webUrl: cloud.url,
    log: () => {},
  });
  sidecar.start();
  try {
    const g = await wangLaptop.client.createGroup({ from: wangCodex, name: "网关", members: [{ account: fangId }] });
    const invite = (await fang.call("GET", "/api/groups")).find((s: any) => s.id === g.id).myInvite;
    await fang.call("POST", `/api/groups/${g.id}/invites/${invite.id}/accept`, { agents: [claude] });
    await until(async () => (await wang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === claude)?.online);

    const asker = await mcp(wangLaptop.client, wangCodex);
    const waiting = textOf(await asker.callTool({ name: "send_group_message", arguments: { group: "网关", message: "@老方的 Claude 请你在网关加验签", mentions: ["老方的 Claude"] } }));
    // 老方's yes, named from 老王's side: not 老王, whom "主人" would mean to his Codex.
    assert.match(waiting, /老方的 Claude 等老方同意动手/);
    assert.match(waiting, /动手的结果会发回群里并 @ 你/);

    answers[0]("approve");
    await until(async () => opener.starts.length === 1);
    const seq = (await wangLaptop.client.group(g.id)).messages.find((m) => m.body === "@老方的 Claude 请你在网关加验签")!.seq;
    const doer = await mcp(fangMac.client, claude);
    const sent = textOf(await doer.callTool({ name: "send_group_message", arguments: { group: g.id, message: "@老王的 Codex 加好了", mentions: ["老王的 Codex"], reply_to: seq, wait: false } }));
    assert.match(sent, /已发到群「网关」.*不等回复/);
    const after = await wangLaptop.client.group(g.id);
    assert.equal(after.messages.find((m) => m.seq === seq)!.receipts[0].state, "replied");
    assert.deepEqual([after.messages.at(-1)!.body, after.messages.at(-1)!.replyTo], ["@老王的 Codex 加好了", seq]);

    const underWay = textOf(await asker.callTool({ name: "send_group_message", arguments: { group: "网关", message: "@老方的 Claude 再加一行日志", mentions: ["老方的 Claude"] } }));
    assert.match(underWay, /老方的 Claude 正在动手，做完会发回群里/);
  } finally {
    sidecar.stop();
    await cloud.close();
  }
});

test("waiting on its own person, the AI asking hears its other AI waits for 你的主人", async () => {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude"]);
  const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex", "claude"]);
  const fangClaude = fangMac.agent("claude");
  const [wangCodex, wangClaude] = [wangLaptop.agent("codex"), wangLaptop.agent("claude")];
  const wangId = (await wang.call("GET", "/api/me")).account.id;
  // 老王's Claude can 动手; 老王 leaves its dialogs on screen.
  const sidecar = new Sidecar({
    client: wangLaptop.client,
    agents: [],
    runners: { [wangClaude]: new JudgingRunner([], ["do", "do"]) },
    doers: { [wangClaude]: new FakeOpener() },
    tasks: new TaskBook(mkdtempSync(join(tmpdir(), "achat-tasks-"))),
    ask: () => ({ answer: new Promise<Answer>(() => {}), close: () => {} }),
    notify: () => {},
    webUrl: cloud.url,
    log: () => {},
  });
  sidecar.start();
  try {
    const g = await fangMac.client.createGroup({ from: fangClaude, name: "自家", members: [{ account: wangId }] });
    const invite = (await wang.call("GET", "/api/groups")).find((s: any) => s.id === g.id).myInvite;
    await wang.call("POST", `/api/groups/${g.id}/invites/${invite.id}/accept`, { agents: [wangCodex, wangClaude] });
    await until(async () => (await fang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === wangClaude)?.online);
    // 老王's Codex, answering 老方 in the background, asks his Claude: that waits for 老王.
    const asked = (await fangMac.client.postGroupMessage(g.id, { from: fangClaude, body: "@老王的 Codex 让你的 Claude 动手", mentions: [wangCodex] })).messages.at(-1)!;
    const echoed = (await wangLaptop.client.postGroupMessage(g.id, { from: wangCodex, body: "@老王的 Claude 请你动手", mentions: [wangClaude], replyTo: asked.seq, epoch: 0, sessionId: "s1" })).messages.at(-1)!;
    const stateOf = async (seq: number) => (await wangLaptop.client.group(g.id)).messages.find((m) => m.seq === seq)?.receipts.find((r) => r.agent === wangClaude)?.state;
    await until(async () => (await stateOf(echoed.seq)) === "asking");
    // Then from the front: the same asker's request waits with it.
    const asker = await mcp(wangLaptop.client, wangCodex);
    const waiting = textOf(await asker.callTool({ name: "send_group_message", arguments: { group: g.id, message: "@我的 Claude 再动手改一处", mentions: ["我的 Claude"] } }));
    assert.match(waiting, /我的 Claude 等你的主人同意动手/);
  } finally {
    sidecar.stop();
    await cloud.close();
  }
});

// 老王's Codex asks 老方's Claude in 网关 to 动手, and 老方 says yes; 老方
// also has a group of his own, 别的群. `wangOn`: 老王's computer stays on.
async function actingFor(wangOn = false) {
  const { cloud, mailer } = await startTestCloud();
  const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  await befriend(fang, wang, "wang@example.com");
  const fangMac = await addComputer(cloud, fang, "MacBook", ["claude"]);
  const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
  const claude = fangMac.agent("claude");
  const wangCodex = wangLaptop.agent("codex");
  const fangId = (await fang.call("GET", "/api/me")).account.id;
  const wangId = (await wang.call("GET", "/api/me")).account.id;
  const opener = new FakeOpener();
  const answers: ((a: Answer) => void)[] = [];
  const sidecar = new Sidecar({
    client: fangMac.client,
    agents: [],
    runners: { [claude]: new JudgingRunner([], ["do"]) },
    doers: { [claude]: opener },
    tasks: new TaskBook(mkdtempSync(join(tmpdir(), "achat-tasks-"))),
    ask: () => {
      let resolve!: (a: Answer) => void;
      const answer = new Promise<Answer>((r) => (resolve = r));
      answers.push(resolve);
      return { answer, close: () => resolve("later") };
    },
    notify: () => {},
    webUrl: cloud.url,
    log: () => {},
  });
  sidecar.start();
  let heard = false;
  const stayOn = wangOn ? wangLaptop.client.subscribe(undefined, () => {}, () => (heard = true)) : () => {};
  const close = async () => {
    sidecar.stop();
    stayOn();
    await cloud.close();
  };
  try {
    const g = await wangLaptop.client.createGroup({ from: wangCodex, name: "网关", members: [{ account: fangId }] });
    const invite = (await fang.call("GET", "/api/groups")).find((s: any) => s.id === g.id).myInvite;
    await fang.call("POST", `/api/groups/${g.id}/invites/${invite.id}/accept`, { agents: [claude] });
    await fangMac.client.createGroup({ from: claude, name: "别的群", members: [{ account: wangId }] });
    await until(async () => (await wang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === claude)?.online);
    if (wangOn) {
      await until(async () => heard);
      await wangLaptop.client.beat();
    }
    const seq = (await wangLaptop.client.postGroupMessage(g.id, { from: wangCodex, body: "@老方的 Claude 请你在网关加验签", mentions: [claude] })).messages.at(-1)!.seq;
    await until(async () => answers[0]);
    answers[0]("approve");
    await until(async () => opener.starts.length === 1);
    const doer = await mcp(fangMac.client, claude, { key: actKey(g.id, wangCodex, claude), given: seq });
    return { fangMac, wangLaptop, claude, wangCodex, g, seq, doer, close };
  } catch (err) {
    await close();
    throw err;
  }
}

test("a 动手 conversation speaks only in the group it works for, and only to send back a request under way, reply_to filled in for it", async () => {
  const { fangMac, wangLaptop, claude, wangCodex, g, seq, doer, close } = await actingFor();
  try {
    // However much was said since the request it works on.
    for (let i = 1; i <= 201; i++) await wangLaptop.client.postGroupMessage(g.id, { from: wangCodex, body: `闲聊 ${i}` });
    const send = (args: Record<string, unknown>) => doer.callTool({ name: "send_group_message", arguments: { message: "@老王的 Codex 加好了", mentions: ["老王的 Codex"], wait: false, ...args } });
    const elsewhere = await send({ group: "别的群" });
    assert.equal(elsewhere.isError, true);
    assert.equal(textOf(elsewhere), `你在替群「网关」里的老王的 Codex 动手，只能把结果发回这个群（group: ${g.id}）。`);
    const wrong = await send({ group: g.id, reply_to: 1 });
    assert.equal(wrong.isError, true);
    assert.equal(textOf(wrong), `reply_to 要填这次动手正在做的请求：第 ${seq} 条。`);
    assert.equal(textOf(await send({ group: g.id })), `已发到群「网关」（${g.id}），不等回复。`);
    assert.equal((await wangLaptop.client.group(g.id)).messages.at(-1)!.replyTo, seq);
    assert.equal(await fangMac.client.groupWorkFor(g.id, claude, false, seq), null, "answered: nothing waits on it");
    const done = await send({ group: g.id });
    assert.equal(done.isError, true);
    assert.equal(textOf(done), "这次动手没有正在做的请求了，不用再发：对方要改会再 @ 你。");
    // Nor does it speak in a thread: its work goes back to the group.
    const thread = await doer.callTool({ name: "send_message", arguments: { thread_id: "t_1", message: "好了" } });
    assert.equal(thread.isError, true);
    assert.equal(textOf(thread), `你在替群「网关」里的老王的 Codex 动手，结果用 send_group_message（group: ${g.id}）发回群里。`);
  } finally {
    await close();
  }
});

test("a 动手 conversation does not take the front session's news: what it reads there stays unseen, and its person's words to it bring up no group", async () => {
  const { fangMac, wangLaptop, claude, wangCodex, g, seq, doer, close } = await actingFor(true);
  try {
    // 老方's front session asked 老王's Codex something, whose answer it has not read yet.
    const front = await mcp(fangMac.client, claude);
    const asked = textOf(await front.callTool({ name: "send_group_message", arguments: { group: g.id, message: "@老王的 Codex 网关在哪台机器", mentions: ["老王的 Codex"], wait: false } }));
    const askedSeq = (await fangMac.client.group(g.id)).messages.at(-1)!.seq;
    await wangLaptop.client.postGroupMessage(g.id, { from: wangCodex, body: "在 10 号机", replyTo: askedSeq, epoch: 0, sessionId: "s_wang" });
    const unseen = async () => (await fangMac.client.unseenGroups(claude)).map((u) => u.id);
    assert.deepEqual(await unseen(), [g.id]);

    assert.match(textOf(await doer.callTool({ name: "check_group", arguments: { group: g.id } })), /在 10 号机/);
    const sent = textOf(await doer.callTool({ name: "send_group_message", arguments: { group: g.id, message: "@老王的 Codex 加好了", mentions: ["老王的 Codex"], wait: false } }));
    assert.equal(sent, `已发到群「网关」（${g.id}），不等回复。`, "nor is it told of answers to what the front said");
    assert.equal((await wangLaptop.client.group(g.id)).messages.find((m) => m.seq === seq)!.receipts[0].state, "replied");
    assert.deepEqual(await unseen(), [g.id], "still news for the front session");

    // The person typing in the 动手 conversation is not told of the group; in the front session they are.
    const log = join(mkdtempSync(join(tmpdir(), "achat-transcript-")), "doing.jsonl");
    writeFileSync(log, JSON.stringify({ content: `${asked} ${g.id}` }) + "\n");
    assert.equal(await userPromptHook(fangMac.client, claude, { transcriptPath: log, task: actKey(g.id, wangCodex, claude) }), null);
    assert.notEqual(await userPromptHook(fangMac.client, claude, { transcriptPath: log }), null);
  } finally {
    await close();
  }
});
