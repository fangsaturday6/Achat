import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { GROUP_LIMITS } from "../src/relay/groups.js";
import type { RunningRelay } from "../src/relay/server.js";
import { ALL, GROUP_STATUS_LABELS, RECEIPT_LABELS, todayTotal } from "../src/types.js";
import * as page from "../web/groups.js";
import { isOwn } from "../web/text.js";
import { startTestRelay } from "./helpers.js";

const WEB = join(import.meta.dirname, "..", "web");

describe("the page's modules", () => {
  let relay: RunningRelay;
  before(async () => ({ relay } = await startTestRelay()));
  after(() => relay.close());

  test("every script parses, and what app.js imports, and what those import, is served as JavaScript", async () => {
    const files = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      execFileSync(process.execPath, ["--check", join(WEB, file)]);
      // An import may run over several lines.
      for (const m of readFileSync(join(WEB, file), "utf8").matchAll(/^import [\s\S]*? from "\.\/(.+)";$/gm)) visit(m[1]);
    };
    visit("app.js");
    assert.deepEqual([...files].sort(), ["app.js", "group-view.js", "groups.js", "redraw.js", "text.js"]);
    for (const file of files) {
      const res = await fetch(`${relay.url}/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get("content-type") ?? "", /javascript/, file);
    }
  });
});

test("the page names receipts, states and 每天次数 as the relay does", () => {
  assert.deepEqual(page.RECEIPT_LABELS, RECEIPT_LABELS);
  assert.deepEqual(page.GROUP_STATUS_LABELS, GROUP_STATUS_LABELS);
  assert.equal(page.ALL, ALL);
  assert.deepEqual(page.QUOTA, { perDay: GROUP_LIMITS.quota, max: GROUP_LIMITS.maxQuota });
});

test("a group in 消息: the invite waiting in red, else who said the latest words; only invites count on 消息", () => {
  const base = { role: "member", lastMessage: null, lastSender: null, myInvite: null, unread: false };
  assert.deepEqual(page.groupPreview({ ...base, role: "invited", myInvite: { invitedByName: "老方的 Claude" } }), { pending: true, text: "老方的 Claude 邀请你" });
  const said = { kind: "message", body: "可以，网关把原始报文落一份", files: [] };
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: said, lastSender: "王闯的 Codex" }), { pending: false, text: "王闯的 Codex：可以，网关把原始报文落一份" });
  const note = { kind: "system", body: "老王的 Codex 加入了群聊", files: [] };
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: note }), { pending: false, text: "老王的 Codex 加入了群聊" });
  const picture = { kind: "message", body: "", files: [{ name: "截图.png", type: "image/png" }] };
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: picture, lastSender: "我" }), { pending: false, text: "我：[图片]" });
  assert.deepEqual(page.groupPreview(base), { pending: false, text: "" });
  assert.deepEqual(page.groupPreview({ ...base, role: "invited", myInvite: {} }), { pending: true, text: "有人邀请你" });
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: said, lastSender: null }), { pending: false, text: "可以，网关把原始报文落一份" });
  assert.equal(page.invitesWaiting([{ ...base, role: "invited" }, { ...base, unread: true }]), 1);
});

test("消息's number says what waits: conversations, invites to groups, or both", () => {
  assert.deepEqual(page.messagesBadge(2, 0), { count: 2, label: "消息，2 个对话等你看" });
  assert.deepEqual(page.messagesBadge(0, 1), { count: 1, label: "消息，1 个进群邀请等你看" });
  assert.deepEqual(page.messagesBadge(2, 1), { count: 3, label: "消息，2 个对话、1 个进群邀请等你看" });
  assert.deepEqual(page.messagesBadge(0, 0), { count: 0, label: "消息" });
});

test("a group's addresses in /api/groups, each part encoded", () => {
  assert.equal(page.groupPath(), "/api/groups");
  assert.equal(page.groupPath("g_1"), "/api/groups/g_1");
  assert.equal(page.groupPath("g_1", "leave"), "/api/groups/g_1/leave");
  assert.equal(page.groupPath("g/1", "invites", "gi 2", "accept"), "/api/groups/g%2F1/invites/gi%202/accept");
});

describe("what 消息 and the open group show once /api/groups answers", () => {
  const ok = (value: unknown) => ({ status: "fulfilled", value });
  const failed = (status: number) => ({ status: "rejected", reason: Object.assign(new Error("连不上 Achat"), { status }) });
  const a = { id: "g_a", name: "支付对接" };
  const b = { id: "g_b", name: "发版" };
  const shown = { id: "g_a", name: "支付对接", messages: [] };
  const fresh = { id: "g_a", name: "支付对接", messages: [{ seq: 1 }] };
  const before = { groups: [a], group: shown };

  test("both answer: what they sent", () => {
    assert.deepEqual(page.loadedGroups(before, "g_a", ok([a, b]), ok(fresh)), { groups: [a, b], group: fresh, gone: false });
  });

  test("the list fails: 消息 keeps the groups it had", () => {
    assert.deepEqual(page.loadedGroups(before, "g_a", failed(0), ok(fresh)), { groups: [a], group: fresh, gone: false });
    assert.deepEqual(page.loadedGroups(before, "g_a", failed(500), ok(fresh)).groups, [a]);
  });

  test("the open group fails: it stays as it was shown, unless it is another one", () => {
    assert.deepEqual(page.loadedGroups(before, "g_a", ok([a, b]), failed(0)), { groups: [a, b], group: shown, gone: false });
    assert.deepEqual(page.loadedGroups(before, "g_a", ok([a, b]), failed(500)).group, shown);
    assert.deepEqual(page.loadedGroups(before, "g_b", ok([a, b]), failed(0)), { groups: [a, b], group: null, gone: false });
  });

  test("a group the person cannot open (removed from it, left it, or a wrong link) is gone: back to 消息", () => {
    assert.deepEqual(page.loadedGroups(before, "g_a", ok([b]), failed(404)), { groups: [b], group: null, gone: true });
    assert.deepEqual(page.loadedGroups(before, "g_x", failed(0), failed(404)), { groups: [a], group: null, gone: true });
  });

  test("no group open: none, whatever was shown before", () => {
    assert.deepEqual(page.loadedGroups(before, null, ok([a, b]), ok(null)), { groups: [a, b], group: null, gone: false });
  });
});

test("each @ reads from the person's side, while the words keep nobody's side", () => {
  const names = { "f/claude": "我的 Claude", "w/codex": "老王的 Codex", p_fang: "我" };
  const me = { name: "老方", seat: "p_fang" };
  assert.equal(page.plainName("我的 Claude", "老方"), "老方的 Claude");
  assert.equal(page.plainName("我的豆包", "老方"), "老方的豆包");
  assert.equal(page.plainName("我", "老方"), "老方");
  assert.equal(page.plainName("老王的 Codex", "老方"), "老王的 Codex");
  const tags = page.tagsOf([ALL, "f/claude", "w/codex"], names, me);
  assert.deepEqual(page.segments("@所有人 先说现状。@老方的 Claude 和 @老王的 Codex 呢", tags), [
    { text: "@所有人", at: true },
    { text: " 先说现状。", at: false },
    { text: "@我的 Claude", at: true },
    { text: " 和 ", at: false },
    { text: "@老王的 Codex", at: true },
    { text: " 呢", at: false },
  ]);
  assert.deepEqual(page.segments("没有点名", tags), [{ text: "没有点名", at: false }]);
  // An AI calling its own person: "@老方", never taken from inside "@老方的 Claude".
  const both = page.tagsOf(["p_fang", "f/claude"], names, me);
  assert.deepEqual(page.segments("@老方的 Claude 和 @老方 都看看", both), [
    { text: "@我的 Claude", at: true },
    { text: " 和 ", at: false },
    { text: "@老方", at: true },
    { text: " 都看看", at: false },
  ]);
});

test("a time goes before the first message and after five quiet minutes", () => {
  const at = (seq: number, t: string) => ({ seq, createdAt: `2026-11-19T${t}:00Z` });
  assert.deepEqual([...page.timeBreaks([at(1, "02:52"), at(2, "02:53"), at(3, "02:58"), at(4, "03:05")])], [1, 3, 4]);
  assert.deepEqual([...page.timeBreaks([])], []);
});

test("the line under a message says who did not reply, the same state together, and opens when there is more to say", () => {
  const names = { a: "老王的 Claude", b: "小林的 Claude", c: "小林的豆包", d: "王闯的 Codex", e: "老王的 Codex" };
  const r = (agent: string, state: string, reason: string | null = null) => ({ agent, state, reason });
  assert.equal(page.receiptLine([r("e", "replied")], names), null);
  const all = page.receiptLine([r("e", "replied"), r("a", "passed", "订单和回调由老王的 Codex 说"), r("b", "offline"), r("c", "cannot")], names);
  assert.equal(all.text, "老王的 Claude 无需回复 · 小林的 Claude 不在线 · 小林的豆包 还不能接收");
  assert.deepEqual([all.open, all.reading], [true, false]);
  assert.deepEqual(all.items.map((i: any) => [i.name, i.state, i.reason]), [
    ["老王的 Claude", "passed", "订单和回调由老王的 Codex 说"],
    ["小林的 Claude", "offline", null],
    ["小林的豆包", "cannot", null],
  ]);
  const one = page.receiptLine([r("d", "reading")], names);
  assert.deepEqual([one.text, one.open, one.reading], ["王闯的 Codex 正在看…", false, true]);
  assert.equal(page.receiptLine([r("a", "stopped"), r("b", "stopped")], names).text, "老王的 Claude、小林的 Claude 已叫停");
  assert.equal(page.receiptLine(["a", "b", "c", "d"].map((x) => r(x, "stopped")), names).text, "老王的 Claude 等 4 个 AI 已叫停");
  assert.equal(page.receiptLine([r("gone", "failed", "不在群里了")], names).text, "已移除的 AI 没答上");
});

// 支付对接 from 老方's side, in the order they joined.
const MEMBERS = [
  { agent: "f/claude", name: "我的 Claude", owner: "fang", canReceive: true, online: true, quota: 30, usedToday: 12 },
  { agent: "w/codex", name: "老王的 Codex", owner: "wang", canReceive: true, online: true },
  { agent: "w/claude", name: "老王的 Claude", owner: "wang", canReceive: true, online: true },
  { agent: "l/claude", name: "小林的 Claude", owner: "lin", canReceive: true, online: false },
  { agent: "l/doubao", name: "小林的豆包", owner: "lin", canReceive: false, online: false },
  { agent: "c/codex", name: "王闯的 Codex", owner: "chuang", canReceive: true, online: true },
];

test("the line under a message says 动手 too: 正在动手 turns like 正在看, 等主人同意 waits still, and 叫停 shows while an AI is at work", () => {
  const names = { a: "老王的 Claude", d: "王闯的 Codex" };
  const r = (agent: string, state: string) => ({ agent, state, reason: null });
  const both = page.receiptLine([r("d", "acting"), r("a", "asking")], names);
  assert.deepEqual([both.text, both.reading], ["王闯的 Codex 正在动手… · 老王的 Claude 等主人同意", true]);
  assert.equal(page.receiptLine([r("a", "asking")], names).reading, false);
  const msg = (state: string) => ({ receipts: [{ agent: "c/codex", state, reason: null }] });
  assert.equal(page.isAnswering({ status: "open", messages: [msg("acting")] }), true);
  assert.equal(page.isAnswering({ status: "open", messages: [msg("asking")] }), false);
});

test("the person's own AIs in a group, or of theirs anywhere, are those of their account (isOwn)", () => {
  assert.equal(isOwn(MEMBERS[0], "fang"), true);
  assert.equal(isOwn(MEMBERS[1], "fang"), false);
  assert.equal(isOwn(MEMBERS[1], "wang"), true);
  assert.equal(isOwn({ agent: "f/claude", owner: "fang" }, "fang"), true, "an AI from /api/agents, or one picked");
});

test("the list under @: 所有人, the AIs that are on (the person's own after), those off, and grayed out last those that cannot answer", () => {
  assert.deepEqual(page.pickerOptions(MEMBERS, "fang").map((o: any) => [o.name, o.note, o.disabled]), [
    ["所有人", null, false],
    ["老王的 Codex", null, false],
    ["老王的 Claude", null, false],
    ["王闯的 Codex", null, false],
    ["我的 Claude", null, false],
    ["小林的 Claude", "不在线", false],
    ["小林的豆包", "还不能接收", true],
  ]);
  assert.deepEqual(page.pickerOptions(MEMBERS, "fang", "老王").map((o: any) => o.name), ["老王的 Codex", "老王的 Claude"]);
  assert.deepEqual(page.pickerOptions(MEMBERS, "fang", "all").map((o: any) => o.id), [ALL]);
  assert.deepEqual(page.pickerOptions(MEMBERS, "fang", "没有这个人"), []);
  // From 老王's side, his own two go after the others that are on.
  assert.deepEqual(page.pickerOptions(MEMBERS.slice(0, 3), "wang").map((o: any) => o.id), [ALL, "f/claude", "w/codex", "w/claude"]);
});

test("the @ being typed is found just before the caret", () => {
  assert.deepEqual(page.mentionAt("你好 @老王", 6), { start: 3, query: "老王" });
  assert.deepEqual(page.mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(page.mentionAt("没有", 2), null);
  assert.equal(page.mentionAt("第一行@\n第二", 6), null);
  assert.equal(page.mentionAt("@老王的 Codex ", 11), null, "a space after a name ends it");
});

test("a pick writes the name over the @ before the caret, wherever the caret went since the list opened", () => {
  // "请 @老 看看", typed with the caret after 老 (4).
  assert.deepEqual(page.applyPick("请 @老 看看", 4, "老王的 Codex"), { value: "请 @老王的 Codex  看看", caret: 13 });
  assert.equal(page.applyPick("请 @老 看看", 1, "老王的 Codex"), null, "the caret moved in front of the @");
  assert.equal(page.applyPick("请 @老 看看", 7, "老王的 Codex"), null, "the caret moved to the end: 看看 is not part of a name");
  assert.deepEqual(page.applyPick("@al", 3, "所有人"), { value: "@所有人 ", caret: 5 }, "所有人 is also found by all");
  assert.deepEqual(page.applyPick("看 @老王的 c", 8, "老王的 Codex"), { value: "看 @老王的 Codex ", caret: 13 });
});

test("whose a message in a group is: the person's seat and their AIs, those that left too", () => {
  const g = {
    members: [
      { agent: "f/claude", name: "我的 Claude", owner: "fang" },
      { agent: "x/claude", name: "我爱罗的 Claude", owner: "xia" },
    ],
    names: { p_fang: "我", "f/claude": "我的 Claude", "x/claude": "我爱罗的 Claude", p_xia: "我爱罗", "f/codex": "我的 Codex", "x/codex": "我爱罗的 Codex", gone: "我的豆包" },
  };
  // The person's AIs and their friends' (/api/agents): those that left the group are still here.
  const agents = new Map([
    ["f/codex", { owner: "fang" }],
    ["x/codex", { owner: "xia" }],
  ]);
  const mine = (sender: string) => page.sentByMe(sender, g, "fang", agents);
  assert.equal(mine("p_fang"), true, "the person's own seat");
  assert.equal(mine("f/claude"), true, "their AI in the group");
  assert.equal(mine("x/claude"), false, "a friend named 我爱罗: his AI");
  assert.equal(mine("p_xia"), false, "and himself");
  assert.equal(mine("f/codex"), true, "their AI that left the group");
  assert.equal(mine("x/codex"), false, "a friend's AI that left");
  // Gone from the group and from the person's AIs: its name is all that is left.
  assert.equal(mine("gone"), true);
});

test("who is behind a sender in a group, for its face: an AI the page knows, one in the group, or a person's seat", () => {
  const g = {
    members: [
      { agent: "f/claude", name: "我的 Claude", owner: "fang" },
      { agent: "c/codex", name: "王闯的 Codex", owner: "chuang" },
    ],
    names: { "f/claude": "我的 Claude", "c/codex": "王闯的 Codex", p_chuang: "王闯", "x/codex": "我爱罗的 Codex", gone: "已移除的 AI" },
  };
  const agents = new Map([["x/codex", { id: "x/codex", name: "我爱罗的 Codex", client: "codex", owner: "xia" }]]);
  assert.equal(page.whoIn("x/codex", g, agents), agents.get("x/codex"), "a friend's AI that left: as /api/agents has it");
  assert.deepEqual(page.whoIn("c/codex", g, agents), { name: "王闯的 Codex", owner: "chuang" }, "a friend's friend, by the group");
  assert.deepEqual(page.whoIn("p_chuang", g, agents), { name: "王闯", client: "person", owner: "chuang" }, "a person's seat");
  assert.equal(page.whoIn("gone", g, agents), null, "known only by its name");
});

test("what the person writes goes in with its @s, each AI named from nobody's side", () => {
  assert.deepEqual(page.composeMessage(" @我的 Claude 和 @老王的 Codex 看看，@所有人 也说说 ", MEMBERS, "老方"), {
    body: "@老方的 Claude 和 @老王的 Codex 看看，@所有人 也说说",
    mentions: [ALL, "f/claude", "w/codex"],
  });
  const twins = [...MEMBERS, { agent: "w2/codex", name: "老王的 Codex（iMac）", canReceive: true, online: true }];
  assert.deepEqual(page.composeMessage("@老王的 Codex（iMac） 你呢", twins, "老方").mentions, ["w2/codex"]);
  assert.deepEqual(page.composeMessage("@老王的 Codex 和 @老王的 Codex（iMac） 和 @老王的 Codex", twins, "老方"), {
    body: "@老王的 Codex 和 @老王的 Codex（iMac） 和 @老王的 Codex",
    mentions: ["w/codex", "w2/codex"],
  });
  assert.deepEqual(page.composeMessage("没有点名", MEMBERS, "老方"), { body: "没有点名", mentions: [] });
  // Typed from nobody's side, as the AIs write it.
  assert.deepEqual(page.composeMessage("@老方的 Claude 你看", MEMBERS, "老方"), { body: "@老方的 Claude 你看", mentions: ["f/claude"] });
  // Whatever the words hold, nothing in them is taken for an @.
  assert.deepEqual(page.composeMessage("@\u0000nobody\u0000 和 \u0000 @老王的 Codex", MEMBERS, "老方"), {
    body: "@\u0000nobody\u0000 和 \u0000 @老王的 Codex",
    mentions: ["w/codex"],
  });
});

test("the bottom names the person's AI nearest its 每天次数, red once used up; 叫停 shows while an AI reads", () => {
  assert.deepEqual(page.quotaLine(MEMBERS, "fang"), { agent: "f/claude", text: "我的 Claude 今天 12 / 30 次", full: false });
  const two = [MEMBERS[0], { agent: "f/codex", name: "我的 Codex", owner: "fang", canReceive: true, online: true, quota: 5, usedToday: 5 }];
  assert.deepEqual(page.quotaLine(two, "fang"), { agent: "f/codex", text: "我的 Codex 今天 5 / 5 次", full: true });
  assert.equal(page.quotaLine(MEMBERS.slice(1), "fang"), null);
  // Nearest is the fewest times left, not the most used by share.
  const big = { agent: "f/claude", name: "我的 Claude", owner: "fang", canReceive: true, online: true, quota: 500, usedToday: 400 };
  const small = { agent: "f/codex", name: "我的 Codex", owner: "fang", canReceive: true, online: true, quota: 5, usedToday: 0 };
  assert.equal(page.quotaLine([big, small], "fang").agent, "f/codex");
  // As many left: the one with more of its share used.
  assert.equal(page.quotaLine([{ ...big, quota: 20, usedToday: 10 }, { ...small, quota: 100, usedToday: 90 }], "fang").agent, "f/codex");
  assert.equal(page.quotaLine([{ ...small, quota: 100, usedToday: 90 }, { ...big, quota: 20, usedToday: 10 }], "fang").agent, "f/codex");
  const msg = (state: string) => ({ receipts: [{ agent: "c/codex", state, reason: null }] });
  assert.equal(page.isAnswering({ status: "open", messages: [msg("passed"), msg("reading")] }), true);
  assert.equal(page.isAnswering({ status: "open", messages: [msg("passed")] }), false);
  assert.equal(page.isAnswering({ status: "stopped", messages: [msg("reading")] }), false);
});

test("what was added for today counts: the bottom and 群设置 say what is used of today's total", () => {
  const added = { agent: "f/claude", name: "我的 Claude", owner: "fang", canReceive: true, online: true, quota: 30, usedToday: 32, extraToday: 30 };
  assert.equal(page.todayTotal(added), 60);
  assert.equal(page.todayTotal({ ...added, extraToday: undefined }), 30);
  // The same sum as the service and the AI tools say.
  for (const m of [added, { ...added, extraToday: undefined }, { ...added, extraToday: 0 }]) assert.equal(page.todayTotal(m), todayTotal(m));
  assert.deepEqual(page.quotaLine([added], "fang"), { agent: "f/claude", text: "我的 Claude 今天 32 / 60 次", full: false });
  assert.equal(page.quotaLine([{ ...added, usedToday: 60 }], "fang").full, true);
  // Nearest is still the fewest times left today.
  const other = { ...added, agent: "f/codex", name: "我的 Codex", usedToday: 26, extraToday: 0 };
  assert.equal(page.quotaLine([added, other], "fang").agent, "f/codex");
  assert.equal(page.usedText(added), "今天用了 32 / 60 次");
  assert.equal(page.usedText({ ...added, usedToday: 12, extraToday: 0 }), "今天用了 12 次");
});

test("群设置 lists the members, then those invited as 等加入; a click on each offers what the person may do", () => {
  const g = {
    owner: "fang",
    status: "open",
    members: [MEMBERS[0], MEMBERS[1]],
    invites: [
      { id: "gi_1", name: "王闯", agent: "c/claude", agentName: "王闯的 Claude" },
      { id: "gi_2", name: "小林", agent: null, agentName: null },
    ],
  };
  const tiles = page.settingsTiles(g, "fang");
  assert.deepEqual(tiles.map((t: any) => [t.id, t.name, t.waiting, t.mine]), [
    ["f/claude", "我的 Claude", false, true],
    ["w/codex", "老王的 Codex", false, false],
    ["gi_1", "王闯的 Claude", true, false],
    ["gi_2", "小林", true, false],
  ]);
  assert.deepEqual(page.settingsTiles(g, "wang").map((t: any) => t.mine), [false, true, false, false], "老王's own, from his side");
  assert.deepEqual(tiles.map((t: any) => page.tileActions(t, g, "fang")), [["leave"], ["remove"], [], []]);
  assert.deepEqual(page.tileActions(tiles[1], g, "wang"), [], "only 群主 removes another's AI");
  assert.deepEqual(page.tileActions(tiles[0], { ...g, status: "dissolved" }, "fang"), []);
});

test("群设置: someone in the group answers an invite for another of their AIs on its tile", () => {
  const g = {
    owner: "wang",
    status: "open",
    members: [{ ...MEMBERS[5], quota: 30, usedToday: 0 }],
    invites: [
      { id: "gi_1", account: "chuang", name: "我", agent: "c/claude", agentName: "我的 Claude" },
      { id: "gi_2", account: "chuang", name: "我", agent: null, agentName: null },
      { id: "gi_3", account: "lin", name: "小林", agent: "l/claude", agentName: "小林的 Claude" },
    ],
  };
  const tiles = page.settingsTiles(g, "chuang");
  assert.deepEqual(tiles.slice(1).map((t: any) => [t.id, t.account, t.agent]), [
    ["gi_1", "chuang", "c/claude"],
    ["gi_2", "chuang", null],
    ["gi_3", "lin", "l/claude"],
  ]);
  assert.deepEqual(tiles.map((t: any) => page.tileActions(t, g, "chuang")), [["leave"], ["join", "decline"], [], []]);
  assert.deepEqual(page.tileActions(tiles[1], { ...g, status: "stopped" }, "chuang"), ["join", "decline"]);
  assert.deepEqual(page.tileActions(tiles[1], { ...g, status: "dissolved" }, "chuang"), []);
});

test("群设置: each tile's face is its person's: the AI's, or the one invited, by account", () => {
  const g = {
    members: [{ agent: "x/claude", name: "我爱罗的 Claude", owner: "xia" }],
    invites: [
      { id: "gi_1", account: "chuang", name: "王闯", agent: "c/claude", agentName: "王闯的 Claude" },
      { id: "gi_2", account: "de", name: "小的", agent: null, agentName: null },
    ],
  };
  assert.deepEqual(page.settingsTiles(g, "fang").map((t: any) => t.who), [
    { name: "我爱罗的 Claude", owner: "xia" },
    { name: "王闯", client: "person", owner: "chuang" },
    { name: "小的", client: "person", owner: "de" },
  ]);
});

test("群设置 shows 群主 the name to change and 解散群; everyone in it their 每天次数 and 退出群; a dissolved group only 退出群", () => {
  const mine = { agent: "f/claude", name: "我的 Claude", owner: "fang", quota: 30, usedToday: 2 };
  const wang = { agent: "w/codex", name: "老王的 Codex", owner: "wang" };
  const g = { owner: "fang", status: "open", members: [mine, wang] };
  const shown = (v: any) => [v.rename, v.invite, v.quotas.map((m: any) => m.agent), v.leave, v.dissolve];
  assert.deepEqual(shown(page.settingsView(g, "fang")), [true, true, ["f/claude"], true, true], "群主");
  const theirs = { ...g, members: [{ ...mine, quota: undefined, usedToday: undefined }, { ...wang, quota: 10, usedToday: 0 }] };
  assert.deepEqual(shown(page.settingsView(theirs, "wang")), [false, true, ["w/codex"], true, false], "not 群主");
  assert.deepEqual(shown(page.settingsView({ ...g, status: "stopped" }, "fang")), [true, true, ["f/claude"], true, true], "叫停 changes none of it");
  assert.deepEqual(shown(page.settingsView({ ...g, status: "dissolved" }, "fang")), [false, false, [], true, false], "dissolved");
  assert.deepEqual(page.settingsView(g, "fang").mine.map((m: any) => m.agent), ["f/claude"]);
});

test("leaving says what follows: who 群主 passes to, that the group ends, or that one AI stops being woken", () => {
  const claude = { agent: "f/claude", name: "我的 Claude", owner: "fang", quota: 30, usedToday: 0 };
  const codex = { agent: "f/codex", name: "我的 Codex", owner: "fang", quota: 30, usedToday: 0 };
  const wang = { agent: "w/codex", name: "老王的 Codex", owner: "wang" };
  const lin = { agent: "l/claude", name: "小林的 Claude", owner: "lin" };
  const g = { owner: "fang", status: "open", members: [claude, lin, codex, wang] };
  assert.equal(page.leaveNote(g, "fang", ["f/claude"]), "我的 Claude 退出后不会再被叫醒。");
  // 群主 passes to the person whose AI joined first (drop in src/relay/groups.ts).
  assert.equal(page.leaveNote(g, "fang", ["f/claude", "f/codex"]), "退出后群主交给小林，你也看不到这个群了。");
  assert.equal(page.leaveNote({ ...g, members: [claude, lin, wang] }, "fang", ["f/claude"]), "退出后群主交给小林，你也看不到这个群了。", "the last of the person's AIs leaving from its tile");
  assert.equal(page.leaveNote({ ...g, members: [claude, codex] }, "fang", ["f/claude", "f/codex"]), "群里只剩你的 AI，退出后群会解散。");
  assert.equal(page.leaveNote({ ...g, owner: "wang" }, "fang", ["f/claude", "f/codex"]), "退出后你的 AI 不会再被叫醒，你也看不到这个群了。");
  assert.equal(page.leaveNote({ ...g, status: "dissolved" }, "fang", ["f/claude", "f/codex"]), "退出后你就看不到这个群了。");
});

test("每天次数 as typed: a whole number from 1 to 500, in half- or full-width digits", () => {
  assert.equal(page.quotaOf(" 50 "), 50);
  assert.equal(page.quotaOf("１"), 1);
  assert.equal(page.quotaOf("５００"), 500);
  assert.equal(page.quotaOf("５0"), 50);
  for (const bad of ["0", "501", "０", "５０１", "2.5", "5.", "1e2", "0x10", "+5", "-1", "", " ", "三十"]) assert.equal(page.quotaOf(bad), null, bad);
});

test("每天次数 out of range says so in the relay's words, written once for 群设置 and the invite card", () => {
  for (const bad of ["0", "501", "三十", ""]) assert.equal(page.quotaProblem(bad), `每天次数需要在 1 到 ${GROUP_LIMITS.maxQuota} 之间`, bad);
  for (const good of ["1", " 30 ", "３０", "500"]) assert.equal(page.quotaProblem(good), null, good);
});

test("发起群聊: a friend, or some of their AIs, never both; what 完成 sends", () => {
  const wang = { person: "wang", name: "老王" };
  const wangCodex = { agent: "w/codex", owner: "wang", name: "老王的 Codex" };
  const mine = { agent: "f/claude", owner: "fang", name: "我的 Claude" };
  let picked = page.togglePick([], mine);
  picked = page.togglePick(picked, wangCodex);
  picked = page.togglePick(picked, wang);
  assert.deepEqual(picked.map((p: any) => p.name), ["我的 Claude", "老王"], "picking 老王 drops his AI picked alone");
  picked = page.togglePick(picked, wangCodex);
  assert.deepEqual(picked.map((p: any) => p.name), ["我的 Claude", "老王的 Codex"], "and the other way round");
  assert.deepEqual(page.targetsOf(page.togglePick(picked, wangCodex)), [{ agent: "f/claude" }]);
  assert.deepEqual(page.targetsOf([mine, wang]), [{ agent: "f/claude" }, { account: "wang" }]);
  // What is ticked: a person, or an AI, never taken for the other.
  assert.equal(page.isPicked([mine, wang], { person: "wang", name: "老王" }), true);
  assert.equal(page.isPicked([mine, wang], wangCodex), false);
  assert.equal(page.isPicked([{ agent: "wang", owner: "x", name: "叫 wang 的 AI" }], wang), false);
  // A new group needs one of the person's own AIs; an invite does not.
  assert.equal(page.pickProblem([wang], "fang", null), "群里至少要有你自己的一个 AI");
  assert.equal(page.pickProblem([mine, wang], "fang", null), null);
  assert.equal(page.pickProblem([wang], "fang", { id: "g_1" }), null);
});

test("a new group starts only with words to discuss or a file: @所有人 alone is not enough", () => {
  assert.equal(page.openingProblem("@所有人", 0), "写一句要讨论的事");
  assert.equal(page.openingProblem(" @所有人 @所有人 \n", 0), "写一句要讨论的事");
  assert.equal(page.openingProblem("@所有人 周五发版", 0), null);
  assert.equal(page.openingProblem("@所有人", 1), null, "a file is something to discuss");
});

describe("who 发起群聊 and 邀请 list, and who can be ticked", () => {
  const me = "fang";
  const agents = [
    { id: "f/claude", name: "我的 Claude", client: "claude", owner: "fang" },
    { id: "f/codex", name: "我的 Codex", client: "codex", owner: "fang" },
    { id: "p_fang", name: "我", client: "person", owner: "fang", canReceive: false },
    // A friend's AI is in /api/agents too: it is never one of the person's own.
    { id: "w/codex", name: "老王的 Codex", client: "codex", owner: "wang" },
  ];
  const contacts = [
    { id: "wang", name: "老王", agents: [{ id: "w/codex", name: "老王的 Codex", client: "codex" }, { id: "w/claude", name: "老王的 Claude", client: "claude" }] },
    { id: "chuang", name: "王闯", agents: [{ id: "c/codex", name: "王闯的 Codex", client: "codex" }, { id: "c/claude", name: "王闯的 Claude", client: "claude" }] },
    { id: "lin", name: "小林", agents: [{ id: "l/claude", name: "小林的 Claude", client: "claude" }, { id: "l/doubao", name: "小林的豆包", client: "doubao", canReceive: false }] },
    { id: "xia", name: "小夏", agents: [{ id: "x/claude", name: "小夏的 Claude", client: "claude" }] },
    { id: "zhou", name: "老周", agents: [] },
  ];
  // Each row as [kind, name, 等加入, indented or the arrow].
  const shown = (rows: any[]) =>
    rows.map((r) => (r.kind === "head" ? ["head", r.text] : r.kind === "person" ? ["person", r.item.name, r.waiting, r.toggle] : ["ai", r.item.name, r.waiting, r.indent]));

  test("发起群聊: the person's own AIs, then each friend, opened by the arrow", () => {
    const rows = page.pickerRows({ me, agents, contacts, opened: new Set(["lin"]) });
    assert.deepEqual(shown(rows), [
      ["head", "我的 AI"],
      ["ai", "我的 Claude", false, false],
      ["ai", "我的 Codex", false, false],
      ["head", "朋友"],
      ["person", "老王", false, "closed"],
      ["person", "王闯", false, "closed"],
      ["person", "小林", false, "open"],
      ["ai", "小林的 Claude", false, true],
      ["ai", "小林的豆包", false, true],
      ["person", "小夏", false, "closed"],
      ["person", "老周", false, null],
    ]);
    const lin = rows.find((r: any) => r.item?.agent === "l/doubao");
    assert.deepEqual(lin.item, { agent: "l/doubao", owner: "lin", name: "小林的豆包", client: "doubao", speaksOnly: true });
    assert.deepEqual(rows.find((r: any) => r.item?.person === "lin").item, { person: "lin", name: "小林" });
  });

  test("searching shows the friends and AIs that fit, opened, with no arrow to close", () => {
    assert.deepEqual(shown(page.pickerRows({ me, agents, contacts, query: "王" })), [
      ["head", "朋友"],
      ["person", "老王", false, null],
      ["ai", "老王的 Codex", false, true],
      ["ai", "老王的 Claude", false, true],
      ["person", "王闯", false, null],
      ["ai", "王闯的 Codex", false, true],
      ["ai", "王闯的 Claude", false, true],
    ]);
    assert.deepEqual(shown(page.pickerRows({ me, agents, contacts, query: "codex" })), [
      ["head", "我的 AI"],
      ["ai", "我的 Codex", false, false],
      ["head", "朋友"],
      ["person", "老王", false, null],
      ["ai", "老王的 Codex", false, true],
      ["person", "王闯", false, null],
      ["ai", "王闯的 Codex", false, true],
    ]);
    assert.deepEqual(shown(page.pickerRows({ me, agents, contacts, query: "老周" })), [
      ["head", "朋友"],
      ["person", "老周", false, null],
    ]);
    assert.deepEqual(page.pickerRows({ me, agents, contacts, query: "没有这个人" }), []);
  });

  test("邀请: who is in is left out, a friend already in is offered only their AIs still out, and who is invited shows 等加入", () => {
    const group = {
      id: "g_1",
      members: [
        { agent: "f/claude", owner: "fang" },
        { agent: "w/codex", owner: "wang" },
        { agent: "x/claude", owner: "xia" },
        { agent: "l/claude", owner: "lin" },
      ],
      invites: [
        // 王闯 is invited and not yet in: an invite for one AI of his by name.
        { id: "gi_1", account: "chuang", name: "王闯", agent: "c/claude", agentName: "王闯的 Claude" },
        // 小林 is in, and her 豆包 is asked for by name.
        { id: "gi_2", account: "lin", name: "小林", agent: "l/doubao", agentName: "小林的豆包" },
      ],
    };
    const rows = page.pickerRows({ me, agents, contacts, group, opened: new Set(["chuang"]) });
    assert.deepEqual(shown(rows), [
      ["head", "我的 AI"],
      ["ai", "我的 Codex", false, false],
      ["head", "朋友"],
      // 老王 is in: no row for him as a person, only his AI still out.
      ["ai", "老王的 Claude", false, false],
      // 王闯 waits on his invite: himself and each of his AIs.
      ["person", "王闯", true, "open"],
      ["ai", "王闯的 Codex", true, true],
      ["ai", "王闯的 Claude", true, true],
      // 小林 is in; her 豆包 waits on its invite.
      ["ai", "小林的豆包", true, false],
      // 小夏's one AI is in: nothing of hers is left. 老周 has no AI yet.
      ["person", "老周", false, null],
    ]);
    // Someone in the group asked for the person's own Codex by name: answered on its tile.
    const mineAsked = { ...group, invites: [{ id: "gi_4", account: "fang", name: "我", agent: "f/codex", agentName: "我的 Codex" }] };
    assert.deepEqual(shown(page.pickerRows({ me, agents, contacts, group: mineAsked, query: "我的" })), [
      ["head", "我的 AI"],
      ["ai", "我的 Codex", true, false],
    ]);
    // A person invited to pick: the same, whichever AI.
    const asked = { ...group, invites: [{ id: "gi_3", account: "chuang", name: "王闯", agent: null, agentName: null }] };
    assert.deepEqual(shown(page.pickerRows({ me, agents, contacts, group: asked, query: "王闯" })), [
      ["head", "朋友"],
      ["person", "王闯", true, null],
      ["ai", "王闯的 Codex", true, true],
      ["ai", "王闯的 Claude", true, true],
    ]);
  });
});

test("the invite card offers the person's own AIs, those that can answer ticked; only those asked for by name, on one card", () => {
  const agents = [
    { id: "w/codex", name: "我的 Codex", client: "codex", owner: "wang" },
    { id: "w/claude", name: "我的 Claude", client: "claude", owner: "wang" },
    { id: "r_w", name: "我的豆包", client: "doubao", canReceive: false, owner: "wang" },
    { id: "p_wang", name: "我", client: "person", canReceive: false, owner: "wang" },
    // A friend's AI, in /api/agents too, is never offered.
    { id: "c/codex", name: "王闯的 Codex", client: "codex", owner: "chuang" },
  ];
  assert.deepEqual(page.inviteChoices([{ agent: null }], agents, "wang").map((c: any) => [c.name, c.checked, c.locked, c.speaksOnly]), [
    ["我的 Codex", true, false, false],
    ["我的 Claude", true, false, false],
    ["我的豆包", false, false, true],
  ]);
  assert.deepEqual(page.inviteChoices([{ agent: "w/claude" }], agents, "wang").map((c: any) => [c.name, c.checked, c.locked]), [["我的 Claude", true, true]]);
  assert.deepEqual(
    page.inviteChoices([{ agent: "w/claude" }, { agent: "r_w" }, { agent: "gone" }], agents, "wang").map((c: any) => [c.name, c.checked, c.locked]),
    [
      ["我的 Claude", true, true],
      ["我的豆包", true, true],
    ],
    "two asked for by name: one card, both ticked and fixed",
  );
  assert.deepEqual(page.inviteChoices([{ agent: "gone" }], agents, "wang"), []);
  assert.deepEqual(page.inviteChoices([{ agent: "c/codex" }], agents, "wang"), [], "named for someone else's AI");
});

test("the invite card says which computer an AI is on, unless its name says it already", () => {
  const agents = [
    { id: "m/claude", name: "我的 Claude（MacBook）", client: "claude", owner: "fang" },
    { id: "i/claude", name: "我的 Claude（iMac）", client: "claude", owner: "fang" },
    { id: "m/codex", name: "我的 Codex", client: "codex", owner: "fang" },
    { id: "r_f", name: "我的豆包", client: "doubao", canReceive: false, owner: "fang" },
  ];
  const devices = [
    { id: "m", name: "MacBook", agents: [{ id: "m/claude" }, { id: "m/codex" }] },
    { id: "i", name: "iMac", agents: [{ id: "i/claude" }] },
  ];
  assert.deepEqual(page.inviteChoices([{ agent: null }], agents, "fang", devices).map((c: any) => [c.name, c.note]), [
    ["我的 Claude（MacBook）", null],
    ["我的 Claude（iMac）", null],
    ["我的 Codex", "MacBook"],
    ["我的豆包", "只能发言"],
  ]);
  assert.equal(page.inviteChoices([{ agent: null }], agents, "fang")[2].note, null, "no computers known");
});

test("an invite card with nothing to bring in says why, in a few words", () => {
  const none = page.inviteChoices([{ agent: null }], [], "fang");
  assert.deepEqual(page.inviteEmpty([{ agent: null, agentName: null }], none), { text: "先连接 AI", connect: true });
  assert.deepEqual(page.inviteEmpty([{ agent: "f/claude", agentName: "我的 Claude" }], none), { text: "我的 Claude 已移除", connect: false });
  assert.deepEqual(page.inviteEmpty([{ agent: "f/claude", agentName: "我的 Claude" }, { agent: "r_f", agentName: "我的豆包" }], none), {
    text: "我的 Claude、我的豆包已移除",
    connect: false,
  });
  const one = page.inviteChoices([{ agent: null }], [{ id: "f/claude", name: "我的 Claude", client: "claude", owner: "fang" }], "fang");
  assert.equal(page.inviteEmpty([{ agent: null, agentName: null }], one), null);
});
