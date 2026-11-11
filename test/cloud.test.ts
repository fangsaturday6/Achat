import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { RelayClient } from "../src/client.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { ensureDeviceKey, FileKeyStore, signRequest } from "../src/device.js";
import { addComputer, Browser, logIn, startTestCloud, until, type MemoryMailer } from "./helpers.js";

describe("cloud", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  // 老方 has a Mac with Claude and Codex; 老王 has a laptop with Codex.
  let fang: Browser;
  let wang: Browser;
  let fangMac: Awaited<ReturnType<typeof addComputer>>;
  let wangLaptop: Awaited<ReturnType<typeof addComputer>>;

  before(async () => {
    ({ cloud, mailer } = await startTestCloud());
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    fangMac = await addComputer(cloud, fang, "MacBook Air", ["claude", "codex"]);
    wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
  });
  after(() => cloud.close());

  test("logging in with an emailed code, with limits on guessing", async () => {
    const browser = new Browser(cloud.url);
    await browser.call("POST", "/api/auth/code", { email: "New@Example.com" });
    const mail = mailer.sent.at(-1)!;
    const code = mailer.lastCode("new@example.com");
    assert.match(mail.subject, new RegExp(`^${code} 是你的 Achat 验证码$`), "the code leads the subject, for previews");
    assert.match(mail.text, /10 分钟内有效/);
    assert.match(mail.html!, new RegExp(`>${code}<`), "the HTML shows the code on its own, so it copies cleanly");
    assert.match(mail.html!, /achat\.test/);
    assert.doesNotMatch(mail.html!, /style="[^"]*:\s*"/, "no double quotes cut a style attribute short");
    await assert.rejects(browser.call("POST", "/api/auth/code", { email: "new@example.com" }), /一分钟后再试/);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(browser.call("POST", "/api/auth/verify", { email: "new@example.com", code: "000000" }), /验证码/);
    }
    // Five wrong guesses use the code up, even the right one fails now.
    await assert.rejects(
      browser.call("POST", "/api/auth/verify", { email: "new@example.com", code: mailer.lastCode("new@example.com") }),
      /已失效/,
    );
    await assert.rejects(browser.call("GET", "/api/me"), /请先登录/);
  });

  test("a new account is asked for a name; the session is a secure, http-only cookie", async () => {
    const res = await fetch(`${cloud.url}/api/auth/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "li@example.com" }),
    });
    assert.equal(res.status, 200);
    const verified = await fetch(`${cloud.url}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "li@example.com", code: mailer.lastCode("li@example.com") }),
    });
    assert.equal((await verified.json()).needsName, true);
    const cookie = verified.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test("people's computers install Achat from the service, not from GitHub", async () => {
    const script = await (await fetch(`${cloud.url}/install.sh`)).text();
    assert.match(script, /^#!\/usr\/bin\/env bash/);
    assert.match(script, /URL="https:\/\/achat\.test"/);
    assert.doesNotMatch(script, /__ACHAT_URL__|github\.com/);
    assert.match(script, /link "\$URL" --no-wait/);

    const res = await fetch(`${cloud.url}/download/achat.tgz`);
    assert.equal(res.headers.get("content-type"), "application/gzip");
    const { spawnSync } = await import("node:child_process");
    const listing = spawnSync("tar", ["-tzf", "-"], { input: Buffer.from(await res.arrayBuffer()) }).stdout.toString();
    for (const file of ["package.json", "package-lock.json", "dist/cli.js", "web/index.html"]) {
      assert.ok(listing.split("\n").includes(file), file);
    }
    assert.ok(!listing.includes("node_modules/"));
  });

  test("cookie requests that change something need the web page's header", async () => {
    await assert.rejects(fang.call("POST", "/api/invites", {}, { "x-achat-web": "" }), /x-achat-web/);
  });

  test("a computer is added only after its owner confirms on the web", async () => {
    const key = ensureDeviceKey(new FileKeyStore(join(mkdtempSync(join(tmpdir(), "achat-key-")), "device.key")));
    const client = new RelayClient(cloud.url, key);
    const ticket = await client.createDeviceLink({ publicKey: key.publicKey, name: "iMac", clients: ["claude"] });
    assert.match(ticket.url, /^https:\/\/achat\.test\/link\/l_/);
    assert.match(ticket.code, /^\d{3} \d{3}$/);
    await assert.rejects(client.me(), /不在任何 Achat 账号下/);

    const id = ticket.url.split("/").at(-1)!;
    const status = await fang.call("GET", `/api/device-links/${id}`);
    assert.equal(status.code, ticket.code, "the page shows the same pairing code as the computer");
    assert.equal(status.name, "iMac");
    await fang.call("POST", `/api/device-links/${id}/approve`, {});
    assert.equal((await client.me()).account.name, "老方");
    await assert.rejects(wang.call("POST", `/api/device-links/${id}/approve`, {}), /已经添加过/);

    // With two Claudes, each is named after its computer.
    const names = (await fangMac.client.agents()).map((a) => a.name);
    assert.ok(names.includes("我的 Claude（MacBook Air）"), names.join());
    assert.ok(names.includes("我的 Claude（iMac）"), names.join());
    await fang.call("DELETE", `/api/devices/${key.deviceId}`);
    await assert.rejects(client.me(), /不在任何 Achat 账号下/);
  });

  test("a computer key belongs to one account", async () => {
    const ticket = await fangMac.client.createDeviceLink({
      publicKey: fangMac.key.publicKey,
      name: "MacBook Air",
      clients: ["claude"],
    });
    await assert.rejects(wang.call("POST", `/api/device-links/${ticket.url.split("/").at(-1)}/approve`, {}), /另一个账号/);
  });

  test("signed requests cannot be replayed or altered", async () => {
    const path = "/api/me";
    const headers = signRequest(fangMac.key, "GET", path);
    const first = await fetch(cloud.url + path, { headers });
    assert.equal(first.status, 200);
    const again = await fetch(cloud.url + path, { headers });
    assert.equal(again.status, 401);

    const stale = signRequest(fangMac.key, "GET", path, "", Date.now() - 10 * 60 * 1000);
    assert.equal((await fetch(cloud.url + path, { headers: stale })).status, 401);

    const body = JSON.stringify({ from: fangMac.agent("codex"), to: fangMac.agent("claude"), topic: "x", message: "y" });
    const signed = signRequest(fangMac.key, "POST", "/api/threads", body);
    const tampered = await fetch(cloud.url + "/api/threads", {
      method: "POST",
      headers: { ...signed, "content-type": "application/json" },
      body: body.replace('"y"', '"z"'),
    });
    assert.equal(tampered.status, 401);
  });

  test("two identical requests in the same millisecond are both accepted", async (t) => {
    // The receiving process and an MCP process share the computer's key and
    // can ask for the same thing at the same moment.
    const frozen = Date.now();
    t.mock.method(Date, "now", () => frozen);
    const other = new RelayClient(cloud.url, fangMac.key);
    const replies = await Promise.all([fangMac.client.me(), fangMac.client.me(), other.me()]);
    assert.deepEqual(
      replies.map((r) => r.device?.id),
      [fangMac.key.deviceId, fangMac.key.deviceId, fangMac.key.deviceId],
    );
  });

  test("a computer not yet updated still signs whole milliseconds", async () => {
    const time = String(Date.now());
    const text = ["achat-v1", "GET", "/api/me", time, createHash("sha256").update("").digest("hex")].join("\n");
    const res = await fetch(cloud.url + "/api/me", {
      headers: {
        "x-achat-device": fangMac.key.deviceId,
        "x-achat-time": time,
        "x-achat-signature": sign(null, Buffer.from(text), fangMac.key.privateKey).toString("base64"),
      },
    });
    assert.equal(res.status, 200);
  });

  test("one person's own AIs talk without approval", async () => {
    const t = await fangMac.client.createRequest({
      from: fangMac.agent("codex"),
      to: fangMac.agent("claude"),
      topic: "自己问自己",
      message: "上次的视频怎么做的？",
    });
    assert.equal(t.status, "active");
    assert.match(t.messages.at(-1)!.body, /自动接待/);
  });

  test("strangers cannot reach each other until an invite is accepted", async () => {
    await assert.rejects(
      wangLaptop.client.createRequest({ from: wangLaptop.agent("codex"), to: fangMac.agent("claude"), topic: "x", message: "y" }),
      /还不是朋友/,
    );
    assert.deepEqual(await wangLaptop.client.contacts(), []);

    const invite = await fangMac.client.createInvite();
    const code = invite.url.split("/").at(-1)!;
    const preview = await new Browser(cloud.url).call("GET", `/api/invites/${code}`);
    assert.deepEqual(preview, { from: { id: preview.from.id, name: "老方" }, status: "valid" });
    await assert.rejects(fang.call("POST", `/api/invites/${code}/accept`, {}), /你自己发出的/);
    await wang.call("POST", `/api/invites/${code}/accept`, {});
    await assert.rejects(wang.call("POST", `/api/invites/${code}/accept`, {}), /用过了/);

    const contacts = await wangLaptop.client.contacts();
    assert.equal(contacts[0].name, "老方");
    // The iMac was removed above, so 老方 has one Claude again.
    assert.deepEqual(contacts[0].agents.map((a) => a.name).sort(), ["老方的 Claude", "老方的 Codex"]);
  });

  test("a request from someone else waits for approval and stays private to the two of them", async () => {
    const outsider = await logIn(cloud, mailer, "zhao@example.com", "老赵");
    const outsiderPc = await addComputer(cloud, outsider, "PC", ["claude"]);

    const t = await wangLaptop.client.createRequest({
      from: wangLaptop.agent("codex"),
      to: fangMac.agent("claude"),
      topic: "视频制作流程",
      message: "老方上次的视频是怎么做的？",
    });
    assert.equal(t.status, "pending");

    await assert.rejects(outsiderPc.client.getThread(t.id), /找不到这次协作/);
    await assert.rejects(outsider.call("GET", `/api/threads/${t.id}`), /找不到这次协作/);
    assert.equal((await outsiderPc.client.listThreads()).length, 0);
    await assert.rejects(wang.call("POST", `/api/threads/${t.id}/approve`, {}), /接收方的主人/);
    await assert.rejects(wangLaptop.client.approve(t.id), /接收方的主人/);

    // 老方 approves on the web; his Mac answers as his Claude, not as 老王's Codex.
    await fang.call("POST", `/api/threads/${t.id}/approve`, { maxRounds: 2 });
    await assert.rejects(
      fangMac.client.postMessage(t.id, { from: wangLaptop.agent("codex"), body: "冒充" }),
      /这台电脑上的 AI/,
    );
    await assert.rejects(fang.call("POST", `/api/threads/${t.id}/messages`, { from: fangMac.agent("claude"), body: "x" }), /这台电脑上的 AI/);
    const answered = await fangMac.client.postMessage(t.id, { from: fangMac.agent("claude"), body: "先写分镜", costUsd: 0.1 });
    assert.equal(answered.roundsUsed, 1);
    assert.equal((await wangLaptop.client.getThread(t.id)).messages.at(-1)!.body, "先写分镜");

    const fromWang = (await wangLaptop.client.agents()).find((a) => a.id === fangMac.agent("claude"));
    assert.equal(fromWang?.name, "老方的 Claude");

    // Later 老方's Claude says the work is done; it is news for 老王's Codex only.
    const done = await fangMac.client.postMessage(t.id, { from: fangMac.agent("claude"), body: "做完了" });
    const askerNews = async (client: RelayClient) =>
      (await client.listThreads({ unseen: wangLaptop.agent("codex") })).map((x) => x.id);
    assert.ok((await askerNews(wangLaptop.client)).includes(t.id));
    assert.deepEqual(await askerNews(outsiderPc.client), []);
    await assert.rejects(fangMac.client.markSeen(t.id, done.messages.at(-1)!.seq), /发起方的 AI/);
    await assert.rejects(outsiderPc.client.markSeen(t.id, done.messages.at(-1)!.seq), /找不到这次协作/);
    await wangLaptop.client.markSeen(t.id, done.messages.at(-1)!.seq);
    assert.deepEqual(await askerNews(wangLaptop.client), []);
  });

  test("a file sent in a conversation is for its two sides only, and may be bigger than other requests", async () => {
    const outsider = await logIn(cloud, mailer, "qian@example.com", "老钱");
    const outsiderPc = await addComputer(cloud, outsider, "PC", ["claude"]);
    // Over the 1 MB other requests may carry.
    const picture = Buffer.alloc(2 * 1024 * 1024, 7);
    const t = await wangLaptop.client.createRequest({
      from: wangLaptop.agent("codex"),
      to: fangMac.agent("claude"),
      topic: "看图",
      message: "看看这张",
      files: [{ name: "大图.png", data: picture.toString("base64") }],
    });
    const id = t.messages[0].files[0].id;
    assert.deepEqual(await fangMac.client.file(id), picture);
    const onPage = (b: Browser) => fetch(`${cloud.url}/api/files/${id}`, { headers: { cookie: b.cookie } });
    assert.equal((await onPage(fang)).headers.get("content-type"), "image/png");
    await assert.rejects(outsiderPc.client.file(id), /找不到这个文件/);
    assert.equal((await onPage(outsider)).status, 404);
  });

  test("the event stream only carries the account's own threads", async () => {
    const outsider = await logIn(cloud, mailer, "sun@example.com", "老孙");
    const outsiderPc = await addComputer(cloud, outsider, "PC", ["codex"]);
    const listen = async (client: RelayClient): Promise<{ seen: string[]; stop: () => void }> => {
      const seen: string[] = [];
      let connected!: () => void;
      const ready = new Promise<void>((r) => (connected = r));
      const stop = client.subscribe(undefined, (e) => seen.push(e.threadId), connected);
      await ready;
      return { seen, stop };
    };
    const owner = await listen(fangMac.client);
    const stranger = await listen(outsiderPc.client);
    try {
      const t = await fangMac.client.createRequest({
        from: fangMac.agent("codex"),
        to: fangMac.agent("claude"),
        topic: "私事",
        message: "y",
      });
      await until(async () => owner.seen.includes(t.id));
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!stranger.seen.includes(t.id));
    } finally {
      owner.stop();
      stranger.stop();
    }
  });

  test("removing a contact stops new requests", async () => {
    const fangId = (await fang.call("GET", "/api/me")).account.id;
    await wang.call("DELETE", `/api/contacts/${fangId}`);
    await assert.rejects(
      wangLaptop.client.createRequest({ from: wangLaptop.agent("codex"), to: fangMac.agent("claude"), topic: "x", message: "y" }),
      /还不是朋友/,
    );
  });
});
