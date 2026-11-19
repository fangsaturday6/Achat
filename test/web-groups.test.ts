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
