import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountStore } from "../src/cloud/accounts.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { addComputer, Browser, logIn, startTestCloud, type MemoryMailer } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

describe("adding friends", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  // The cloud's clock; computers sign requests with the real one, so it only
  // moves ahead for a moment.
  let clock = Date.now();
  let fang: Browser;
  let wang: Browser;

  const mailsTo = (to: string) => mailer.sent.filter((m) => m.to === to);
  const link = (to: string) => mailsTo(to).at(-1)!.text.match(/\/invite\/(\S+)/)![1];

  before(async () => {
    ({ cloud, mailer } = await startTestCloud(() => new Date(clock)));
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    wang = await logIn(cloud, mailer, "wang@example.com", "老王");
  });
  after(() => cloud.close());

  test("someone new gets an email, signs up with it and accepts from 新的朋友", async () => {
    const sent = await fang.call("POST", "/api/invites", { email: " Lin@Example.com " });
    assert.deepEqual([sent.status, sent.email, sent.joined], ["pending", "lin@example.com", false]);
    assert.equal(mailsTo("lin@example.com").at(-1)!.subject, "老方邀请你加入 Achat");
    assert.deepEqual(
      (await fang.call("GET", "/api/invites")).map((f: any) => [f.direction, f.name, f.status]),
      [["out", "lin@example.com", "pending"]],
    );

    const lin = await logIn(cloud, mailer, "lin@example.com", "小林");
    assert.equal((await lin.call("GET", "/api/me")).newFriends, 1);
    const [request] = await lin.call("GET", "/api/invites");
    assert.deepEqual([request.direction, request.name, request.email, request.status], ["in", "老方", "fang@example.com", "pending"]);
    // Only the person the email went to can accept by id.
    await assert.rejects(wang.call("POST", `/api/invites/${request.id}/accept`, {}), /找不到这个邀请/);
    assert.deepEqual((await lin.call("POST", `/api/invites/${request.id}/accept`, {})).contact.name, "老方");

    assert.deepEqual((await lin.call("GET", "/api/contacts")).map((c: any) => c.name), ["老方"]);
    assert.equal((await lin.call("GET", "/api/me")).newFriends, 0);
    assert.deepEqual((await fang.call("GET", "/api/invites")).map((f: any) => [f.name, f.status]), [["小林", "accepted"]]);
    const accepted = mailsTo("fang@example.com").at(-1)!;
    assert.equal(accepted.subject, "小林接受了你的邀请");
    assert.match(accepted.html!, /小林已成为你的朋友/);
    await assert.rejects(fang.call("POST", "/api/invites", { email: "lin@example.com" }), /小林已经是你的朋友了/);
  });

  test("someone already on Achat gets a friend request; the link in the email works too", async () => {
    const sent = await fang.call("POST", "/api/invites", { email: "wang@example.com" });
    assert.equal(sent.joined, true);
    assert.equal(mailsTo("wang@example.com").at(-1)!.subject, "老方想加你为 Achat 朋友");
    await wang.call("POST", `/api/invites/${link("wang@example.com")}/accept`, {});
    assert.deepEqual((await fang.call("GET", "/api/contacts")).map((c: any) => c.name).sort(), ["小林", "老王"].sort());
    // 老王 sees it as accepted, not as a request still waiting.
    assert.deepEqual((await wang.call("GET", "/api/invites")).map((f: any) => [f.direction, f.status]), [["in", "accepted"]]);
  });

  test("asking someone who already asked you makes you friends at once", async () => {
    const zhao = await logIn(cloud, mailer, "zhao@example.com", "老赵");
    await zhao.call("POST", "/api/invites", { email: "fang@example.com" });
    const back = await fang.call("POST", "/api/invites", { email: "zhao@example.com" });
    assert.deepEqual([back.status, back.contact.name], ["accepted", "老赵"]);
    assert.deepEqual((await zhao.call("GET", "/api/invites")).map((f: any) => [f.direction, f.name, f.status]), [["out", "老方", "accepted"]]);
  });

  test("one email a day per address, resend renews the invite, withdraw removes it", async () => {
    await assert.rejects(fang.call("POST", "/api/invites", { email: "fang@example.com" }), /不能添加自己/);
    await assert.rejects(fang.call("POST", "/api/invites", { email: "not-an-email" }), /邮箱格式不对/);
    const { id } = await fang.call("POST", "/api/invites", { email: "qian@example.com" });
    const first = link("qian@example.com");
    await assert.rejects(fang.call("POST", "/api/invites", { email: "qian@example.com" }), /今天已经邀请过/);
    await assert.rejects(fang.call("POST", `/api/invites/${id}/resend`, {}), /今天已经邀请过/);

    clock += 8 * DAY;
    const row = () => fang.call("GET", "/api/invites").then((list: any[]) => list.find((f) => f.id === id));
    assert.equal((await row()).status, "expired");
    await fang.call("POST", `/api/invites/${id}/resend`, {});
    assert.equal((await row()).status, "pending");
    assert.equal(mailsTo("qian@example.com").length, 2);
    // The old link stopped working when the invite was sent again.
    assert.equal((await new Browser(cloud.url).call("GET", `/api/invites/${link("qian@example.com")}`)).status, "valid");
    await assert.rejects(new Browser(cloud.url).call("GET", `/api/invites/${first}`), /找不到这个邀请/);

    await assert.rejects(wang.call("DELETE", `/api/invites/${id}`), /找不到这个邀请/);
    await fang.call("DELETE", `/api/invites/${id}`);
    assert.equal(await row(), undefined);
    clock -= 8 * DAY;
  });

  test("an AI adds a friend by email and hears about requests it cannot accept", async () => {
    const mac = await addComputer(cloud, wang, "Mac", ["claude"]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer({
      connection: () => ({ client: mac.client, agentId: mac.agent("claude"), webUrl: cloud.url, mode: "cloud" }),
      waitSeconds: 1,
    }).connect(serverSide);
    const ai = new Client({ name: "test", version: "1" });
    await ai.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      ((await ai.callTool({ name, arguments: args })).content as { text: string }[]).map((c) => c.text).join("\n");

    assert.match(await call("create_invite", { email: "sun@example.com" }), /已给 sun@example.com 发了邀请邮件/);
    assert.equal(mailsTo("sun@example.com").at(-1)!.subject, "老王邀请你加入 Achat");
    // Accepting is left to the person, on the web.
    await assert.rejects((mac.client as any).call("POST", `/api/invites/${link("sun@example.com")}/accept`, {}), /网页上由人来操作/);

    const sun = await logIn(cloud, mailer, "sun@example.com", "小孙");
    await sun.call("POST", "/api/invites", { email: "wang@example.com" });
    // 老王 already asked 小孙, so 小孙 asking back made them friends; a third person asks instead.
    const zhou = await logIn(cloud, mailer, "zhou@example.com", "老周");
    await zhou.call("POST", "/api/invites", { email: "wang@example.com" });
    assert.match(await call("list_contacts"), /老周想加主人为朋友.*新的朋友/);
  });
});

test("invites from before email invites get ids", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      email_notify INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE agents (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT, client TEXT NOT NULL, label TEXT,
      token_hash TEXT UNIQUE, last_used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE invites (code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT,
      created_at TEXT NOT NULL);
    INSERT INTO accounts (id, email, name, created_at) VALUES ('a_1', 'fang@example.com', '老方', '2026-10-28');
    INSERT INTO invites VALUES ('hash', 'a_1', 0, NULL, '2026-10-28');
    PRAGMA user_version = 2;
  `);
  new AccountStore(db);
  const row = db.prepare("SELECT id, email FROM invites").get() as { id: string; email: string | null };
  assert.match(row.id, /^i_[0-9a-f]{16}$/);
  assert.equal(row.email, null);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
});
