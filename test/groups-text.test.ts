import assert from "node:assert/strict";
import { test } from "node:test";
import { beijingDay, mentionsIn, nameFrom, passReason } from "../src/groups.js";
import { ALL } from "../src/types.js";

test("每天 starts at midnight in 北京时间", () => {
  assert.equal(beijingDay(new Date("2026-11-18T15:59:00Z")), "2026-11-18");
  assert.equal(beijingDay(new Date("2026-11-18T16:00:00Z")), "2026-11-19");
});

test("an answer that need not reply gives its half sentence of why", () => {
  assert.equal(passReason("无需回复：小林的 Claude 已经答了"), "小林的 Claude 已经答了");
  assert.equal(passReason("  无需回复:订单不归我\n多余的一行"), "订单不归我");
  assert.equal(passReason("无需回复"), "");
  assert.equal(passReason("在网关统一验签。无需回复的是别的"), null);
});

test("mentions are read from the words, longer names first, never the AI itself", () => {
  const members = [
    { agent: "w/codex", name: "老王的 Codex" },
    { agent: "w2/codex", name: "老王的 Codex（iMac）" },
    { agent: "f/claude", name: "我的 Claude" },
  ];
  assert.deepEqual(mentionsIn("@老王的 Codex（iMac） 你那边呢", members, "f/claude"), ["w2/codex"]);
  assert.deepEqual(mentionsIn("@所有人 @我的 Claude 说说", members, "f/claude"), [ALL]);
  assert.deepEqual(mentionsIn("这个价格要 @老方 定", members, "f/claude", { seat: "p_fang", name: "老方" }), ["p_fang"]);
  assert.deepEqual(mentionsIn("没有点名", members, "f/claude"), []);
});

test("a group is named from its opening message", () => {
  assert.equal(nameFrom("@所有人 下周接支付宝和微信支付，先说说现状"), "下周接支付宝和微信支付");
  assert.equal(nameFrom(""), "");
});
