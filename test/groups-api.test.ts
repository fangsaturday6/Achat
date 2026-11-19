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

  // What a browser's event stream says about groups, until stopped.
  async function watch(browser: Browser, agent?: string): Promise<{ events: GroupEvent[]; raw: string[]; stop: () => void; ready: Promise<void> }> {
    const events: GroupEvent[] = [];
    const raw: string[] = [];
    const controller = new AbortController();
    const res = await fetch(`${cloud.url}/api/events${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`, { headers: { cookie: browser.cookie }, signal: controller.signal });
    assert.equal(res.status, 200);
    void (async () => {
      let buffer = "";
      try {
        for await (const chunk of res.body!) {
          buffer += new TextDecoder().decode(chunk as Uint8Array, { stream: true });
          let i: number;
          while ((i = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
            if (data) {
              raw.push(data);
              const e = JSON.parse(data);
              if ("groupId" in e) events.push(e);
            }
          }
        }
      } catch {
        // stopped
      }
    })();
    return { events, raw, stop: () => controller.abort(), ready: Promise.resolve() };
  }

  async function download(browser: Browser, fileId: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${cloud.url}/api/files/${fileId}`, { headers: { cookie: browser.cookie } });
    return { status: res.status, text: await res.text() };
  }

  const quiet = () => new Promise((r) => setTimeout(r, 250));
  const attach = (text: string) => [{ name: "a.txt", data: Buffer.from(text).toString("base64") }];

  test("someone invited but not joined hears that the group changed, and sees nothing but the opening message", async () => {
    const claude = fangMac.agent("claude");
    const wangCodex = wangLaptop.agent("codex");
    const onWeb = await watch(wang);
    const seen: GroupEvent[] = [];
    const off = wangLaptop.client.subscribe(undefined, () => {}, undefined, { onGroup: (e) => seen.push(e) });
    try {
      const g = await fangMac.client.createGroup({ from: claude, name: "只是被邀请", members: [{ account: wangId }], message: "开场白：下周对接" });
      const posted = await fangMac.client.postGroupMessage(g.id, { from: claude, body: "内部消息：密钥在这里", files: attach("机密文件") });
      const file = posted.messages.at(-1)!.files[0];

      await until(async () => onWeb.events.some((e) => e.groupId === g.id && e.type === "group.message"));
      await until(async () => seen.some((e) => e.groupId === g.id && e.type === "group.message"));
      for (const e of [...onWeb.events, ...seen].filter((e) => e.groupId === g.id)) {
        assert.ok(Object.keys(e).every((k) => ["type", "groupId", "members", "seq", "wake"].includes(k)), `no text on an event: ${JSON.stringify(e)}`);
      }
      assert.ok(!onWeb.raw.some((r) => r.includes("密钥") || r.includes("开场白")));

      const detail = await wang.call("GET", `/api/groups/${g.id}`);
      assert.equal(detail.role, "invited");
      assert.deepEqual(detail.messages.map((m: any) => m.body), ["开场白：下周对接"]);
      assert.ok(detail.myInvite);
      assert.deepEqual((await download(wang, file.id)).status, 404);
      await assert.rejects(wangLaptop.client.file(file.id), /找不到这个文件/);
      await assert.rejects(wang.call("POST", `/api/groups/${g.id}/messages`, { from: `p_${wangId}`, body: "我插一句" }), /找不到这个群/);
      await assert.rejects(wangLaptop.client.postGroupMessage(g.id, { from: wangCodex, body: "我的 AI 插一句" }), /找不到这个群/);
      assert.equal((await fang.call("GET", `/api/groups/${g.id}`)).messages.length, 2, "the opening message and the one posted, nothing else got in");
    } finally {
      onWeb.stop();
      off();
    }
  });

  test("an event stream asking for one AI hears only the groups that AI is in", async () => {
    const claude = fangMac.agent("claude");
    const codex = fangMac.agent("codex");
    const forClaude: GroupEvent[] = [];
    const forCodex: GroupEvent[] = [];
    const all: GroupEvent[] = [];
    const offClaude = fangMac.client.subscribe(claude, () => {}, undefined, { onGroup: (e) => forClaude.push(e) });
    const offCodex = fangMac.client.subscribe(codex, () => {}, undefined, { onGroup: (e) => forCodex.push(e) });
    const offAll = fangMac.client.subscribe(undefined, () => {}, undefined, { onGroup: (e) => all.push(e) });
    try {
      await quiet();
      const g = await fangMac.client.createGroup({ from: claude, name: "只有 Claude", members: [] });
      await fangMac.client.postGroupMessage(g.id, { from: claude, body: "只有我在" });
      await until(async () => all.filter((e) => e.groupId === g.id).length >= 2);
      await quiet();
      assert.ok(forClaude.filter((e) => e.groupId === g.id).length >= 2);
      assert.deepEqual(forCodex.filter((e) => e.groupId === g.id), [], "its Codex is not in the group");

      await fangMac.client.inviteToGroup(g.id, { from: claude, members: [{ agent: codex }] });
      await until(async () => forCodex.some((e) => e.groupId === g.id && e.members.includes(codex)));
    } finally {
      offClaude();
      offCodex();
      offAll();
    }
  });

  test("a member's person reads the group's files on the web until their AIs leave; after that, nothing of it reaches them", async () => {
    const claude = fangMac.agent("claude");
    const codex = fangMac.agent("codex");
    const wangCodex = wangLaptop.agent("codex");
    const g0 = await fangMac.client.createGroup({ from: claude, name: "来了又走", members: [{ agent: codex }, { account: wangId }] });
    const [mine] = (await wang.call("GET", "/api/groups")).filter((s: any) => s.id === g0.id);
    await wang.call("POST", `/api/groups/${g0.id}/invites/${mine.myInvite.id}/accept`, { agents: [wangCodex] });
    const posted = await fangMac.client.postGroupMessage(g0.id, { from: claude, body: "给大家", files: attach("群里的文件") });
    const file = posted.messages.at(-1)!.files[0];

    const onWeb = await watch(fang);
    try {
      assert.deepEqual(await download(fang, file.id), { status: 200, text: "群里的文件" });
      await wangLaptop.client.postGroupMessage(g0.id, { from: wangCodex, body: "收到" });
      await until(async () => onWeb.events.some((e) => e.groupId === g0.id && e.type === "group.message"));

      await fang.call("POST", `/api/groups/${g0.id}/leave`, { agent: claude });
      assert.equal((await download(fang, file.id)).status, 200, "one AI still in");
      await fang.call("POST", `/api/groups/${g0.id}/leave`, { agent: codex });
      assert.equal((await download(fang, file.id)).status, 404);
      await assert.rejects(fang.call("GET", `/api/groups/${g0.id}`), /找不到这个群/);
      assert.ok(!(await fang.call("GET", "/api/groups")).some((s: any) => s.id === g0.id));

      // The last "left" event may still arrive (it says the audience changed); what is said afterwards does not.
      await quiet();
      const before = onWeb.events.length;
      await wangLaptop.client.postGroupMessage(g0.id, { from: wangCodex, body: "你们走了" });
      await wangLaptop.client.postGroupMessage(g0.id, { from: wangCodex, body: "真的走了" });
      await quiet();
      assert.equal(onWeb.events.length, before, JSON.stringify(onWeb.events.slice(before)));
      assert.equal(onWeb.events.at(-1)!.type, "group.updated");
    } finally {
      onWeb.stop();
    }
  });

  test("a credential pasted into another app cannot do what only a person does in a group; it speaks and sets the times for its own AI", async () => {
    const offer = await fang.call("POST", "/api/connect", { client: "doubao" });
    const doubao: string = offer.id;
    const claude = fangMac.agent("claude");
    const codex = fangMac.agent("codex");
    const pasted = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(cloud.url + path, {
        method,
        headers: { authorization: `Bearer ${offer.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const g = await fangMac.client.createGroup({ from: claude, name: "豆包也在", members: [{ agent: doubao }, { agent: codex }] });
    const fangId = (await fang.call("GET", "/api/me")).account.id;
    const other = await wangLaptop.client.createGroup({ from: wangLaptop.agent("codex"), name: "老王拉老方", members: [{ account: fangId }] });
    const invite = (await fang.call("GET", "/api/groups")).find((s: any) => s.id === other.id).myInvite;

    assert.equal((await pasted("POST", `/api/groups/${other.id}/invites/${invite.id}/accept`, { agents: [doubao] })).status, 403);
    assert.equal((await pasted("POST", `/api/groups/${g.id}/remove`, { agent: codex })).status, 403);
    assert.equal((await pasted("POST", `/api/groups/${g.id}/dissolve`, {})).status, 403);
    assert.equal((await pasted("POST", `/api/groups/${g.id}/rename`, { name: "改名" })).status, 403);
    assert.equal((await pasted("POST", `/api/groups/${g.id}/read`, {})).status, 403);
    assert.equal((await pasted("POST", `/api/groups/${g.id}/quota`, { agent: codex, perDay: 99 })).status, 403, "not its own AI");
    const mine = await pasted("POST", `/api/groups/${g.id}/quota`, { agent: doubao, perDay: 12 });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.members.find((m: any) => m.agent === doubao).quota, 12);
    const spoke = await pasted("POST", `/api/groups/${g.id}/messages`, { from: doubao, body: "我是豆包，路过" });
    assert.equal(spoke.status, 201);
    assert.equal(spoke.body.messages.at(-1).body, "我是豆包，路过");

    const after = await fang.call("GET", `/api/groups/${g.id}`);
    assert.equal(after.name, "豆包也在");
    assert.equal(after.status, "open");
    assert.ok(after.members.some((m: any) => m.agent === codex));
    assert.equal((await fang.call("GET", `/api/groups/${other.id}`)).role, "invited", "the invite is still open");
  });
  test("消息 gets each group's 四宫格 and who said the latest words; someone invited opens the opening message's files, and no others", async () => {
    const claude = fangMac.agent("claude");
    const codex = fangMac.agent("codex");
    const wangCodex = wangLaptop.agent("codex");
    const file = (name: string, text: string) => ({ name, type: "text/plain", data: Buffer.from(text).toString("base64") });
    const g = await fangMac.client.createGroup({ from: claude, name: "附件群", members: [{ agent: codex }, { account: wangId }], message: "@所有人 看看清单", files: [file("清单.txt", "一二三")] });
    const later = await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "还有一份", files: [file("另一份.txt", "四五六")] });

    const mine = (await fang.call("GET", "/api/groups")).find((x: any) => x.id === g.id);
    assert.deepEqual([mine.faces, mine.lastSender], [["我的 Claude", "我的 Codex"], "我"]);
    const invited = (await wang.call("GET", "/api/groups")).find((x: any) => x.id === g.id);
    assert.deepEqual([invited.role, invited.faces, invited.lastSender], ["invited", ["老方的 Claude", "老方的 Codex"], null]);

    const download = async (who: Browser, id: string) => (await fetch(`${cloud.url}/api/files/${id}`, { headers: { cookie: who.cookie } })).status;
    const opener = (await wang.call("GET", `/api/groups/${g.id}`)).messages[0].files[0].id;
    const other = later.messages.at(-1).files[0].id;
    assert.equal(await download(wang, opener), 200);
    assert.equal(await download(wang, other), 404, "only the opening message's files, for someone invited");

    await wang.call("POST", `/api/groups/${g.id}/invites/${invited.myInvite.id}/accept`, { agents: [wangCodex] });
    assert.equal(await download(wang, other), 200);
    // One face per person first, in the order they joined.
    const joined = (await wang.call("GET", "/api/groups")).find((x: any) => x.id === g.id);
    assert.deepEqual(joined.faces, ["老方的 Claude", "我的 Codex", "老方的 Codex"]);
  });

  test("an AI near its 每天次数 is told to its own person's streams alone, and 加一份 is theirs to add", async () => {
    const claude = fangMac.agent("claude");
    const codex = fangMac.agent("codex");
    const wangCodex = wangLaptop.agent("codex");
    const g = await fangMac.client.createGroup({ from: claude, name: "快用完", members: [{ agent: codex }, { account: wangId }] });
    const invite = (await wang.call("GET", "/api/groups")).find((x: any) => x.id === g.id).myInvite;
    await wang.call("POST", `/api/groups/${g.id}/invites/${invite.id}/accept`, { agents: [wangCodex] });
    await fang.call("POST", `/api/groups/${g.id}/quota`, { agent: codex, perDay: 5 });
    const onFang = await watch(fang);
    const onWang = await watch(wang);
    let open!: () => void;
    const streaming = new Promise<void>((r) => (open = r));
    const off = fangMac.client.subscribe(undefined, () => {}, () => open());
    try {
      await streaming;
      await fangMac.client.beat();
      for (let i = 1; i <= 4; i++) await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: `@我的 Codex 第 ${i} 个`, mentions: [codex] });
      const low = await until(async () => onFang.events.find((e) => e.groupId === g.id && e.type === "group.quotaLow"));
      assert.deepEqual(low, { type: "group.quotaLow", groupId: g.id, members: [codex] });
      await quiet();
      assert.ok(!onWang.events.some((e) => e.type === "group.quotaLow"), "老王 hears nothing of it");

      await assert.rejects(wang.call("POST", `/api/groups/${g.id}/extra`, { agent: codex }), /只能改自己的 AI/);
      const added = await fangMac.client.addGroupExtra(g.id, codex);
      const mine = added.members.find((m) => m.agent === codex)!;
      assert.deepEqual([mine.quota, mine.extraToday, mine.usedToday], [5, 5, 4]);
    } finally {
      off();
      onFang.stop();
      onWang.stop();
    }
  });

  test("when the last AI leaves, the invite's opening files can no longer be opened", async () => {
    const claude = fangMac.agent("claude");
    const file = (name: string, text: string) => ({ name, type: "text/plain", data: Buffer.from(text).toString("base64") });
    const g = await fangMac.client.createGroup({ from: claude, name: "走光了", members: [{ account: wangId }], message: "@所有人 看看", files: [file("单.txt", "内容")] });
    const opener = (await wang.call("GET", `/api/groups/${g.id}`)).messages[0].files[0].id;
    assert.equal((await download(wang, opener)).status, 200);
    await fang.call("POST", `/api/groups/${g.id}/leave`, { agent: claude });
    assert.equal((await download(wang, opener)).status, 404);
    assert.equal((await wang.call("GET", "/api/groups")).some((x: any) => x.id === g.id), false);
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
