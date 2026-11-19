import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { AgentConfig } from "../src/config.js";
import { GroupService, type Caller, type GroupDirectory } from "../src/relay/groups.js";
import { Store } from "../src/relay/store.js";
import { ALL, RECEIPT_LABELS, type GroupEvent } from "../src/types.js";

// 老方 has Claude and Codex; 老王 has Codex and Claude; 小林 has Claude,
// 豆包 and Codex; 王闯 has Codex. 老方 is friends with 老王 and 小林; 王闯 only with 老王.
const AIS: AgentConfig[] = [
  { id: "fang/claude", name: "老方的 Claude", client: "claude", owner: "fang" },
  { id: "fang/codex", name: "老方的 Codex", client: "codex", owner: "fang" },
  { id: "wang/codex", name: "老王的 Codex", client: "codex", owner: "wang" },
  { id: "wang/claude", name: "老王的 Claude", client: "claude", owner: "wang" },
  { id: "lin/claude", name: "小林的 Claude", client: "claude", owner: "lin" },
  { id: "r_lin", name: "小林的豆包", client: "doubao", owner: "lin", canReceive: false },
  { id: "lin/codex", name: "小林的 Codex", client: "codex", owner: "lin" },
  { id: "chuang/codex", name: "王闯的 Codex", client: "codex", owner: "chuang" },
];
const PEOPLE: Record<string, string> = { fang: "老方", wang: "老王", lin: "小林", chuang: "王闯" };
const FRIENDS = new Set(["fang:wang", "fang:lin", "wang:chuang"]);

function directory(online: Set<string>): GroupDirectory {
  const seat = (account: string): AgentConfig => ({ id: `p_${account}`, name: PEOPLE[account], client: "person", canReceive: false, owner: account });
  const find = (id: string): AgentConfig | undefined => AIS.find((a) => a.id === id) ?? (id.startsWith("p_") && PEOPLE[id.slice(2)] ? seat(id.slice(2)) : undefined);
  // Named from the viewer's side: their own AIs are "我的 ...".
  const named = (a: AgentConfig | undefined, viewer?: string): AgentConfig | undefined =>
    a && viewer && a.client !== "person" && a.owner === viewer ? { ...a, name: a.name.replace(PEOPLE[viewer], "我") } : a;
  return {
    agent: (id, viewer) => named(find(id), viewer),
    name: (id, viewer) => named(find(id), viewer)?.name ?? id,
    friends: (a, b) => a === b || FRIENDS.has(`${a}:${b}`) || FRIENDS.has(`${b}:${a}`),
    online: (id) => online.has(id),
    seat: (account) => `p_${account}`,
    person: (account, viewer) => (account === viewer ? "我" : (PEOPLE[account] ?? "某人")),
  };
}

// A person on the web page, or one of their computers speaking for its AIs.
function web(account: string): Caller {
  return { account, person: `p_${account}`, actsAs: () => false, approves: true };
}
function computer(account: string): Caller {
  return { account, person: null, actsAs: (a) => a.startsWith(`${account}/`), approves: true };
}

describe("groups", () => {
  let now: Date;
  let online: Set<string>;
  let groups: GroupService;

  beforeEach(() => {
    now = new Date("2026-11-18T02:00:00Z");
    online = new Set(AIS.map((a) => a.id));
    groups = new GroupService(new Store(":memory:"), directory(online), () => now);
  });

  // 老方's Claude starts 支付对接: his Codex joins, 老王 and 小林's Claude are invited.
  function start(message?: string) {
    return groups.createGroup(computer("fang"), {
      from: "fang/claude",
      name: "支付对接",
      members: [{ agent: "fang/codex" }, { account: "wang" }, { agent: "lin/claude" }],
      message,
    });
  }

  function inviteTo(g: { invites: { id: string; account: string }[] }, account: string): string {
    return g.invites.find((i) => i.account === account)!.id;
  }

  test("own AIs join at once and friends are invited", () => {
    const g = start();
    assert.deepEqual(g.members.map((m) => m.agent), ["fang/claude", "fang/codex"]);
    assert.deepEqual(g.invites.map((i) => [i.name, i.agent]), [["老王", null], ["小林", "lin/claude"]]);
    assert.equal(g.owner, "fang");
    assert.equal(g.status, "open");
  });

  test("an invite is answered by the person on the web, who picks their AIs; a named AI joins alone; strangers wait for a friend", () => {
    const g = start();
    assert.throws(() => groups.acceptInvite(computer("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] }), /网页上点/);
    assert.throws(() => groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), {}), /选至少一个 AI/);
    assert.equal(groups.detail(web("wang"), g.id).role, "invited");
    const joined = groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex", "wang/claude"], quota: 10 });
    assert.equal(joined.role, "member");
    assert.deepEqual(joined.members.filter((m) => m.owner === "wang").map((m) => [m.agent, m.quota]), [["wang/codex", 10], ["wang/claude", 10]]);
    assert.equal(joined.messages.at(-1)!.body, "老王的 Codex、老王的 Claude 加入了群聊");

    const lin = groups.acceptInvite(web("lin"), g.id, inviteTo(g, "lin"), { agents: ["r_lin"] });
    assert.ok(lin.members.some((m) => m.agent === "lin/claude"));
    assert.ok(!lin.members.some((m) => m.agent === "r_lin"));

    assert.throws(() => groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ account: "chuang" }] }), /王闯还不是你的朋友/);
    assert.equal(groups.invite(computer("wang"), g.id, { from: "wang/codex", members: [{ account: "chuang" }] }).invites.at(-1)!.name, "王闯");
  });

  test("an invite runs out after 7 days", () => {
    const g = start();
    now = new Date(now.getTime() + 7 * 24 * 3600_000 + 1);
    assert.throws(() => groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] }), /过期/);
    assert.deepEqual(groups.list(web("wang"), ["wang/codex", "wang/claude"]), []);
  });

  test("only those @ed are woken; @所有人 wakes every AI but the sender; what cannot be woken says why", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex", "wang/claude"] });
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "r_lin" }] });
    groups.acceptInvite(web("lin"), g.id, inviteTo(g, "lin"), {});

    assert.deepEqual(groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "大家好" }).messages.at(-1)!.receipts, []);
    online.delete("wang/claude");
    const all = groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "说说现状", mentions: [ALL] });
    assert.deepEqual(Object.fromEntries(all.messages.at(-1)!.receipts.map((r) => [r.agent, r.state])), {
      "fang/claude": "reading",
      "fang/codex": "reading",
      "wang/codex": "reading",
      "wang/claude": "offline",
      "lin/claude": "reading",
      r_lin: "cannot",
    });

    assert.throws(() => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "我自己", mentions: ["fang/claude"] }), /不能 @ 自己/);
    assert.throws(() => groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "老王本人呢", mentions: ["p_wang"] }), /只能 @ 群里的 AI/);
    const call = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "这个要 @老方 定", mentions: ["p_fang"] });
    assert.deepEqual(call.messages.at(-1)!.mentions, ["p_fang"]);
    assert.throws(() => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "要老王定", mentions: ["p_wang"] }), /自己的主人/);
  });

  test("a background answer settles what woke it and wakes those it @s; after 叫停 a late answer is refused", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const asked = groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@老王的 Codex 回调好了吗", mentions: ["wang/codex"] });
    const seq = asked.messages.at(-1)!.seq;

    const work = groups.workFor(computer("wang"), g.id, "wang/codex")!;
    assert.equal(work.wake.seq, seq);
    assert.equal(work.session, null);
    assert.deepEqual(work.owner, { seat: "p_wang", name: "老王" });

    const answered = groups.postMessage(computer("wang"), g.id, {
      from: "wang/codex",
      body: "好了。@老方的 Claude 验签放哪？",
      mentions: ["fang/claude"],
      replyTo: seq,
      epoch: asked.epoch,
      sessionId: "s1",
      readTo: seq,
    });
    const [question, reply] = answered.messages.slice(-2);
    assert.deepEqual(question.receipts, [{ agent: "wang/codex", state: "replied", reason: null }]);
    assert.equal(reply.replyTo, seq);
    assert.deepEqual(reply.receipts.map((r) => [r.agent, r.state]), [["fang/claude", "reading"]]);
    assert.equal(groups.workFor(computer("wang"), g.id, "wang/codex"), null);
    assert.throws(() => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "再说一遍", replyTo: seq, epoch: asked.epoch }), /不用回了/);

    const stopped = groups.stop(web("wang"), g.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.messages.at(-1)!.body, "老王叫停了群里沟通");
    assert.deepEqual(stopped.messages.at(-2)!.receipts.map((r) => r.state), ["stopped"]);
    assert.throws(() => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "在网关", replyTo: reply.seq, epoch: answered.epoch }), /叫停/);
    const quiet = groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@老王的 Codex 在吗", mentions: ["wang/codex"] });
    assert.deepEqual(quiet.messages.at(-1)!.receipts.map((r) => r.state), ["stopped"]);

    const resumed = groups.resume(web("fang"), g.id);
    assert.equal(resumed.status, "open");
    assert.equal(resumed.messages.at(-1)!.body, "老方让群里接着聊");
    // What was @ed while 叫停 is not answered later.
    assert.equal(groups.workFor(computer("wang"), g.id, "wang/codex"), null);
  });

  test("无需回复 keeps its reason; past 每天次数 an AI is not woken, and raising it takes up the latest @", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "自己", members: [{ agent: "fang/codex" }] });
    groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 2 });
    const ask = (body: string) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["fang/codex"] }).messages.at(-1)!;
    const first = ask("一");
    groups.pass(computer("fang"), g.id, { agent: "fang/codex", seq: first.seq, epoch: 0, reason: "不归我\n第二行" });
    assert.deepEqual(groups.detail(web("fang"), g.id).messages.find((m) => m.seq === first.seq)!.receipts, [{ agent: "fang/codex", state: "passed", reason: "不归我" }]);
    ask("二");
    const third = ask("三");
    assert.equal(third.receipts[0].state, "quota");
    const codex = groups.detail(web("fang"), g.id).members.find((m) => m.agent === "fang/codex")!;
    assert.deepEqual([codex.quota, codex.usedToday], [2, 2]);
    groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 5 });
    assert.equal(groups.workFor(computer("fang"), g.id, "fang/codex")!.wake.seq, third.seq);
    // A new day in 北京时间 starts the count over.
    now = new Date("2026-11-18T16:00:00Z");
    assert.equal(groups.detail(web("fang"), g.id).members.find((m) => m.agent === "fang/codex")!.usedToday, 0);
  });

  test("an AI whose computer was off answers, once back within a day, the latest @ it missed", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "自己", members: [{ agent: "fang/codex" }] });
    const ask = (body: string) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["fang/codex"] }).messages.at(-1)!;
    online.delete("fang/codex");
    ask("早");
    const late = ask("晚");
    assert.equal(late.receipts[0].state, "offline");
    online.add("fang/codex");
    assert.deepEqual(groups.work(computer("fang"), ["fang/codex"]), [{ groupId: g.id, agent: "fang/codex", seq: late.seq }]);
    groups.pass(computer("fang"), g.id, { agent: "fang/codex", seq: late.seq, epoch: 0, reason: "看过了" });

    online.delete("fang/codex");
    ask("再晚");
    now = new Date(now.getTime() + 25 * 3600_000);
    online.add("fang/codex");
    assert.deepEqual(groups.work(computer("fang"), ["fang/codex"]), []);
  });

  test("a background session reads the 20 before it joined the first time, and only what is new after", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "长群", members: [] });
    for (let i = 1; i <= 30; i++) groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: `第 ${i} 条` });
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "fang/codex" }] });
    const asked = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老方的 Codex 你看呢", mentions: ["fang/codex"] }).messages.at(-1)!;
    const first = groups.workFor(computer("fang"), g.id, "fang/codex")!;
    assert.equal(first.messages.length, 20);
    assert.equal(first.messages.at(-1)!.seq, asked.seq);
    groups.pass(computer("fang"), g.id, { agent: "fang/codex", seq: asked.seq, epoch: 0, reason: "没意见", sessionId: "s1", readTo: asked.seq });

    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "新的一条" });
    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老方的 Codex 这个呢", mentions: ["fang/codex"] });
    const later = groups.workFor(computer("fang"), g.id, "fang/codex")!;
    assert.equal(later.session, "s1");
    assert.deepEqual(later.messages.map((m) => m.body), ["新的一条", "@老方的 Codex 这个呢"]);
    assert.equal(groups.workFor(computer("fang"), g.id, "fang/codex", true)!.session, null);
  });

  test("the opening message wakes AIs as they join within a day", () => {
    const g = start("@所有人 下周接支付宝和微信支付，先说说现状");
    assert.equal(g.openerSeq, 1);
    assert.deepEqual(g.messages[0].receipts.map((r) => [r.agent, r.state]), [["fang/codex", "reading"]]);
    const joined = groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    assert.deepEqual(joined.messages[0].receipts.map((r) => r.agent), ["fang/codex", "wang/codex"]);
    now = new Date(now.getTime() + 25 * 3600_000);
    const late = groups.acceptInvite(web("lin"), g.id, inviteTo(g, "lin"), {});
    assert.ok(!late.messages[0].receipts.some((r) => r.agent === "lin/claude"));
  });

  test("@所有人 with nothing else is no opening message: nothing is said and nobody is woken", () => {
    for (const message of ["@所有人", " @所有人 \n@所有人 "]) {
      const g = groups.createGroup(web("fang"), { from: "p_fang", members: [{ agent: "fang/claude" }, { account: "wang" }], message });
      assert.equal(g.name, "群聊");
      assert.equal(g.openerSeq, null);
      assert.deepEqual(g.messages, []);
      const joined = groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
      assert.deepEqual(joined.messages.flatMap((m) => m.receipts), [], "nobody is woken when they join either");
    }
    // A file is something to discuss: it opens the group, without the bare @所有人.
    const file = { name: "清单.txt", data: Buffer.from("1. 回调").toString("base64") };
    const withFile = groups.createGroup(web("fang"), { from: "p_fang", members: [{ agent: "fang/claude" }], message: "@所有人", files: [file] });
    assert.equal(withFile.openerSeq, 1);
    assert.deepEqual([withFile.messages[0].body, withFile.messages[0].files.map((f) => f.name), withFile.messages[0].mentions], ["", ["清单.txt"], [ALL]]);
    // An AI starting one is the same.
    const byAi = groups.createGroup(computer("fang"), { from: "fang/claude", name: "支付对接", members: [{ agent: "fang/codex" }], message: "@所有人" });
    assert.equal(byAi.openerSeq, null);
    assert.deepEqual(byAi.messages, []);
  });

  test("the list shows groups and invites; unread is someone else's words; 群主 passes on when its AIs leave; a dissolved group is read only", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    assert.deepEqual(groups.list(web("lin"), ["lin/claude", "r_lin"]).map((s) => [s.name, s.role]), [["支付对接", "invited"]]);
    groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "我来了" });
    assert.equal(groups.list(web("fang"), ["fang/claude", "fang/codex"])[0].unread, true);
    groups.markRead(web("fang"), g.id);
    assert.equal(groups.list(web("fang"), ["fang/claude", "fang/codex"])[0].unread, false);

    assert.throws(() => groups.rename(web("wang"), g.id, "改名"), /只有群主/);
    assert.equal(groups.rename(web("fang"), g.id, "支付宝和微信").name, "支付宝和微信");

    groups.leave(web("fang"), g.id, "fang/claude");
    groups.leave(computer("fang"), g.id, "fang/codex");
    assert.equal(groups.detail(web("wang"), g.id).owner, "wang");
    assert.throws(() => groups.detail(web("fang"), g.id), /找不到这个群/);

    groups.dissolve(web("wang"), g.id);
    assert.throws(() => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "还在吗" }), /解散/);
    assert.equal(groups.detail(web("wang"), g.id).status, "dissolved");
  });

  test("a background answer that @s an AI that left meanwhile is still posted, without that @; a person's message keeps the strict check", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const asked = groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@老王的 Codex 回调好了吗", mentions: ["wang/codex"] });
    const seq = asked.messages.at(-1)!.seq;
    groups.leave(web("fang"), g.id, "fang/codex");
    const answered = groups.postMessage(computer("wang"), g.id, {
      from: "wang/codex",
      body: "好了。@老方的 Codex 你看看，@老方的 Claude 也看看",
      mentions: ["fang/codex", "fang/claude"],
      replyTo: seq,
      epoch: asked.epoch,
      sessionId: "s1",
    });
    const reply = answered.messages.at(-1)!;
    assert.deepEqual(reply.mentions, ["fang/claude"]);
    assert.deepEqual(reply.receipts.map((r) => r.agent), ["fang/claude"]);
    assert.throws(() => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "再叫它", mentions: ["fang/codex"] }), /只能 @ 群里的 AI/);
  });

  test("叫停 also stops what waited for a computer or 每天次数; a reconnect takes up only what the computer missed; a day-old @ is too late; leaving and dissolving end what was waiting", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "自己", members: [{ agent: "fang/codex" }] });
    const ask = (body: string) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["fang/codex"] }).messages.at(-1)!;
    const stateOf = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts[0];

    online.delete("fang/codex");
    const missed = ask("电脑关着时问的");
    assert.equal(missed.receipts[0].state, "offline");
    groups.stop(web("fang"), g.id);
    assert.equal(stateOf(missed.seq).state, "stopped");
    groups.resume(web("fang"), g.id);
    online.add("fang/codex");
    assert.deepEqual(groups.work(computer("fang"), ["fang/codex"]), [], "@ed before 叫停, so not taken up");

    groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 1 });
    const used = ask("用掉今天的一次");
    const kept = ask("额度用完了");
    assert.equal(kept.receipts[0].state, "quota");
    assert.deepEqual(groups.work(computer("fang"), ["fang/codex"]), [{ groupId: g.id, agent: "fang/codex", seq: used.seq }], "what 每天次数 kept waits for its person");

    // Woken over a day ago and never answered: 不在线, and not taken up either.
    now = new Date(now.getTime() + 25 * 3600_000);
    assert.deepEqual(groups.work(computer("fang"), ["fang/codex"]), []);
    assert.equal(stateOf(used.seq).state, "offline");
    assert.equal(stateOf(kept.seq).state, "quota");

    const left = ask("退群前问的");
    assert.equal(left.receipts[0].state, "reading");
    groups.leave(web("fang"), g.id, "fang/codex");
    assert.deepEqual(stateOf(left.seq), { agent: "fang/codex", state: "failed", reason: "不在群里了" });

    groups.dissolve(web("fang"), g.id);
    assert.throws(() => groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 5 }), /解散/);
  });

  test("消息 lists the group with the latest words first, at their time", () => {
    const a = groups.createGroup(computer("fang"), { from: "fang/claude", name: "甲", members: [] });
    now = new Date(now.getTime() + 60_000);
    groups.createGroup(computer("fang"), { from: "fang/claude", name: "乙", members: [] });
    now = new Date(now.getTime() + 60_000);
    groups.postMessage(web("fang"), a.id, { from: "p_fang", body: "甲群有新话" });
    const list = groups.list(web("fang"), ["fang/claude", "fang/codex"]);
    assert.deepEqual(list.map((g) => g.name), ["甲", "乙"]);
    assert.equal(list[0].updatedAt, now.toISOString());
  });

  test("errors name the AI, never its id", () => {
    const g = start();
    assert.throws(
      () => groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "nobody/x" }] }),
      (err: Error) => err.message === "找不到这个 AI，可能对方已经移除了它",
    );
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    groups.leave(web("wang"), g.id, "wang/codex");
    assert.throws(
      () => groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "还在吗", mentions: ["wang/codex"] }),
      (err: Error) => err.message === "老王的 Codex 不在群里，只能 @ 群里的 AI",
    );
    groups.leave(web("fang"), g.id, "fang/codex");
    assert.throws(
      () => groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "还在吗", mentions: ["fang/codex"] }),
      (err: Error) => err.message === "我的 Codex 不在群里，只能 @ 群里的 AI",
    );
    const again = groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ account: "wang" }] });
    assert.throws(
      () => groups.acceptInvite(web("wang"), g.id, inviteTo(again, "wang"), { agents: ["fang/codex"] }),
      (err: Error) => err.message === "只能让自己的 AI 进群",
    );
  });

  test("dissolving ends the invites still open, tells those invited, and adds nothing more to the group", () => {
    const g = start();
    const heard: string[][] = [];
    groups.onEvent((e) => heard.push(e.members));
    groups.dissolve(web("fang"), g.id);
    assert.ok(heard.at(-1)!.includes("p_wang"), "老王's page hears of it");
    assert.deepEqual(groups.list(web("wang"), ["wang/codex", "wang/claude"]), []);
    assert.throws(() => groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] }), /解散/);
    assert.throws(() => groups.remove(web("fang"), g.id, "fang/codex"), /解散/);
    const before = groups.detail(web("fang"), g.id).messages.length;
    groups.leave(web("fang"), g.id, "fang/codex");
    assert.equal(groups.detail(web("fang"), g.id).messages.length, before);
  });

  test("one answer settles every @ the AI had to leave before it, so no old line under them still says 不在线", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "自己", members: [{ agent: "fang/codex" }] });
    const ask = (body: string) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["fang/codex"] }).messages.at(-1)!;
    online.delete("fang/codex");
    const missed = ask("电脑关着时问的");
    online.add("fang/codex");
    const asked = ask("现在问的");
    groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "两条一起答了", replyTo: asked.seq, epoch: 0, sessionId: "s1" });
    const stateOf = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts[0].state;
    assert.deepEqual([stateOf(missed.seq), stateOf(asked.seq)], ["replied", "replied"]);
  });

  test("the last AI leaving dissolves the group and its open invites end with it", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "独行", members: [{ account: "wang" }], message: "开场白" });
    const heard: string[][] = [];
    groups.onEvent((e) => heard.push(e.members));
    const opener = groups.store.message(g.id, g.openerSeq!)!;
    assert.equal(groups.readable("wang", g.id, opener.id), true);
    groups.leave(web("fang"), g.id, "fang/claude");
    assert.equal(groups.store.group(g.id)!.status, "dissolved");
    assert.ok(heard.at(-1)!.includes("p_wang"), "老王's page hears of it");
    assert.deepEqual(groups.list(web("wang"), ["wang/codex", "wang/claude"]), []);
    assert.equal(groups.readable("wang", g.id, opener.id), false);
  });

  test("an answer settles an @ left for 不在线 or 每天次数 only within the day, and a reason stays with the @ it answers", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "自己", members: [{ agent: "fang/codex" }] });
    const ask = (body: string) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["fang/codex"] }).messages.at(-1)!;
    const receipt = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts[0];
    online.delete("fang/codex");
    const old = ask("很久以前问的");
    now = new Date(now.getTime() + 25 * 3600_000);
    const recent = ask("不久前问的");
    online.add("fang/codex");
    const asked = ask("现在问的");
    groups.pass(computer("fang"), g.id, { agent: "fang/codex", seq: asked.seq, epoch: 0, reason: "与我无关\n第二行" });
    assert.equal(receipt(old.seq).state, "offline", "over a day old: still 不在线");
    assert.deepEqual([receipt(recent.seq).state, receipt(recent.seq).reason], ["passed", null]);
    assert.deepEqual([receipt(asked.seq).state, receipt(asked.seq).reason], ["passed", "与我无关"]);
  });

  test("leaving a dissolved group changes neither 群主 nor its time", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "散了", members: [{ agent: "fang/codex" }] });
    groups.dissolve(web("fang"), g.id);
    const before = groups.store.group(g.id)!;
    now = new Date(now.getTime() + 60_000);
    groups.leave(web("fang"), g.id, "fang/claude");
    groups.leave(web("fang"), g.id, "fang/codex");
    const after = groups.store.group(g.id)!;
    assert.deepEqual([after.owner, after.updatedAt], [before.owner, before.updatedAt]);
  });

  test("someone invited keeps the invite's time and place in the list, however much is said where they cannot see", () => {
    const a = groups.createGroup(computer("fang"), { from: "fang/claude", name: "甲", members: [{ account: "wang" }] });
    const invitedAt = now.toISOString();
    now = new Date(now.getTime() + 60_000);
    groups.createGroup(computer("fang"), { from: "fang/claude", name: "乙", members: [{ account: "wang" }] });
    now = new Date(now.getTime() + 60_000);
    groups.postMessage(web("fang"), a.id, { from: "p_fang", body: "甲群有新话" });
    const list = groups.list(web("wang"), ["wang/codex"]);
    assert.deepEqual(list.map((g) => g.name), ["乙", "甲"]);
    assert.equal(list[1].updatedAt, invitedAt);
  });

  test("renaming a group to the name it has changes nothing and says nothing", () => {
    const g = start("开场白");
    const heard: string[] = [];
    groups.onEvent((e) => heard.push(e.type));
    now = new Date(now.getTime() + 60_000);
    const same = groups.rename(web("fang"), g.id, " 支付对接 ");
    assert.deepEqual([same.name, same.messages.length, same.updatedAt], ["支付对接", g.messages.length, g.updatedAt]);
    assert.deepEqual(heard, []);
  });

  test("a person has one invite at a time: not invited as a person once their AI is in, and an invite waiting covers what it asks", () => {
    const g = start();
    const theirs = (account: string) =>
      groups
        .detail(web("fang"), g.id)
        .invites.filter((i) => i.account === account)
        .map((i) => i.agent);
    // 老王's invite lets him pick: his Claude asked for by name is in it already.
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "wang/claude" }, { agent: "r_lin" }] });
    assert.deepEqual(theirs("wang"), [null]);
    // 小林's Claude was asked for by name: the same again is not a second invite; her 豆包 is.
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "lin/claude" }] });
    assert.deepEqual(theirs("lin"), ["lin/claude", "r_lin"]);

    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    assert.throws(
      () => groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "lin/claude" }, { account: "wang" }] }),
      (err: Error & { status?: number }) => err.status === 400 && err.message === "老王已经在群里了，邀请他的 AI 吧",
    );
    assert.deepEqual(theirs("wang"), [], "nothing else of that call was sent");
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "wang/claude" }] });
    assert.deepEqual(theirs("wang"), ["wang/claude"]);

    // A group made with a person and their AI by name invites the person once.
    const made = groups.createGroup(computer("fang"), { from: "fang/claude", name: "两次", members: [{ account: "wang" }, { agent: "wang/codex" }] });
    assert.deepEqual(made.invites.map((i) => [i.account, i.agent]), [["wang", null]]);
  });

  test("someone not yet in answers one card for all their AIs asked for by name; once in, each on its own", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "两个", members: [{ agent: "lin/claude" }, { agent: "r_lin" }] });
    const open = (account: string) => groups.detail(web("fang"), g.id).invites.filter((i) => i.account === account).map((i) => i.agent);
    assert.deepEqual(open("lin"), ["lin/claude", "r_lin"]);
    // 拒绝 on the card declines both: the group does not come back.
    groups.declineInvite(web("lin"), g.id, groups.detail(web("lin"), g.id).myInvite!.id);
    assert.deepEqual(open("lin"), []);
    assert.throws(() => groups.detail(web("lin"), g.id), /找不到这个群/);

    // Asked again: 加入 brings both in, at the 每天次数 picked; what was ticked does not matter.
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "lin/claude" }, { agent: "r_lin" }] });
    const joined = groups.acceptInvite(web("lin"), g.id, groups.detail(web("lin"), g.id).myInvite!.id, { agents: ["lin/codex"], quota: 8 });
    assert.deepEqual(joined.members.filter((m) => m.owner === "lin").map((m) => [m.agent, m.quota]), [["lin/claude", 8], ["r_lin", 8]]);
    assert.deepEqual(open("lin"), []);

    // In the group, each AI asked for by name is a tile of its own in 群设置.
    const later = groups.createGroup(computer("fang"), { from: "fang/claude", name: "后来", members: [{ agent: "lin/claude" }] });
    groups.acceptInvite(web("lin"), later.id, inviteTo(later, "lin"), {});
    const tiles = groups.invite(computer("fang"), later.id, { from: "fang/claude", members: [{ agent: "r_lin" }, { agent: "lin/codex" }] });
    groups.acceptInvite(web("lin"), later.id, tiles.invites.find((i) => i.agent === "r_lin")!.id, {});
    const now = groups.detail(web("lin"), later.id);
    assert.deepEqual(now.members.filter((m) => m.owner === "lin").map((m) => m.agent), ["lin/claude", "r_lin"]);
    assert.deepEqual(now.invites.map((i) => i.agent), ["lin/codex"]);
  });

  test("someone invited twice sees the latest inviter on the card, in the list and in the email alike", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "两次", members: [{ agent: "fang/codex" }, { agent: "lin/claude" }] });
    now = new Date(now.getTime() + 60_000);
    groups.invite(computer("fang"), g.id, { from: "fang/codex", members: [{ agent: "r_lin" }] });
    const card = groups.detail(web("lin"), g.id).myInvite!;
    const listed = groups.list(web("lin"), []).find((s) => s.id === g.id)!.myInvite!;
    assert.deepEqual([card.invitedBy, card.invitedByName, listed.invitedByName], ["fang/codex", "老方的 Codex", "老方的 Codex"]);
    assert.equal(groups.inviteNotice("lin", g.id)!.invitedBy, card.invitedBy);
    assert.equal(listed.id, card.id);
    // 加入 on that card answers both.
    groups.acceptInvite(web("lin"), g.id, card.id, {});
    assert.deepEqual(groups.detail(web("lin"), g.id).members.filter((m) => m.owner === "lin").map((m) => m.agent), ["lin/claude", "r_lin"]);
  });

  test("an AI asked for by name that is gone is left out of 加入; with none left, 加入 says so", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "两个", members: [{ agent: "lin/claude" }, { agent: "lin/codex" }] });
    const gone = AIS.findIndex((a) => a.id === "lin/codex");
    const [removed] = AIS.splice(gone, 1);
    try {
      const joined = groups.acceptInvite(web("lin"), g.id, inviteTo(g, "lin"), {});
      assert.deepEqual(joined.members.filter((m) => m.owner === "lin").map((m) => m.agent), ["lin/claude"]);
      const only = groups.createGroup(computer("fang"), { from: "fang/claude", name: "一个", members: [{ agent: "lin/claude" }] });
      const claude = AIS.findIndex((a) => a.id === "lin/claude");
      const [alsoRemoved] = AIS.splice(claude, 1);
      try {
        assert.throws(() => groups.acceptInvite(web("lin"), only.id, inviteTo(only, "lin"), {}), /已经移除/);
      } finally {
        AIS.splice(claude, 0, alsoRemoved);
      }
    } finally {
      AIS.splice(gone, 0, removed);
    }
  });

  test("an @ left behind is not taken up once the AI was woken for a newer one: that answer covers it, so nothing is charged twice", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "自己", members: [{ agent: "fang/codex" }] });
    const ask = (body: string) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["fang/codex"] }).messages.at(-1)!;
    const used = () => groups.detail(web("fang"), g.id).members.find((m) => m.agent === "fang/codex")!.usedToday;

    // Its computer was off for one @ and back for the next: reconnecting, however often, wakes it for neither again.
    online.delete("fang/codex");
    const missed = ask("电脑关着时问的");
    online.add("fang/codex");
    const asked = ask("现在问的");
    for (let i = 0; i < 3; i++) assert.deepEqual(groups.work(computer("fang"), ["fang/codex"]), [{ groupId: g.id, agent: "fang/codex", seq: asked.seq }]);
    assert.equal(used(), 1);
    groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "两条一起答了", replyTo: asked.seq, epoch: 0, sessionId: "s1" });
    const stateOf = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts[0].state;
    assert.deepEqual([stateOf(missed.seq), stateOf(asked.seq)], ["replied", "replied"]);

    // 每天次数 kept one @ late at night in 北京; past midnight a newer one woke it; raising them then wakes nothing more.
    now = new Date("2026-11-18T15:00:00Z");
    groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 2 });
    ask("今天第二次");
    assert.equal(ask("额度用完了").receipts[0].state, "quota");
    now = new Date("2026-11-18T17:00:00Z");
    const fresh = ask("过了零点问的");
    assert.equal(fresh.receipts[0].state, "reading");
    groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 5 });
    assert.equal(used(), 1);
    assert.equal(groups.workFor(computer("fang"), g.id, "fang/codex")!.wake.seq, fresh.seq);
  });

  test("a group refuses the files a conversation refuses, in the same words", () => {
    const g = start();
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `${i}.txt`, data: new Uint8Array([1]) }));
    const refused = (err: Error & { status?: number }) => err.status === 400 && err.message === "一次最多 9 个文件";
    assert.throws(() => groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "看看", files: ten }), refused);
    assert.throws(() => groups.createGroup(web("fang"), { from: "p_fang", members: [{ agent: "fang/claude" }], message: "看看", files: ten }), refused);
  });

  test("an AI near its 每天次数 is told of once a 北京 day: at 5 left, or at 1 left when it is under 10 a day", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "自己", members: [{ agent: "fang/codex" }] });
    const low: GroupEvent[] = [];
    groups.onEvent((e) => e.type === "group.quotaLow" && low.push(e));
    const ask = (times: number) => {
      for (let i = 0; i < times; i++) groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老方的 Codex 看看", mentions: ["fang/codex"] });
    };
    ask(24);
    assert.deepEqual(low, []);
    ask(1);
    assert.deepEqual(low, [{ type: "group.quotaLow", groupId: g.id, members: ["fang/codex"] }], "25 of 30: 5 left; the event tells that AI alone");
    ask(10);
    assert.equal(low.length, 1, "not again that day, used up or not");
    now = new Date("2026-11-18T16:00:00Z");
    ask(25);
    assert.equal(low.length, 2, "again the next day");

    const small = groups.createGroup(computer("fang"), { from: "fang/claude", name: "少", members: [{ agent: "fang/codex" }] });
    groups.setQuota(web("fang"), small.id, { agent: "fang/codex", perDay: 5 });
    const askSmall = () => groups.postMessage(computer("fang"), small.id, { from: "fang/claude", body: "@老方的 Codex 看看", mentions: ["fang/codex"] });
    for (let i = 0; i < 3; i++) askSmall();
    assert.equal(low.length, 2);
    askSmall();
    assert.deepEqual(low.at(-1), { type: "group.quotaLow", groupId: small.id, members: ["fang/codex"] }, "4 of 5: 1 left");
    askSmall();
    assert.equal(low.length, 3, "used up is not told again");
  });

  test("an AI brought near its 每天次数 by a change that was undone is told of neither then nor by a later event", (t) => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 2 });
    const low: GroupEvent[] = [];
    groups.onEvent((e) => e.type === "group.quotaLow" && low.push(e));
    // Writing what became of 老王's Codex fails, after 老方's Codex was woken down to 1 left.
    const setReceipt = groups.store.setReceipt.bind(groups.store);
    const failing = t.mock.method(groups.store, "setReceipt", (...args: Parameters<typeof setReceipt>) => {
      if (args[2] === "wang/codex") throw new Error("磁盘满了");
      setReceipt(...args);
    });
    assert.throws(() => groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@所有人 看看", mentions: [ALL] }), /磁盘满了/);
    failing.mock.restore();
    groups.rename(web("fang"), g.id, "支付");
    assert.deepEqual(low, [], "nothing of what was undone");
    // Undone with it, being told is still to come.
    groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@老方的 Codex 看看", mentions: ["fang/codex"] });
    assert.deepEqual(low, [{ type: "group.quotaLow", groupId: g.id, members: ["fang/codex"] }]);
  });

  test("加一份 lets an AI be woken another day's 每天次数 today only, and takes up the latest @ kept for it; only its person adds it", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    groups.setQuota(web("fang"), g.id, { agent: "fang/codex", perDay: 2 });
    const ask = (body: string) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["fang/codex"] }).messages.at(-1)!;
    ask("一");
    ask("二");
    const kept = ask("三");
    assert.equal(kept.receipts[0].state, "quota");
    assert.throws(() => groups.addToday(web("wang"), g.id, { agent: "fang/codex" }), /只能改自己的 AI/);

    const heard: GroupEvent[] = [];
    groups.onEvent((e) => heard.push(e));
    const before = groups.detail(web("fang"), g.id).messages.length;
    const added = groups.addToday(web("fang"), g.id, { agent: "fang/codex" });
    const codex = () => groups.detail(web("fang"), g.id).members.find((m) => m.agent === "fang/codex")!;
    assert.deepEqual([codex().quota, codex().extraToday, codex().usedToday], [2, 2, 3]);
    assert.equal(added.messages.find((m) => m.seq === kept.seq)!.receipts[0].state, "reading");
    assert.equal(added.messages.length, before, "nothing is written in the group");
    assert.deepEqual(heard.map((e) => [e.type, e.wake]), [["group.updated", ["fang/codex"]]]);
    assert.equal(groups.detail(web("wang"), g.id).members.find((m) => m.agent === "fang/codex")!.extraToday, undefined, "only its person sees it");
    // A day's more at most: asked again, or a request tried again, adds nothing.
    groups.addToday(web("fang"), g.id, { agent: "fang/codex" });
    assert.deepEqual([codex().extraToday, codex().usedToday], [2, 3]);

    // Today it may be woken quota + what was added.
    assert.equal(ask("四").receipts[0].state, "reading");
    assert.equal(ask("五").receipts[0].state, "quota");
    // The next day in 北京 it is its 每天次数 again, and a day's more can be added again.
    now = new Date("2026-11-18T16:00:00Z");
    assert.deepEqual([codex().extraToday, codex().usedToday], [0, 0]);
    groups.addToday(web("fang"), g.id, { agent: "fang/codex" });
    assert.equal(codex().extraToday, 2);
    groups.dissolve(web("fang"), g.id);
    assert.throws(() => groups.addToday(web("fang"), g.id, { agent: "fang/codex" }), /解散/);
  });

  test("someone newly invited is told alone, once however many of their AIs are asked for; an AI calling its person tells them alone", () => {
    const heard: GroupEvent[] = [];
    groups.onEvent((e) => heard.push(e));
    const told = (type: GroupEvent["type"]) => heard.filter((e) => e.type === type);
    const g = groups.createGroup(computer("fang"), {
      from: "fang/claude",
      name: "支付对接",
      members: [{ agent: "fang/codex" }, { account: "wang" }, { agent: "lin/claude" }, { agent: "r_lin" }],
    });
    assert.deepEqual(told("group.invited"), [
      { type: "group.invited", groupId: g.id, members: ["p_wang"] },
      { type: "group.invited", groupId: g.id, members: ["p_lin"] },
    ]);
    heard.length = 0;
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ account: "wang" }, { agent: "lin/claude" }] });
    assert.deepEqual(told("group.invited"), [], "the same invites, made new again, tell nobody");
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    groups.invite(computer("fang"), g.id, { from: "fang/claude", members: [{ agent: "wang/claude" }] });
    assert.deepEqual(told("group.invited"), [], "老王 is in already: his Claude waits on its tile in 群设置");

    const said = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老方 商户号用哪家公司的执照，你来定", mentions: ["p_fang"] }).messages.at(-1)!;
    assert.deepEqual(told("group.mention"), [{ type: "group.mention", groupId: g.id, members: ["p_fang"], seq: said.seq }]);
    groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@老王的 Codex 你看", mentions: ["wang/codex"] });
    assert.equal(told("group.mention").length, 1, "an @ of an AI wakes it; no person is told");
  });

  test("an AI's front session hears of the groups where someone answered what it said, until it looks again", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "前台", members: [{ agent: "fang/codex" }, { account: "wang" }] });
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const unseen = (agent: string) => groups.unseen(computer("fang"), agent);

    // Someone else's @所有人 answers nothing it said.
    groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "@所有人 大家好", mentions: [ALL] });
    const asked = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老王的 Codex 回调好了吗", mentions: ["wang/codex"] }).messages.at(-1)!;
    assert.deepEqual(unseen("fang/claude"), []);
    const answer = groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "好了", replyTo: asked.seq, epoch: 0, sessionId: "s1" }).messages.at(-1)!;
    assert.deepEqual(unseen("fang/claude"), [{ id: g.id, name: "前台", seq: answer.seq }]);
    assert.deepEqual(unseen("fang/codex"), [], "only answers to what it said itself");

    // Only the AI's own computer asks, or says how far it looked.
    assert.throws(() => groups.unseen(computer("wang"), "fang/claude"), /只能/);
    assert.throws(() => groups.markSeen(web("fang"), g.id, { agent: "fang/claude", seq: answer.seq }), /只能/);
    assert.deepEqual(groups.markSeen(computer("fang"), g.id, { agent: "fang/claude", seq: answer.seq }), { ok: true });
    assert.deepEqual(unseen("fang/claude"), []);
    // How far it looked only goes forward.
    groups.markSeen(computer("fang"), g.id, { agent: "fang/claude", seq: 1 });
    assert.deepEqual(unseen("fang/claude"), []);
    // Gone from the group: nothing more of it.
    const again = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老王的 Codex 还有呢", mentions: ["wang/codex"] }).messages.at(-1)!;
    groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "没了", replyTo: again.seq, epoch: 0, sessionId: "s1" });
    groups.leave(computer("fang"), g.id, "fang/claude");
    assert.deepEqual(unseen("fang/claude"), []);
  });

  test("only answers to what the AI said in front are news for its front session, not those to what it answered in the background", () => {
    const g = groups.createGroup(computer("fang"), { from: "fang/claude", name: "前台", members: [{ account: "wang" }] });
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const unseen = () => groups.unseen(computer("fang"), "fang/claude");
    // 老王's Codex @s 老方's Claude, which answers in the background and is answered back.
    const asked = groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "@老方的 Claude 回调地址是什么", mentions: ["fang/claude"] }).messages.at(-1)!;
    const answer = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老王的 Codex /pay/notify", mentions: ["wang/codex"], replyTo: asked.seq, epoch: 0, sessionId: "s1" }).messages.at(-1)!;
    groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "收到", replyTo: answer.seq, epoch: 0, sessionId: "s1" });
    assert.deepEqual(unseen(), [], "a round between the AIs in the background");
    // What it said in front, answered.
    const said = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老王的 Codex 上线了吗", mentions: ["wang/codex"] }).messages.at(-1)!;
    const reply = groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "上线了", replyTo: said.seq, epoch: 0, sessionId: "s1" }).messages.at(-1)!;
    assert.deepEqual(unseen(), [{ id: g.id, name: "前台", seq: reply.seq }]);
  });

  test("动手: another person's AI asks, its person approves on the computer, and the same asker's next 9 go on without asking", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (body: string) => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body, mentions: ["fang/claude"] }).messages.at(-1)!;
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const receipt = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === "fang/claude")!;
    const lastNote = () => groups.detail(web("fang"), g.id).messages.filter((m) => m.kind === "system").at(-1)!.body;
    const result = (body: string, replyTo: number) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body, mentions: ["wang/codex"], replyTo, epoch: 0 });

    const first = ask("@老方的 Claude 把验签挪到网关");
    assert.throws(() => groups.requestAct(computer("wang"), g.id, { doer: "fang/claude", seq: first.seq }), /只有被请动手的 AI 的电脑/);
    const asked = request(first.seq);
    assert.equal(asked.run, false);
    assert.deepEqual(
      [asked.act.status, asked.act.asker, asked.act.doer, asked.act.askSeq, asked.act.roundsUsed, asked.act.maxRounds],
      ["asking", "wang/codex", "fang/claude", first.seq, 0, 10],
    );
    assert.deepEqual([receipt(first.seq).state, RECEIPT_LABELS.asking], ["asking", "等主人同意"]);
    // Waiting on its person, it is what its computer picks up again when it starts.
    assert.deepEqual(groups.work(computer("fang"), ["fang/claude"]), [{ groupId: g.id, agent: "fang/claude", seq: first.seq }]);
    assert.equal(groups.workFor(computer("fang"), g.id, "fang/claude")!.act!.id, asked.act.id);

    assert.throws(() => groups.approveAct(web("fang"), g.id, asked.act.id), /只有被请动手的 AI 的电脑/);
    assert.throws(() => groups.approveAct({ ...computer("fang"), approves: false }, g.id, asked.act.id), /主人在电脑的弹框里同意/);
    const approved = groups.approveAct(computer("fang"), g.id, asked.act.id);
    assert.deepEqual([approved.status, approved.roundsUsed], ["active", 1]);
    assert.deepEqual([receipt(first.seq).state, RECEIPT_LABELS.acting], ["acting", "正在动手"]);
    assert.equal(lastNote(), "老方的 Claude 开始动手 · 10 轮");
    // Under way, it is what its computer goes on with, one round at a time, also after it starts again; never answered in the background.
    assert.deepEqual(groups.work(computer("fang"), ["fang/claude"]), [{ groupId: g.id, agent: "fang/claude", seq: first.seq }]);
    assert.equal(groups.workFor(computer("fang"), g.id, "fang/claude")!.act!.status, "active");
    assert.throws(() => groups.approveAct(computer("fang"), g.id, asked.act.id), /已经处理过了/);

    // The result goes back to the group as a message @ing whoever asked; it answers the request.
    result("@老王的 Codex 改好了", first.seq);
    assert.equal(receipt(first.seq).state, "replied");

    const second = ask("@老方的 Claude 再加个测试");
    const more = request(second.seq);
    assert.deepEqual([more.run, more.act.id, more.act.roundsUsed, more.act.askSeq], [true, asked.act.id, 2, second.seq]);
    assert.equal(receipt(second.seq).state, "acting");
    assert.equal(request(second.seq).act.roundsUsed, 2, "the same request again is not another round");

    // Two that came together may be judged newest first: each is a round, the act answers the newest, and a retry counts nothing.
    const [third, fourth] = [ask("@老方的 Claude 第 3 轮"), ask("@老方的 Claude 第 4 轮")];
    assert.deepEqual([request(fourth.seq).act.roundsUsed, request(third.seq).act.askSeq, request(third.seq).act.roundsUsed], [3, fourth.seq, 4]);

    let latest = fourth;
    for (let round = 5; round <= 10; round++) {
      latest = ask(`@老方的 Claude 第 ${round} 轮`);
      assert.equal(request(latest.seq).run, true);
    }
    result("@老王的 Codex 都做好了", latest.seq);
    assert.equal(receipt(second.seq).state, "replied", "one result answers every round of the act it read");
    assert.equal(lastNote(), "老方的 Claude 动手 10 轮用完了");
    assert.equal(groups.store.act(asked.act.id)!.status, "done");

    const again = request(ask("@老方的 Claude 再改一处").seq);
    assert.equal(again.run, false);
    assert.notEqual(again.act.id, asked.act.id);
  });

  test("动手: each asker is approved on its own; 拒绝 says why; one's own AIs and person need none; leaving, 叫停 and 解散 end it", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (caller: Caller, from: string, doer = "fang/claude") => groups.postMessage(caller, g.id, { from, body: "动手改一下", mentions: [doer] }).messages.at(-1)!.seq;
    const request = (seq: number, doer = "fang/claude") => groups.requestAct(computer("fang"), g.id, { doer, seq });
    const receipt = (seq: number, doer = "fang/claude") => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === doer)!;
    const lastNote = () => groups.detail(web("fang"), g.id).messages.filter((m) => m.kind === "system").at(-1)!.body;

    const byCodex = ask(computer("wang"), "wang/codex");
    const a = request(byCodex);
    const byPerson = ask(web("wang"), "p_wang");
    const b = request(byPerson);
    assert.notEqual(b.act.id, a.act.id, "老王本人 and his Codex are asked for apart");
    assert.deepEqual([b.run, b.act.asker], [false, "p_wang"]);
    assert.equal(groups.declineAct(computer("fang"), g.id, b.act.id).status, "declined");
    assert.deepEqual(receipt(byPerson), { agent: "fang/claude", state: "passed", reason: "主人没同意动手" });

    // Between one person's own: at once.
    const byOwnAi = ask(computer("fang"), "fang/codex");
    const own = request(byOwnAi);
    assert.deepEqual([own.run, own.act.status, own.act.roundsUsed], [true, "active", 1]);
    assert.equal(receipt(byOwnAi).state, "acting");
    assert.equal(lastNote(), "老方的 Claude 开始动手 · 10 轮");
    assert.equal(request(ask(web("fang"), "p_fang")).run, true, "nor when 老方 himself asks");
    // A conversation that cannot open says so under what asked for it.
    groups.fail(computer("fang"), g.id, { agent: "fang/claude", seq: byOwnAi, reason: "打不开动手的对话：claude 没有登录" });
    assert.deepEqual(receipt(byOwnAi), { agent: "fang/claude", state: "failed", reason: "打不开动手的对话：claude 没有登录" });

    // An AI that leaves ends what was asked of it.
    const ofCodex = ask(computer("wang"), "wang/codex", "fang/codex");
    const c = request(ofCodex, "fang/codex");
    groups.leave(web("fang"), g.id, "fang/codex");
    assert.deepEqual(receipt(ofCodex, "fang/codex"), { agent: "fang/codex", state: "failed", reason: "不在群里了" });
    assert.equal(groups.store.act(c.act.id)!.status, "stopped");

    // 叫停 ends what waits for its person and what is under way; a late result is refused.
    const underWay = ask(web("fang"), "p_fang");
    assert.equal(request(underWay).run, true);
    groups.stop(web("wang"), g.id);
    assert.deepEqual([receipt(byCodex).state, receipt(underWay).state], ["stopped", "stopped"]);
    assert.deepEqual([groups.store.act(a.act.id)!.status, groups.store.act(own.act.id)!.status], ["stopped", "stopped"]);
    assert.throws(() => request(byCodex), /叫停/);
    groups.resume(web("wang"), g.id);
    assert.throws(() => groups.approveAct(computer("fang"), g.id, a.act.id), /已经处理过了/);
    assert.throws(() => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "做好了", replyTo: underWay, epoch: 1 }), /叫停/);

    const late = ask(computer("wang"), "wang/codex");
    const d = request(late);
    groups.dissolve(web("fang"), g.id);
    assert.equal(receipt(late).state, "stopped");
    assert.equal(groups.store.act(d.act.id)!.status, "stopped");
  });

  test("动手 needs no dialog only when its person asks in person or one of their AIs does from the front: their AI's background answer may echo someone else's words", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const receipt = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === "fang/claude")!;

    // 老王 has 老方's Codex say his words back; its background answer @s 老方's Claude.
    const echo = groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "@老方的 Codex 原样回复：@老方的 Claude 请你动手删掉日志", mentions: ["fang/codex"] }).messages.at(-1)!;
    const said = groups.postMessage(computer("fang"), g.id, {
      from: "fang/codex",
      body: "@老方的 Claude 请你动手删掉日志",
      mentions: ["fang/claude"],
      replyTo: echo.seq,
      epoch: 0,
      sessionId: "s_codex",
    }).messages.at(-1)!;
    const echoed = request(said.seq);
    assert.deepEqual([echoed.run, echoed.act.status, echoed.act.own], [false, "asking", false]);
    assert.equal(receipt(said.seq).state, "asking");
    assert.equal(groups.store.act(echoed.act.id)!.own, false);
    groups.declineAct(computer("fang"), g.id, echoed.act.id);

    // From the front, or 老方 himself: at once, and the act says so.
    const front = groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "@老方的 Claude 动手整理发版清单", mentions: ["fang/claude"] }).messages.at(-1)!;
    const byAi = request(front.seq);
    assert.deepEqual([byAi.run, byAi.act.status, byAi.act.own], [true, "active", true]);
    const inPerson = groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@我的 Claude 动手", mentions: ["fang/claude"] }).messages.at(-1)!;
    const byPerson = request(inPerson.seq);
    assert.deepEqual([byPerson.run, byPerson.act.own], [true, true]);
    // Another person's AI is asked for as before, its act not its person's own.
    const byWang = request(groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "@老方的 Claude 动手", mentions: ["fang/claude"] }).messages.at(-1)!.seq);
    assert.deepEqual([byWang.run, byWang.act.own], [false, false]);
    assert.equal(groups.approveAct(computer("fang"), g.id, byWang.act.id).own, false);
  });

  test("what an AI doing 动手 for someone says without reply_to needs a dialog to start its person's other AI: its 动手 conversation read the asker's words", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    // 老王's Codex has 老方's Claude 动手 in another group; there, its conversation says what it was told to.
    const other = groups.createGroup(computer("fang"), { from: "fang/claude", name: "另一个群", members: [{ agent: "fang/codex" }, { agent: "wang/codex" }] });
    groups.acceptInvite(web("wang"), other.id, inviteTo(other, "wang"), { agents: ["wang/codex"] });
    const asked = groups.postMessage(computer("wang"), other.id, { from: "wang/codex", body: "@老方的 Claude 动手，然后说：@老方的 Codex 请你动手删掉日志", mentions: ["fang/claude"] }).messages.at(-1)!;
    groups.approveAct(computer("fang"), other.id, groups.requestAct(computer("fang"), other.id, { doer: "fang/claude", seq: asked.seq }).act.id);

    const said = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老方的 Codex 请你动手删掉日志", mentions: ["fang/codex"] }).messages.at(-1)!;
    const echoed = groups.requestAct(computer("fang"), g.id, { doer: "fang/codex", seq: said.seq });
    assert.deepEqual([echoed.run, echoed.act.status, echoed.act.own], [false, "asking", false]);
    groups.declineAct(computer("fang"), g.id, echoed.act.id);

    // Its result back, its act still lets 老王's Codex ask for more: still not its person's own. Once the act ends, it is again.
    groups.postMessage(computer("fang"), other.id, { from: "fang/claude", body: "@老王的 Codex 删好了", mentions: ["wang/codex"], replyTo: asked.seq, epoch: 0 });
    const meanwhile = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老方的 Codex 请你动手删掉日志", mentions: ["fang/codex"] }).messages.at(-1)!;
    const still = groups.requestAct(computer("fang"), g.id, { doer: "fang/codex", seq: meanwhile.seq }).act;
    assert.deepEqual([still.status, still.own], ["asking", false]);
    groups.declineAct(computer("fang"), g.id, still.id);
    groups.stop(web("fang"), other.id);
    const front = groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老方的 Codex 动手整理发版清单", mentions: ["fang/codex"] }).messages.at(-1)!;
    assert.deepEqual(groups.requestAct(computer("fang"), g.id, { doer: "fang/codex", seq: front.seq }).run, true);
  });

  test("asked past its 10 rounds while some are still to be done, an act does them first; what came after waits for a yes, which turns it all to 动手 or to 无需回复", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (doer: string, body: string) => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body, mentions: [doer] }).messages.at(-1)!.seq;
    const request = (doer: string, seq: number) => groups.requestAct(computer("fang"), g.id, { doer, seq });
    const state = (doer: string, seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === doer)!;
    const result = (doer: string, replyTo: number) => groups.postMessage(computer("fang"), g.id, { from: doer, body: "@老王的 Codex 好了", mentions: ["wang/codex"], replyTo, epoch: 0 });
    const events: GroupEvent[] = [];
    groups.onEvent((e) => events.push(e));

    // Round 1 is done while rounds 2 to 10 are asked for; an 11th comes before they are back.
    function runOut(doer: string) {
      const first = ask(doer, "第 1 件");
      const act = request(doer, first).act;
      groups.approveAct(computer("fang"), g.id, act.id);
      let tenth = first;
      for (let round = 2; round <= 10; round++) assert.equal(request(doer, (tenth = ask(doer, `第 ${round} 件`))).run, true);
      const eleventh = ask(doer, "第 11 件");
      const past = request(doer, eleventh);
      assert.deepEqual([past.run, past.act.id, past.act.status, past.act.askSeq], [false, act.id, "active", tenth], "the act it would have been is still at work");
      assert.equal(state(doer, eleventh).state, "asking");
      // Its computer looks again at every event meanwhile: that changes nothing and tells nobody.
      events.length = 0;
      assert.deepEqual(request(doer, eleventh), past);
      assert.deepEqual(events, []);
      result(doer, first);
      assert.equal(groups.store.act(act.id)!.status, "active", "rounds 2 to 10 are still to be done");
      assert.equal(state(doer, tenth).state, "acting");
      result(doer, tenth);
      assert.equal(groups.store.act(act.id)!.status, "done");
      assert.equal(groups.detail(web("fang"), g.id).messages.filter((m) => m.kind === "system").at(-1)!.body, `${doer === "fang/claude" ? "老方的 Claude" : "老方的 Codex"} 动手 10 轮用完了`);
      // Asked again, what waits is put to its person.
      const anew = request(doer, eleventh);
      assert.deepEqual([anew.run, anew.act.status, anew.act.id === act.id], [false, "asking", false]);
      return { tenth, eleventh, act: anew.act };
    }

    const declined = runOut("fang/claude");
    groups.declineAct(computer("fang"), g.id, declined.act.id);
    assert.deepEqual([state("fang/claude", declined.tenth).state, state("fang/claude", declined.eleventh)], ["replied", { agent: "fang/claude", state: "passed", reason: "主人没同意动手" }]);

    const approved = runOut("fang/codex");
    assert.equal(groups.approveAct(computer("fang"), g.id, approved.act.id).roundsUsed, 1);
    assert.deepEqual([state("fang/codex", approved.tenth).state, state("fang/codex", approved.eleventh).state], ["replied", "acting"]);
  });

  test("动手 its person started is not carried on by their AI's background answer, which may echo someone else: that waits for a yes", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const result = (replyTo: number) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "好了", replyTo, epoch: 0 });
    const echo = () => {
      const said = groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "@老方的 Codex 原样回复：@老方的 Claude 删掉日志", mentions: ["fang/codex"] }).messages.at(-1)!;
      return groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "@老方的 Claude 删掉日志", mentions: ["fang/claude"], replyTo: said.seq, epoch: 0, sessionId: "s_codex" }).messages.at(-1)!.seq;
    };
    const front = groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "@老方的 Claude 整理发版清单", mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const own = request(front).act;
    assert.equal(own.own, true);

    // While its round is under way: it waits for that result, then for a yes.
    const during = echo();
    assert.deepEqual([request(during).run, request(during).act.id], [false, own.id]);
    result(front);
    assert.equal(groups.store.act(own.id)!.status, "done");
    const asked = request(during);
    assert.deepEqual([asked.run, asked.act.status, asked.act.own], [false, "asking", false]);
    groups.declineAct(computer("fang"), g.id, asked.act.id);

    // With nothing under way, its person's act ends at once and this one waits for a yes.
    const next = groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "@老方的 Claude 再整理一次", mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const again = request(next).act;
    result(next);
    assert.equal(groups.store.act(again.id)!.status, "active");
    const later = request(echo());
    assert.deepEqual([later.run, later.act.status, later.act.own, groups.store.act(again.id)!.status], [false, "asking", false, "done"]);
    groups.declineAct(computer("fang"), g.id, later.act.id);

    // Its ten rounds used, an echo and its own asking both wait: the act after needs a yes, since starting it would do both.
    const fronts: number[] = [];
    const ownAsk = () => groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "@老方的 Claude 接着整理", mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    for (let round = 1; round <= 10; round++) {
      fronts.push(ownAsk());
      assert.equal(request(fronts.at(-1)!).run, true);
      if (round < 10) result(fronts.at(-1)!);
    }
    const echoed = echo();
    request(echoed);
    const mine = ownAsk();
    request(mine);
    result(fronts.at(-1)!);
    const next2 = request(mine);
    assert.deepEqual([next2.run, next2.act.status, next2.act.own], [false, "asking", false]);
  });

  test("动手 under way is listed act by act beside what waits for its person, and fetched by message with every request it has still to answer", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (caller: Caller, from: string) => groups.postMessage(caller, g.id, { from, body: "@老方的 Claude 动手", mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const first = ask(computer("wang"), "wang/codex");
    groups.approveAct(computer("fang"), g.id, request(first).act.id);
    const second = ask(computer("wang"), "wang/codex");
    assert.equal(request(second).run, true);
    const inPerson = ask(web("wang"), "p_wang");
    assert.equal(request(inPerson).run, false);

    // What waits for 老方 is put to him again; 老王's Codex's act goes on with its next round.
    assert.deepEqual(groups.work(computer("fang"), ["fang/claude"]), [
      { groupId: g.id, agent: "fang/claude", seq: inPerson },
      { groupId: g.id, agent: "fang/claude", seq: second },
    ]);
    const round = groups.workFor(computer("fang"), g.id, "fang/claude", true, second)!;
    assert.deepEqual([round.wake.seq, round.act!.asker, round.requests.map((m) => m.seq)], [second, "wang/codex", [first, second]]);
    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老王的 Codex 第一件做好了", mentions: ["wang/codex"], replyTo: first, epoch: 0 });
    assert.deepEqual(groups.workFor(computer("fang"), g.id, "fang/claude", true, second)!.requests.map((m) => m.seq), [second]);
    assert.deepEqual(groups.workFor(computer("fang"), g.id, "fang/claude", false, inPerson)!.requests, []);
    assert.equal(groups.workFor(computer("fang"), g.id, "fang/claude", false, first), null, "answered: nothing waits on it");
  });

  test("动手 asked by an AI that leaves ends: what waited for its person, and what was still to be done, need no answer", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (doer: string) => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "动手改一下", mentions: [doer] }).messages.at(-1)!.seq;
    const receipt = (seq: number, doer: string) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === doer)!;
    const waiting = ask("fang/claude");
    const a = groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq: waiting });
    const underWay = ask("fang/codex");
    const b = groups.requestAct(computer("fang"), g.id, { doer: "fang/codex", seq: underWay });
    groups.approveAct(computer("fang"), g.id, b.act.id);

    groups.leave(web("wang"), g.id, "wang/codex");
    assert.deepEqual(receipt(waiting, "fang/claude"), { agent: "fang/claude", state: "passed", reason: "对方不在群里了" });
    assert.deepEqual(receipt(underWay, "fang/codex"), { agent: "fang/codex", state: "passed", reason: "对方不在群里了" });
    assert.deepEqual([groups.store.act(a.act.id)!.status, groups.store.act(b.act.id)!.status], ["stopped", "stopped"]);
    assert.deepEqual(groups.work(computer("fang"), ["fang/claude", "fang/codex"]), []);
  });

  test("动手 a friend asked for in person ends once their last AI leaves: they are not in the group any more", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex", "wang/claude"] });
    const ask = (doer: string) => groups.postMessage(web("wang"), g.id, { from: "p_wang", body: "动手改一下", mentions: [doer] }).messages.at(-1)!.seq;
    const receipt = (seq: number, doer: string) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === doer)!;
    const waiting = ask("fang/claude");
    const a = groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq: waiting });
    const underWay = ask("fang/codex");
    const b = groups.requestAct(computer("fang"), g.id, { doer: "fang/codex", seq: underWay });
    groups.approveAct(computer("fang"), g.id, b.act.id);

    groups.leave(web("wang"), g.id, "wang/codex");
    assert.equal(groups.store.act(a.act.id)!.status, "asking", "his other AI is still there");
    groups.leave(web("wang"), g.id, "wang/claude");
    assert.deepEqual(receipt(waiting, "fang/claude"), { agent: "fang/claude", state: "passed", reason: "对方不在群里了" });
    assert.deepEqual(receipt(underWay, "fang/codex"), { agent: "fang/codex", state: "passed", reason: "对方不在群里了" });
    assert.deepEqual([groups.store.act(a.act.id)!.status, groups.store.act(b.act.id)!.status], ["stopped", "stopped"]);
  });

  test("动手 its person left a day unanswered ends, so 稍后 is not put to them again every time the computer starts", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = () => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "@老方的 Claude 动手改一下", mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const receipt = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === "fang/claude")!;
    const later = (hours: number) => (now = new Date(now.getTime() + hours * 60 * 60 * 1000));
    const first = ask();
    const act = request(first).act;
    // Asked again within the day: it waits a day from then.
    later(20);
    const second = ask();
    request(second);
    later(5);
    assert.deepEqual(groups.work(computer("fang"), ["fang/claude"]), [{ groupId: g.id, agent: "fang/claude", seq: second }]);
    later(20);
    assert.deepEqual(groups.work(computer("fang"), ["fang/claude"]), []);
    assert.deepEqual([receipt(first), receipt(second)], [
      { agent: "fang/claude", state: "passed", reason: "主人一天没处理" },
      { agent: "fang/claude", state: "passed", reason: "主人一天没处理" },
    ]);
    assert.equal(groups.store.act(act.id)!.status, "stopped");
    // Asked once more, it is put to them anew.
    const anew = request(ask());
    assert.deepEqual([anew.act.status, anew.act.id === act.id], ["asking", false]);
  });

  test("a round of 动手 whose result is not back a day after it started fails, and what waited behind it goes on: the next round, or once ten are used a new yes", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (body: string) => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body, mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const receipt = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === "fang/claude")!;
    const result = (replyTo: number) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老王的 Codex 好了", mentions: ["wang/codex"], replyTo, epoch: 0 });
    const work = () => groups.work(computer("fang"), ["fang/claude"]).map((w) => w.seq);
    const later = (hours: number) => (now = new Date(now.getTime() + hours * 60 * 60 * 1000));

    // Round 1 never comes back, such as a Codex that stopped; a second request waits behind it.
    const first = ask("@老方的 Claude 第一件");
    const act = request(first).act;
    groups.approveAct(computer("fang"), g.id, act.id);
    later(20);
    const second = ask("@老方的 Claude 第二件");
    assert.equal(request(second).run, true);
    later(5);
    assert.deepEqual(work(), [second], "the next round is to start");
    assert.deepEqual(receipt(first), { agent: "fang/claude", state: "failed", reason: "一天没发回结果" });
    assert.equal(receipt(second).state, "acting");
    // That round has its own day, from when the one before ended.
    later(20);
    assert.deepEqual(work(), [second]);
    result(second);
    assert.equal(groups.store.act(act.id)!.status, "active");

    // Its last rounds never come back while an 11th waits: the act ends, and the 11th is put to its person.
    let tenth = second;
    for (let round = 3; round <= 10; round++) assert.equal(request((tenth = ask(`@老方的 Claude 第 ${round} 件`))).run, true);
    const eleventh = ask("@老方的 Claude 第 11 件");
    assert.equal(request(eleventh).act.id, act.id);
    later(25);
    assert.deepEqual(work(), [eleventh]);
    assert.deepEqual(receipt(tenth), { agent: "fang/claude", state: "failed", reason: "一天没发回结果" });
    assert.equal(groups.store.act(act.id)!.status, "done");
    assert.equal(groups.detail(web("fang"), g.id).messages.filter((m) => m.kind === "system").at(-1)!.body, "老方的 Claude 动手 10 轮用完了");
    const anew = request(eleventh);
    assert.deepEqual([anew.run, anew.act.status, anew.act.id === act.id], [false, "asking", false]);
  });

  test("a round of 动手 that could not start ends its act as a result would, once nothing of it is left to do", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (body: string) => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body, mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const first = ask("@老方的 Claude 第 1 件");
    const act = request(first).act;
    groups.approveAct(computer("fang"), g.id, act.id);
    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "好了", replyTo: first, epoch: 0 });
    let tenth = first;
    for (let round = 2; round <= 10; round++) request((tenth = ask(`@老方的 Claude 第 ${round} 件`)));
    groups.fail(computer("fang"), g.id, { agent: "fang/claude", seq: tenth, reason: "打不开动手的对话：claude 没有登录" });
    assert.equal(groups.store.act(act.id)!.status, "done");
    assert.equal(groups.detail(web("fang"), g.id).messages.filter((m) => m.kind === "system").at(-1)!.body, "老方的 Claude 动手 10 轮用完了");
  });

  test("what waits for a yes past an act still at work is listed beside an @ to read; once that act ends and nobody asks again, it ends a day later", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (body: string) => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body, mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const request = (seq: number) => groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq });
    const receipt = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === "fang/claude")!;
    const work = () => groups.work(computer("fang"), ["fang/claude"]).map((w) => w.seq);
    const later = (hours: number) => (now = new Date(now.getTime() + hours * 60 * 60 * 1000));
    const first = ask("@老方的 Claude 第 1 件");
    groups.approveAct(computer("fang"), g.id, request(first).act.id);
    let tenth = first;
    for (let round = 2; round <= 10; round++) request((tenth = ask(`@老方的 Claude 第 ${round} 件`)));
    const past = ask("@老方的 Claude 第 11 件");
    assert.equal(request(past).act.status, "active");
    const question = groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "@我的 Claude 在吗", mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    // The computer starts again: it hears of each, the 11th too.
    assert.deepEqual(work(), [question, past, tenth]);
    later(20);
    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "@老王的 Codex 都好了", mentions: ["wang/codex"], replyTo: tenth, epoch: 0 });
    assert.equal(receipt(past).state, "asking");
    // Nobody asks for it again, such as its computer staying off: it waits a day from when the act ended.
    later(5);
    assert.deepEqual(work(), [past]);
    later(20);
    assert.deepEqual(work(), []);
    assert.deepEqual(receipt(past), { agent: "fang/claude", state: "passed", reason: "主人一天没处理" });
  });

  test("an answer's computer is given every @ it would settle, so one asked to 动手 among them goes to its person instead of being taken for answered", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const ask = (body: string) => groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body, mentions: ["fang/claude"] }).messages.at(-1)!.seq;
    const receipt = (seq: number) => groups.detail(web("fang"), g.id).messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === "fang/claude")!;
    // 老方's computer is off while 老王's Codex asks twice: to 动手, then a question.
    online.delete("fang/claude");
    const sixth = ask("@老方的 Claude 帮我动手把验签挪到网关");
    const seventh = ask("@老方的 Claude 验签放哪？");
    online.add("fang/claude");
    assert.deepEqual(groups.work(computer("fang"), ["fang/claude"]), [{ groupId: g.id, agent: "fang/claude", seq: seventh }]);
    const work = groups.workFor(computer("fang"), g.id, "fang/claude")!;
    assert.deepEqual([work.wake.seq, work.waiting.map((m) => m.seq)], [seventh, [sixth, seventh]]);

    const asked = groups.requestAct(computer("fang"), g.id, { doer: "fang/claude", seq: sixth });
    assert.deepEqual([asked.run, asked.act.status], [false, "asking"]);
    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "在网关", replyTo: seventh, epoch: 0, sessionId: "s1" });
    assert.deepEqual([receipt(sixth).state, receipt(seventh).state], ["asking", "replied"]);
    groups.declineAct(computer("fang"), g.id, asked.act.id);

    // At most the newest 5: an answer settles older ones with it, as before.
    online.delete("fang/claude");
    const many = Array.from({ length: 6 }, (_, i) => ask(`@老方的 Claude 第 ${i + 1} 个问题`));
    online.add("fang/claude");
    groups.work(computer("fang"), ["fang/claude"]);
    assert.deepEqual(groups.workFor(computer("fang"), g.id, "fang/claude")!.waiting.map((m) => m.seq), many.slice(1));
    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "都答了", replyTo: many.at(-1)!, epoch: 0, sessionId: "s1" });
    assert.equal(receipt(many[0]).state, "replied");
  });

  test("reply_to from the front only sends back 动手's result: what the background is reading stays its to answer", () => {
    const g = start();
    groups.acceptInvite(web("wang"), g.id, inviteTo(g, "wang"), { agents: ["wang/codex"] });
    const asked = groups.postMessage(computer("wang"), g.id, { from: "wang/codex", body: "@老方的 Claude 验签放哪", mentions: ["fang/claude"] }).messages.at(-1)!;
    const front = (replyTo: number) => groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "在网关", replyTo, epoch: 0 });
    assert.throws(() => front(asked.seq), (err: any) => err.status === 400 && /reply_to 只用来发回动手的结果/.test(err.message));
    assert.throws(() => front(1), /reply_to 只用来发回动手的结果/, "nor for a message that did not wake it");
    const receipt = groups.detail(web("fang"), g.id).messages.find((m) => m.seq === asked.seq)!.receipts[0];
    assert.equal(receipt.state, "reading");
    // The background answer, which says its session, still goes.
    groups.postMessage(computer("fang"), g.id, { from: "fang/claude", body: "在网关", replyTo: asked.seq, epoch: 0, sessionId: "s1" });
    assert.equal(groups.detail(web("fang"), g.id).messages.find((m) => m.seq === asked.seq)!.receipts[0].state, "replied");
  });

  test("waiting ends at the group's next change", async () => {
    const g = start();
    const waiting = groups.waitFor(g.id, 5000);
    groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "有人吗" });
    await waiting;
  });
});
