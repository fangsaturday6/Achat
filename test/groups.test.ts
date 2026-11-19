import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { AgentConfig } from "../src/config.js";
import { GroupService, type Caller, type GroupDirectory } from "../src/relay/groups.js";
import { Store } from "../src/relay/store.js";
import { ALL } from "../src/types.js";

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
    groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "两条一起答了", replyTo: asked.seq, epoch: 0 });
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
    groups.postMessage(computer("fang"), g.id, { from: "fang/codex", body: "两条一起答了", replyTo: asked.seq, epoch: 0 });
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

  test("waiting ends at the group's next change", async () => {
    const g = start();
    const waiting = groups.waitFor(g.id, 5000);
    groups.postMessage(web("fang"), g.id, { from: "p_fang", body: "有人吗" });
    await waiting;
  });
});
