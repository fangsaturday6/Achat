import assert from "node:assert/strict";
import { test } from "node:test";
import { GroupStore } from "../src/relay/group-store.js";
import { Store } from "../src/relay/store.js";

test("a group keeps its members, messages with receipts and files, invites and daily counts", () => {
  const groups = new GroupStore(new Store(":memory:"));
  const now = "2026-11-18T02:00:00.000Z";
  groups.createGroup({ id: "g_1", name: "支付对接", owner: "fang" }, now);
  groups.addMember({ groupId: "g_1", agent: "a", owner: "fang", quota: 30, joinedSeq: 0 }, now);
  groups.addMember({ groupId: "g_1", agent: "b", owner: "wang", quota: 10, joinedSeq: 0 }, now);

  const m = groups.addMessage("g_1", { sender: "a", kind: "message", body: "@所有人 说说", mentions: ["all"], files: [{ name: "a.png", type: "image/png", data: new Uint8Array([1]) }] }, now);
  assert.equal(m.seq, 1);
  assert.deepEqual(m.mentions, ["all"]);
  assert.deepEqual(m.files.map((f) => f.name), ["a.png"]);

  groups.setReceipt("g_1", 1, "b", "reading", null, 0, now);
  groups.setReceipt("g_1", 1, "b", "passed", "不归我", 0, now);
  assert.deepEqual(groups.messages("g_1")[0].receipts, [{ agent: "b", state: "passed", reason: "不归我" }]);
  assert.equal(groups.doneSeq("g_1", "b"), 1);
  assert.deepEqual(groups.receiptsOf("g_1", "b", ["passed"]).map((r) => r.seq), [1]);

  groups.use("g_1", "b", "2026-11-18");
  groups.use("g_1", "b", "2026-11-18");
  assert.equal(groups.used("g_1", "b", "2026-11-18"), 2);
  assert.equal(groups.used("g_1", "b", "2026-11-19"), 0);

  groups.addInvite({ id: "gi_1", groupId: "g_1", account: "lin", agent: null, invitedBy: "a", expiresAt: "2026-11-25T02:00:00.000Z" }, now);
  assert.equal(groups.invitesFor("lin", now).length, 1);
  assert.equal(groups.invitesFor("lin", "2026-11-26T00:00:00.000Z").length, 0);

  groups.leaveMember("g_1", "b", now);
  assert.deepEqual(groups.members("g_1").map((x) => x.agent), ["a"]);
  groups.addMember({ groupId: "g_1", agent: "b", owner: "wang", quota: 5, joinedSeq: 1 }, now);
  assert.equal(groups.member("g_1", "b")!.leftAt, null);
  assert.equal(groups.member("g_1", "b")!.quota, 5);
  assert.deepEqual(groups.groupsWith(["b"]).map((g) => g.id), ["g_1"]);
  assert.deepEqual(groups.messages("g_1", 0, 1).map((x) => x.seq), [1]);

  groups.setRead("g_1", "b", 1, "s1");
  assert.deepEqual([groups.member("g_1", "b")!.readSeq, groups.member("g_1", "b")!.session], [1, "s1"]);
});

test("a database from before 加一份 keeps each day's count, with nothing added or told", () => {
  const store = new Store(":memory:");
  store.db.exec(`
    CREATE TABLE group_usage (group_id TEXT NOT NULL, agent TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, agent, day));
    INSERT INTO group_usage VALUES ('g_1', 'b', '2026-11-18', 3);
  `);
  const groups = new GroupStore(store);
  assert.deepEqual([groups.used("g_1", "b", "2026-11-18"), groups.extra("g_1", "b", "2026-11-18")], [3, 0]);
  groups.addExtra("g_1", "b", "2026-11-18", 30);
  groups.addExtra("g_1", "b", "2026-11-18", 30);
  groups.addExtra("g_1", "b", "2026-11-19", 5);
  assert.deepEqual([groups.extra("g_1", "b", "2026-11-18"), groups.extra("g_1", "b", "2026-11-19"), groups.used("g_1", "b", "2026-11-19")], [60, 5, 0]);
  assert.deepEqual([groups.warn("g_1", "b", "2026-11-18"), groups.warn("g_1", "b", "2026-11-18"), groups.warn("g_1", "b", "2026-11-20")], [true, false, true]);
  new GroupStore(store); // opening again changes nothing
  assert.equal(groups.extra("g_1", "b", "2026-11-18"), 60);
});

test("how far an AI's front session looked only goes forward, and starts over from where it joins", () => {
  const store = new Store(":memory:");
  store.db.exec(`
    CREATE TABLE group_members (group_id TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT NOT NULL, quota INTEGER NOT NULL, joined_seq INTEGER NOT NULL,
      read_seq INTEGER NOT NULL DEFAULT 0, session TEXT, joined_at TEXT NOT NULL, left_at TEXT, PRIMARY KEY (group_id, agent));
  `);
  const groups = new GroupStore(store);
  const now = "2026-11-18T02:00:00.000Z";
  groups.createGroup({ id: "g_1", name: "前台", owner: "fang" }, now);
  groups.addMember({ groupId: "g_1", agent: "a", owner: "fang", quota: 30, joinedSeq: 0 }, now);
  assert.equal(groups.member("g_1", "a")!.seenSeq, 0);
  groups.markSeen("g_1", "a", 3);
  groups.markSeen("g_1", "a", 2);
  assert.equal(groups.member("g_1", "a")!.seenSeq, 3);
  groups.leaveMember("g_1", "a", now);
  groups.addMember({ groupId: "g_1", agent: "a", owner: "fang", quota: 30, joinedSeq: 7 }, now);
  assert.equal(groups.member("g_1", "a")!.seenSeq, 7, "what was answered while it was out is not news");
});

test("a database from before 前台提醒 has each AI's front session start at its group's latest message, so answers from before are no news", () => {
  const store = new Store(":memory:");
  const before = new GroupStore(store);
  const now = "2026-11-18T02:00:00.000Z";
  before.createGroup({ id: "g_1", name: "前台", owner: "fang" }, now);
  before.createGroup({ id: "g_2", name: "还没说话", owner: "fang" }, now);
  for (const groupId of ["g_1", "g_2"]) {
    for (const agent of ["a", "b"]) before.addMember({ groupId, agent, owner: "fang", quota: 30, joinedSeq: 0 }, now);
  }
  const asked = before.addMessage("g_1", { sender: "a", kind: "message", body: "@b 好了吗", mentions: ["b"] }, now);
  before.addMessage("g_1", { sender: "b", kind: "message", body: "好了", replyTo: asked.seq }, now);
  store.db.exec("ALTER TABLE group_members DROP COLUMN seen_seq");

  const groups = new GroupStore(store);
  assert.deepEqual([groups.member("g_1", "a")!.seenSeq, groups.member("g_1", "b")!.seenSeq, groups.member("g_2", "a")!.seenSeq], [2, 2, 0]);
  assert.deepEqual(groups.unseenReplies("a"), []);
  // Answers after that are news, also once it is opened again.
  const again = groups.addMessage("g_1", { sender: "a", kind: "message", body: "@b 还有呢", mentions: ["b"] }, now);
  const answer = groups.addMessage("g_1", { sender: "b", kind: "message", body: "没了", replyTo: again.seq }, now);
  new GroupStore(store);
  assert.deepEqual(groups.unseenReplies("a"), [{ groupId: "g_1", seq: answer.seq }]);
});
