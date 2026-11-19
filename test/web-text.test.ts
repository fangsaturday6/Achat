import assert from "node:assert/strict";
import { test } from "node:test";
import * as text from "../web/text.js";

test("whose an AI or a seat is goes by its account, never its name: a friend may be called 我爱罗", () => {
  assert.equal(text.isOwn({ id: "f/claude", name: "我的 Claude", owner: "fang" }, "fang"), true);
  assert.equal(text.isOwn({ id: "p_fang", name: "我", client: "person", owner: "fang" }, "fang"), true, "the person's own seat");
  assert.equal(text.isOwn({ id: "x/claude", name: "我爱罗的 Claude", owner: "xia" }, "fang"), false);
  assert.equal(text.isOwn({ id: "p_xia", name: "我爱罗", client: "person", owner: "xia" }, "fang"), false, "and 我爱罗 himself");
  assert.equal(text.isOwn({ id: "t/codex", name: "我的天的 Codex", owner: "tian" }, "fang"), false, "nor 我的天's");
  assert.equal(text.isOwn({ id: "s/codex", name: "我", client: "person", owner: "wo" }, "fang"), false, "nor someone called 我");
  assert.equal(text.isOwn(undefined, "fang"), false, "one the page does not know");
  // On this computer there are no accounts: every AI listed is the person's.
  assert.equal(text.isOwn({ id: "claude@local", name: "我的 Claude", client: "claude" }, null), true);
  assert.equal(text.isOwn(undefined, null), false);
});

test("a face and 等…批准 name whom an AI or a seat belongs to: the person's own name for theirs, else the friend's", () => {
  const who = { me: "fang", myName: "老方", contacts: [{ id: "xia", name: "我爱罗" }, { id: "de", name: "小的" }] };
  assert.equal(text.ownerLabel({ name: "我的 Claude", owner: "fang" }, who), "老方");
  assert.equal(text.ownerLabel({ name: "我", client: "person", owner: "fang" }, who), "老方");
  assert.equal(text.ownerLabel({ name: "我爱罗的 Claude", owner: "xia" }, who), "我爱罗");
  assert.equal(text.ownerLabel({ name: "我爱罗", client: "person", owner: "xia" }, who), "我爱罗");
  // As 通讯录 names them, whatever their name holds.
  assert.equal(text.ownerLabel({ name: "小的的 Codex", owner: "de" }, who), "小的");
  // Not in 通讯录 (a friend's friend, met in a group): by the AI's name, or the seat's.
  assert.equal(text.ownerLabel({ name: "王闯的 Codex", owner: "chuang" }, who), "王闯");
  assert.equal(text.ownerLabel({ name: "大的", client: "person", owner: "da" }, who), "大的");
  assert.equal(text.ownerLabel(undefined, who), "", "one the page does not know");
  // On this computer.
  assert.equal(text.ownerLabel({ name: "我的 Codex", client: "codex" }, { me: null, myName: "我", contacts: [] }), "我");
});

test("each conversation keeps its own box: the same one across redraws, never another's, a new one once dropped", () => {
  const boxes = text.keeper();
  let made = 0;
  const make = () => ({ n: ++made, value: "" });
  const a = boxes.get("t:a", make);
  a.value = "打到一半";
  assert.equal(boxes.get("t:a", make), a, "redrawn: the same box, with what is half written");
  const b = boxes.get("t:b", make);
  assert.notEqual(b, a);
  assert.equal(b.value, "", "another conversation never shows what was written in this one");
  assert.equal(boxes.get("t:a", make).value, "打到一半", "back to it, the words are still there");
  boxes.drop("new:x");
  boxes.drop("t:a");
  assert.equal(boxes.get("t:a", make).value, "", "dropped once sent: the next one starts empty");
  assert.equal(made, 3);
});
