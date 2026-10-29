import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RelayClient } from "../src/client.js";
import { AccountStore } from "../src/cloud/accounts.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { ensureDeviceKey, FileKeyStore } from "../src/device.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { addComputer, Browser, logIn, ScriptedRunner, startTestCloud, until, type MemoryMailer } from "./helpers.js";

// An MCP client like 豆包's or WorkBuddy's: the address plus a credential header.
async function remoteAi(cloud: RunningCloud, token: string): Promise<Client> {
  const client = new Client({ name: "doubao", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${cloud.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { text: string }[]).map((c) => c.text).join("\n");
}

describe("connecting AIs", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  let fang: Browser;
  let wang: Browser;
  let fangMac: Awaited<ReturnType<typeof addComputer>>;
  let wangLaptop: Awaited<ReturnType<typeof addComputer>>;

  before(async () => {
    ({ cloud, mailer } = await startTestCloud());
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    fangMac = await addComputer(cloud, fang, "MacBook Air", ["claude"]);
    wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
    const invite = await fangMac.client.createInvite();
    await wang.call("POST", `/api/invites/${invite.url.split("/").at(-1)}/accept`, {});
  });
  after(() => cloud.close());

  test("Claude Code and Codex get one sentence that adds the computer without a confirmation page", async () => {
    const offer = await fang.call("POST", "/api/connect", { client: "codex" });
    assert.equal(offer.kind, "install");
    const token = offer.command.match(/bash -s -- (ac_\S+)$/)[1];
    assert.equal(offer.command, `curl -fsSL https://achat.test/install.sh | bash -s -- ${token}`);
    assert.match(offer.sentence, /^帮我连上 Achat：运行 curl/);
    assert.equal((await fang.call("GET", `/api/connect/${offer.id}`)).status, "waiting");

    const key = ensureDeviceKey(new FileKeyStore(join(mkdtempSync(join(tmpdir(), "achat-key-")), "k")));
    const computer = new RelayClient(cloud.url, key);
    const ticket = await computer.createDeviceLink({ publicKey: key.publicKey, name: "iMac", clients: ["codex"], enroll: token });
    assert.equal(ticket.status, "approved");
    assert.equal(ticket.account, "老方");
    assert.equal((await computer.me()).account.name, "老方");
    assert.deepEqual(await fang.call("GET", `/api/connect/${offer.id}`), { status: "connected", device: "iMac", ais: ["Codex"] });

    const again = ensureDeviceKey(new FileKeyStore(join(mkdtempSync(join(tmpdir(), "achat-key-")), "k")));
    await assert.rejects(
      new RelayClient(cloud.url, again).createDeviceLink({ publicKey: again.publicKey, name: "x", clients: ["codex"], enroll: token }),
      /已经用过或过期/,
    );
    await fang.call("DELETE", `/api/devices/${key.deviceId}`);
  });

  test("豆包 connects by address: it can ask, cannot approve, and cannot be asked", async () => {
    const offer = await fang.call("POST", "/api/connect", { client: "doubao" });
    assert.equal(offer.kind, "mcp");
    assert.equal(offer.url, "https://achat.test/mcp");
    assert.equal(offer.name, "我的豆包");
    assert.equal(offer.header, `Authorization: Bearer ${offer.token}`);
    assert.equal((await fang.call("GET", `/api/connect/${offer.id}`)).status, "waiting");

    const runner = new ScriptedRunner(["分镜、出图、剪辑三步"]);
    const sidecar = new Sidecar({
      client: fangMac.client,
      agents: [],
      runners: { [fangMac.agent("claude")]: runner },
      notify: () => {},
      webUrl: cloud.url,
      log: () => {},
    });
    sidecar.start();
    const doubao = await remoteAi(cloud, offer.token);
    try {
      const tools = (await doubao.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, ["check_thread", "close_thread", "create_invite", "list_contacts", "send_message", "send_request"]);
      const contacts = await call(doubao, "list_contacts");
      assert.match(contacts, /我的 Claude/);
      assert.match(contacts, /老王的 Codex/);
      assert.equal((await fang.call("GET", `/api/connect/${offer.id}`)).status, "connected");

      // Its own Claude answers without approval.
      const reply = await call(doubao, "send_request", { to: "我的 Claude", topic: "视频", message: "怎么做的？" });
      assert.match(reply, /分镜、出图、剪辑三步/);
    } finally {
      sidecar.stop();
      await doubao.close();
    }

    // Nobody can send it requests, not even 老方's other AIs.
    const doubaoId = offer.id as string;
    await assert.rejects(
      wangLaptop.client.createRequest({ from: wangLaptop.agent("codex"), to: doubaoId, topic: "x", message: "y" }),
      /老方的豆包还不能接收请求/,
    );
    const fromWang = (await wangLaptop.client.agents()).find((a) => a.id === doubaoId);
    assert.equal(fromWang?.canReceive, false);

    // Its credential cannot approve requests to its owner's other AIs.
    const pending = await wangLaptop.client.createRequest({
      from: wangLaptop.agent("codex"),
      to: fangMac.agent("claude"),
      topic: "要批准的",
      message: "问题",
    });
    await assert.rejects(new RelayClient(cloud.url, { bearer: offer.token }).approve(pending.id), /接收方的主人/);
    await fang.call("POST", `/api/threads/${pending.id}/decline`, {});

    // Connecting it again replaces the credential; removing it ends it.
    const second = await fang.call("POST", "/api/connect", { client: "doubao" });
    assert.equal(second.id, offer.id);
    await assert.rejects(new RelayClient(cloud.url, { bearer: offer.token }).me(), /凭证无效或已作废/);
    assert.equal((await new RelayClient(cloud.url, { bearer: second.token }).me()).account.name, "老方");
    await fang.call("DELETE", `/api/agents/${second.id}`);
    await assert.rejects(new RelayClient(cloud.url, { bearer: second.token }).me(), /凭证无效或已作废/);
    const res = await fetch(`${cloud.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${second.token}` } });
    assert.equal(res.status, 401);
  });

  test("someone else's request is emailed to the receiver, three times a day per sender at most", async () => {
    const before = mailer.sent.length;
    const ask = (topic: string) =>
      wangLaptop.client.createRequest({ from: wangLaptop.agent("codex"), to: fangMac.agent("claude"), topic, message: "上次的视频是怎么做的？" });
    const first = await ask("视频制作流程");
    const mail = await until(async () => mailer.sent.slice(before).find((m) => m.to === "fang@example.com"));
    assert.equal(mail.subject, "老王的 Codex 想问你的 Claude：视频制作流程");
    assert.match(mail.text, /上次的视频是怎么做的？/);
    assert.ok(mail.html!.includes(`https://achat.test/#/t/${first.id}`));

    for (const topic of ["第二个", "第三个"]) await ask(topic);
    await new Promise((r) => setTimeout(r, 100));
    const fromWang = mailer.sent.filter((m) => m.to === "fang@example.com" && m.subject.startsWith("老王的 Codex 想问"));
    assert.deepEqual(
      fromWang.map((m) => m.subject.split("：")[1]),
      ["要批准的", "视频制作流程", "第二个"],
      "the request declined in the test above counted too; the fourth that day is not emailed",
    );

    // Requests between one's own AIs, and requests to someone who turned
    // emails off, send nothing.
    const me = await wang.call("POST", "/api/me", { emailNotify: false });
    assert.equal(me.emailNotify, false);
    const count = mailer.sent.length;
    await fangMac.client.createRequest({ from: fangMac.agent("claude"), to: wangLaptop.agent("codex"), topic: "反过来", message: "q" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mailer.sent.length, count);
  });

  test("the 我 page and first-use checklist", async () => {
    const me = await fang.call("GET", "/api/me");
    assert.equal(me.emailNotify, true);
    assert.deepEqual(me.devices.map((d: { name: string; ais: string[] }) => [d.name, d.ais]), [["MacBook Air", ["Claude"]]]);
    // 豆包's question to 老方's Claude above was answered.
    assert.deepEqual(me.checklist, { connected: true, invited: true, collaborated: true });
  });
});

test("a database from before remote AIs is upgraded in place", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE devices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
      public_key TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      device_id TEXT NOT NULL REFERENCES devices(id), client TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO accounts VALUES ('a_1', 'fang@example.com', '老方', '2026-10-28');
    INSERT INTO devices VALUES ('d_1', 'a_1', 'Mac', 'key', '2026-10-28', NULL, NULL);
    INSERT INTO agents VALUES ('d_1/claude', 'a_1', 'd_1', 'claude', '2026-10-28');
  `);
  db.exec("PRAGMA foreign_keys = ON");
  const accounts = new AccountStore(db);
  const agent = accounts.agent("d_1/claude")!;
  assert.equal(agent.canReceive, true);
  assert.equal(agent.active, true);
  assert.equal(accounts.account("a_1")!.emailNotify, true);
  assert.equal(accounts.agentConfig(agent, "a_1").name, "我的 Claude");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  const { agent: doubao } = accounts.connectRemoteAgent("a_1", "doubao", null);
  assert.equal(doubao.deviceId, null);
  new AccountStore(db); // opening again changes nothing
  assert.equal(accounts.activeAgents("a_1").length, 2);
});
