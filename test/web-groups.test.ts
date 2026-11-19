import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { GROUP_LIMITS } from "../src/relay/groups.js";
import type { RunningRelay } from "../src/relay/server.js";
import { ALL, GROUP_STATUS_LABELS, RECEIPT_LABELS } from "../src/types.js";
import * as page from "../web/groups.js";
import { startTestRelay } from "./helpers.js";

const WEB = join(import.meta.dirname, "..", "web");

describe("the page's modules", () => {
  let relay: RunningRelay;
  before(async () => ({ relay } = await startTestRelay()));
  after(() => relay.close());

  test("every script parses, and what app.js imports is served as JavaScript", async () => {
    for (const file of ["app.js", "text.js", "groups.js"]) execFileSync(process.execPath, ["--check", join(WEB, file)]);
    // An import may run over several lines.
    const imports = [...readFileSync(join(WEB, "app.js"), "utf8").matchAll(/^import [\s\S]*? from "\.\/(.+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["groups.js", "text.js"]);
    for (const file of imports) {
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
  { agent: "f/claude", name: "我的 Claude", canReceive: true, online: true, quota: 30, usedToday: 12 },
  { agent: "w/codex", name: "老王的 Codex", canReceive: true, online: true },
  { agent: "w/claude", name: "老王的 Claude", canReceive: true, online: true },
  { agent: "l/claude", name: "小林的 Claude", canReceive: true, online: false },
  { agent: "l/doubao", name: "小林的豆包", canReceive: false, online: false },
  { agent: "c/codex", name: "王闯的 Codex", canReceive: true, online: true },
];

test("the list under @: 所有人, the AIs that are on (the person's own after), those off, and grayed out last those that cannot answer", () => {
  assert.deepEqual(page.pickerOptions(MEMBERS).map((o: any) => [o.name, o.note, o.disabled]), [
    ["所有人", null, false],
    ["老王的 Codex", null, false],
    ["老王的 Claude", null, false],
    ["王闯的 Codex", null, false],
    ["我的 Claude", null, false],
    ["小林的 Claude", "不在线", false],
    ["小林的豆包", "还不能接收", true],
  ]);
  assert.deepEqual(page.pickerOptions(MEMBERS, "老王").map((o: any) => o.name), ["老王的 Codex", "老王的 Claude"]);
  assert.deepEqual(page.pickerOptions(MEMBERS, "all").map((o: any) => o.id), [ALL]);
  assert.deepEqual(page.pickerOptions(MEMBERS, "没有这个人"), []);
});

test("the @ being typed is found just before the caret", () => {
  assert.deepEqual(page.mentionAt("你好 @老王", 6), { start: 3, query: "老王" });
  assert.deepEqual(page.mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(page.mentionAt("没有", 2), null);
  assert.equal(page.mentionAt("第一行@\n第二", 6), null);
  assert.equal(page.mentionAt("@老王的 Codex ", 11), null, "a space after a name ends it");
});

test("what the person writes goes in with its @s, each AI named from nobody's side", () => {
  assert.deepEqual(page.composeMessage(" @我的 Claude 和 @老王的 Codex 看看，@所有人 也说说 ", MEMBERS, "老方"), {
    body: "@老方的 Claude 和 @老王的 Codex 看看，@所有人 也说说",
    mentions: [ALL, "f/claude", "w/codex"],
  });
  const twins = [...MEMBERS, { agent: "w2/codex", name: "老王的 Codex（iMac）", canReceive: true, online: true }];
  assert.deepEqual(page.composeMessage("@老王的 Codex（iMac） 你呢", twins, "老方").mentions, ["w2/codex"]);
  assert.deepEqual(page.composeMessage("没有点名", MEMBERS, "老方"), { body: "没有点名", mentions: [] });
});

test("the bottom names the person's AI nearest its 每天次数, red once used up; 叫停 shows while an AI reads", () => {
  assert.deepEqual(page.quotaLine(MEMBERS), { agent: "f/claude", text: "我的 Claude 今天 12 / 30 次", full: false });
  const two = [MEMBERS[0], { agent: "f/codex", name: "我的 Codex", canReceive: true, online: true, quota: 5, usedToday: 5 }];
  assert.deepEqual(page.quotaLine(two), { agent: "f/codex", text: "我的 Codex 今天 5 / 5 次", full: true });
  assert.equal(page.quotaLine(MEMBERS.slice(1)), null);
  const msg = (state: string) => ({ receipts: [{ agent: "c/codex", state, reason: null }] });
  assert.equal(page.isAnswering({ status: "open", messages: [msg("passed"), msg("reading")] }), true);
  assert.equal(page.isAnswering({ status: "open", messages: [msg("passed")] }), false);
  assert.equal(page.isAnswering({ status: "stopped", messages: [msg("reading")] }), false);
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
  const tiles = page.settingsTiles(g);
  assert.deepEqual(tiles.map((t: any) => [t.id, t.name, t.waiting, t.mine]), [
    ["f/claude", "我的 Claude", false, true],
    ["w/codex", "老王的 Codex", false, false],
    ["gi_1", "王闯的 Claude", true, false],
    ["gi_2", "小林", true, false],
  ]);
  assert.deepEqual(tiles.map((t: any) => page.tileActions(t, g, "fang")), [["leave"], ["remove"], [], []]);
  assert.deepEqual(page.tileActions(tiles[1], g, "wang"), [], "only 群主 removes another's AI");
  assert.deepEqual(page.tileActions(tiles[0], { ...g, status: "dissolved" }, "fang"), []);
});

test("每天次数 as typed: a whole number from 1 to 500", () => {
  assert.equal(page.quotaOf(" 50 "), 50);
  for (const bad of ["0", "501", "2.5", "", "三十"]) assert.equal(page.quotaOf(bad), null, bad);
});
