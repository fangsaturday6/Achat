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
