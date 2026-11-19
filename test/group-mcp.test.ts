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
import { TaskBook, type TaskOpener, type TaskRecord, type TaskStart } from "../src/sidecar/tasks.js";
import { addComputer, type Browser, JudgingRunner, logIn, ScriptedRunner, startTestCloud, until } from "./helpers.js";

async function mcp(client: RelayClient, agentId: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client, agentId, webUrl: "https://achat.test", mode: "cloud" }), waitSeconds: 10 }).connect(serverSide);
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
    assert.match(waiting, /老方的 Claude 等主人同意动手/);
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
