import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Presence } from "../src/cloud/presence.js";
import type { RunningCloud } from "../src/cloud/server.js";
import type { GroupEvent } from "../src/types.js";
import { addComputer, type Browser, logIn, startTestCloud, startTestRelay, until, type MemoryMailer } from "./helpers.js";

test("a computer is online while its stream is open and it beat within 90 seconds", () => {
  let now = 0;
  const presence = new Presence(() => now);
  assert.equal(presence.online("d1"), false);
  const close = presence.connect("d1");
  assert.equal(presence.online("d1"), false, "an open stream that never beat: an old computer");
  presence.beat("d1");
  assert.equal(presence.online("d1"), true);
  now = 91_000;
  assert.equal(presence.online("d1"), false, "a half-open stream that stopped beating");
  presence.beat("d1");
  assert.equal(presence.online("d1"), true);
  close();
  assert.equal(presence.online("d1"), false);
});

async function befriend(a: Browser, b: Browser, bEmail: string): Promise<void> {
  await a.call("POST", "/api/invites", { email: bEmail });
  const request = (await b.call("GET", "/api/invites")).find((f: any) => f.direction === "in" && f.status === "pending");
  await b.call("POST", `/api/invites/${request.id}/accept`, {});
}

describe("群 over the API", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  let fang: Browser;
  let wang: Browser;
  let fangMac: Awaited<ReturnType<typeof addComputer>>;
  let wangLaptop: Awaited<ReturnType<typeof addComputer>>;
  let fangSeat: string;
  let wangId: string;

  before(async () => {
    ({ cloud, mailer } = await startTestCloud());
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    await befriend(fang, wang, "wang@example.com");
    fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
    wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
    fangSeat = `p_${(await fang.call("GET", "/api/me")).account.id}`;
    wangId = (await wang.call("GET", "/api/me")).account.id;
  });
  after(() => cloud.close());

  test("an AI makes a group, a person joins on the web, and an @ wakes an AI only while its computer is on", async () => {
    const claude = fangMac.agent("claude");
    const wangCodex = wangLaptop.agent("codex");
    const g = await fangMac.client.createGroup({ from: claude, name: "支付对接", members: [{ account: wangId }] });
    assert.equal(g.role, "member");

    const [invited] = await wang.call("GET", "/api/groups");
    assert.equal(invited.role, "invited");
    await wang.call("POST", `/api/groups/${g.id}/invites/${invited.myInvite.id}/accept`, { agents: [wangCodex] });

    let open!: () => void;
    const streaming = new Promise<void>((r) => (open = r));
    const off = wangLaptop.client.subscribe(undefined, () => {}, () => open());
    try {
      // A stream alone is an old computer: not online until it beats or asks for work.
      await streaming;
      assert.equal((await fang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === wangCodex)?.online, false);
      const early = await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "@老王的 Codex 在吗", mentions: [wangCodex] });
      assert.equal(early.messages.at(-1).receipts[0].state, "offline");
      await wangLaptop.client.groupWork([wangCodex]);
      await until(async () => (await fang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === wangCodex)?.online);
      const asked = await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "@老王的 Codex 回调好了吗", mentions: [wangCodex] });
      const seq = asked.messages.at(-1).seq;
      assert.deepEqual(asked.messages.at(-1).receipts, [{ agent: wangCodex, state: "reading", reason: null }]);
      assert.deepEqual(await wangLaptop.client.groupWork([wangCodex]), [{ groupId: g.id, agent: wangCodex, seq }]);
      assert.equal((await wangLaptop.client.groupWorkFor(g.id, wangCodex))!.wake.seq, seq);
    } finally {
      off();
    }
    await until(async () => !(await fang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === wangCodex).online);
    const missed = await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "@老王的 Codex 在吗", mentions: [wangCodex] });
    assert.equal(missed.messages.at(-1).receipts[0].state, "offline");

    // A beat does it too, the way the 30 second beat of a new computer does.
    let open2!: () => void;
    const streaming2 = new Promise<void>((r) => (open2 = r));
    const off2 = wangLaptop.client.subscribe(undefined, () => {}, () => open2());
    try {
      await streaming2;
      const online = async () => (await fang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === wangCodex).online;
      assert.equal(await online(), false);
      await wangLaptop.client.beat();
      assert.equal(await online(), true);
    } finally {
      off2();
    }
  });

  test("a group's files are for its members, and its events reach their computers only", async () => {
    const claude = fangMac.agent("claude");
    const seen: GroupEvent[] = [];
    let connected!: () => void;
    const ready = new Promise<void>((r) => (connected = r));
    const off = fangMac.client.subscribe(undefined, () => {}, () => connected(), { onGroup: (e) => seen.push(e) });
    const strangers: GroupEvent[] = [];
    const offWang = wangLaptop.client.subscribe(undefined, () => {}, undefined, { onGroup: (e) => strangers.push(e) });
    try {
      await ready;
      const g = await fangMac.client.createGroup({ from: claude, name: "看图", members: [{ agent: fangMac.agent("codex") }] });
      const posted = await fangMac.client.postGroupMessage(g.id, { from: claude, body: "", files: [{ name: "a.txt", data: Buffer.from("hi").toString("base64") }] });
      const file = posted.messages.at(-1)!.files[0];
      assert.equal((await fangMac.client.file(file.id)).toString(), "hi");
      await assert.rejects(wangLaptop.client.file(file.id), /找不到这个文件/);
      await until(async () => seen.some((e) => e.groupId === g.id && e.type === "group.message"));
      assert.ok(!strangers.some((e) => e.groupId === g.id));
    } finally {
      off();
      offWang();
    }
  });
});

test("on this computer alone there are no groups", async () => {
  const { relay, client } = await startTestRelay();
  try {
    await assert.rejects(client.groups(), /登录 Achat 账号后才能用群/);
  } finally {
    await relay.close();
  }
});
