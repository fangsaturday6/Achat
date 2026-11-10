import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { filesDir } from "../src/attachments.js";
import { RelayClient } from "../src/client.js";
import type { AchatConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RunningRelay } from "../src/relay/server.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { claudeTaskArgs, type TaskOpener, type TaskRecord, type TaskStart } from "../src/sidecar/tasks.js";
import { CLAUDE, CODEX, ScriptedRunner, startTestRelay, until } from "./helpers.js";

// Files an AI receives are kept under ACHAT_HOME; never the person's own.
process.env.ACHAT_HOME = mkdtempSync(join(tmpdir(), "achat-files-home-"));

const b64 = (data: Buffer | string): string => Buffer.from(data).toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function rawGet(port: number, path: string, token: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, "x-achat-token": token } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("files in a conversation", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let token: string;

  before(async () => {
    const started = await startTestRelay();
    relay = started.relay;
    client = started.client;
    token = started.config.token;
  });
  after(() => relay.close());

  test("a request and an answer carry files, which the thread lists and each side downloads", async () => {
    const t = await client.createRequest({
      from: CODEX,
      to: CLAUDE,
      topic: "截图",
      message: "看下这张图",
      files: [{ name: "截图.png", type: "image/png", data: b64(PNG) }],
    });
    const sent = t.messages[0].files;
    assert.deepEqual(
      sent.map((f) => [f.name, f.type, f.size]),
      [["截图.png", "image/png", PNG.length]],
    );
    assert.deepEqual(await client.file(sent[0].id), PNG);

    await client.approve(t.id);
    const answered = await client.postMessage(t.id, { from: CLAUDE, body: "改好了", files: [{ name: "fix.patch", data: b64("diff --git") }] });
    const reply = answered.messages.at(-1)!;
    assert.equal(reply.files[0].name, "fix.patch");
    assert.equal((await client.file(reply.files[0].id)).toString(), "diff --git");
    // Messages without files say so, so readers need no special case.
    assert.deepEqual(answered.messages.find((m) => m.kind === "system")!.files, []);
    assert.deepEqual((await client.getThread(t.id)).messages.map((m) => m.files.length), [1, 0, 1]);
  });

  test("a message can be only files, but not nothing", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "只发图", message: "", files: [{ name: "a.png", data: b64(PNG) }] });
    assert.equal(t.messages[0].body, "");
    await assert.rejects(client.createRequest({ from: CODEX, to: CLAUDE, topic: "空的", message: " " }), /消息需要在 1 到 8000 个字之间/);
    await client.approve(t.id);
    await assert.rejects(client.postMessage(t.id, { from: CLAUDE, body: "", files: [] }), /消息需要在 1 到 20000 个字之间/);
  });

  test("only pictures are shown in the page; anything else is downloaded", async () => {
    const t = await client.createRequest({
      from: CODEX,
      to: CLAUDE,
      topic: "各种文件",
      message: "看看",
      files: [
        { name: "图.png", type: "image/png", data: b64(PNG) },
        { name: "页面.html", type: "text/html", data: b64("<script>alert(1)</script>") },
        { name: "图标.svg", type: "image/svg+xml", data: b64("<svg onload=alert(1)>") },
      ],
    });
    const [png, html, svg] = t.messages[0].files;
    const shown = await rawGet(relay.port, `/api/files/${png.id}`, token);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers["content-type"], "image/png");
    assert.match(String(shown.headers["content-disposition"]), /^inline; filename\*=UTF-8''%E5%9B%BE\.png$/);
    assert.equal(shown.headers["x-content-type-options"], "nosniff");
    for (const f of [html, svg]) {
      const got = await rawGet(relay.port, `/api/files/${f.id}`, token);
      assert.equal(got.headers["content-type"], "application/octet-stream");
      assert.match(String(got.headers["content-disposition"]), /^attachment; /);
    }
    assert.equal((await rawGet(relay.port, "/api/files/nope", token)).status, 404);
  });

  test("names lose folders and odd characters", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "名字", message: "看看", files: [{ name: "../../etc/pass\nwd", data: b64("x") }] });
    assert.equal(t.messages[0].files[0].name, "passwd");
  });

  test("at most 9 files and 20 MB a message", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `${i}.txt`, data: b64("x") }));
    await assert.rejects(client.createRequest({ from: CODEX, to: CLAUDE, topic: "太多", message: "看看", files: ten }), /一次最多 9 个文件/);
    const big = [{ name: "大.bin", data: b64(Buffer.alloc(20 * 1024 * 1024 + 1)) }];
    await assert.rejects(client.createRequest({ from: CODEX, to: CLAUDE, topic: "太大", message: "看看", files: big }), /文件太大，一次最多 20 MB/);
    await assert.rejects(client.createRequest({ from: CODEX, to: CLAUDE, topic: "坏的", message: "看看", files: [{ name: "a", data: "不是 base64" }] }), /文件内容/);
  });
});

async function mcpClient(relayClient: RelayClient, agentId: string, webUrl: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client: relayClient, agentId, webUrl, mode: "local" }), waitSeconds: 10 }).connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

// A file on this computer that an AI is asked to send.
function local(name: string, data: Buffer | string): string {
  const path = join(mkdtempSync(join(tmpdir(), "achat-local-")), name);
  writeFileSync(path, data);
  return path;
}

class FakeOpener implements TaskOpener {
  starts: TaskStart[] = [];
  async open(start: TaskStart): Promise<TaskRecord> {
    this.starts.push(start);
    return { sessionId: "s1", dir: `/tmp/${start.topic}` };
  }
}

describe("AIs sending and receiving files", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let config: AchatConfig;
  let sidecar: Sidecar | null = null;

  before(async () => {
    ({ relay, client, config } = await startTestRelay());
  });
  after(() => relay.close());
  afterEach(() => sidecar?.stop());

  async function approveWhenAsked(topic: string): Promise<string> {
    const pending = await until(async () => (await client.listThreads({ status: "pending", to: CLAUDE })).find((t) => t.topic === topic));
    await client.approve(pending.id);
    return pending.id;
  }

  test("an AI asks with a screenshot; the answering AI finds it on its computer and may read it", async () => {
    const runner = new ScriptedRunner(["看了截图，是 Node 版本太低"]);
    sidecar = new Sidecar({ client, agents: config.agents, runners: { [CLAUDE]: runner }, notify: () => {}, webUrl: relay.url, log: () => {} });
    sidecar.start();
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({
      name: "send_request",
      arguments: { to: "我的 Claude", topic: "构建报错", message: "怎么修？", files: [local("报错.png", PNG)] },
    });
    const id = await approveWhenAsked("构建报错");
    assert.match(textOf(await asking), /Node 版本太低/);
    const saved = join(filesDir(id), "1", "报错.png");
    assert.deepEqual(readFileSync(saved), PNG);
    assert.ok(runner.calls[0].prompt.includes(saved), runner.calls[0].prompt);
    assert.deepEqual(runner.calls[0].readDirs, [filesDir(id)]);
  });

  test("a file handed back reaches the asking AI as a path on its computer", async () => {
    const codex = await mcpClient(client, CODEX, relay.url);
    const claude = await mcpClient(client, CLAUDE, relay.url);
    const asking = codex.callTool({ name: "send_request", arguments: { to: "我的 Claude", topic: "补丁", message: "改好发我" } });
    const id = await approveWhenAsked("补丁");
    await claude.callTool({ name: "send_message", arguments: { thread_id: id, message: "改好了", files: [local("fix.patch", "diff --git a b")] } });
    const outcome = textOf(await asking);
    const reply = (await client.getThread(id)).messages.find((m) => m.files.length)!;
    const saved = join(filesDir(id), String(reply.seq), "fix.patch");
    assert.ok(outcome.includes(saved), outcome);
    assert.equal(readFileSync(saved, "utf8"), "diff --git a b");
    assert.ok(textOf(await codex.callTool({ name: "check_thread", arguments: { thread_id: id } })).includes(saved));
  });

  test("a 动手 conversation is handed the files and may read their folder", async () => {
    const opener = new FakeOpener();
    sidecar = new Sidecar({
      client,
      agents: config.agents,
      runners: { [CLAUDE]: new ScriptedRunner([]) },
      doers: { [CLAUDE]: opener },
      notify: () => {},
      webUrl: relay.url,
      log: () => {},
    });
    sidecar.start();
    const t = await client.createRequest({
      from: CODEX,
      to: CLAUDE,
      topic: "照着图改",
      message: "照这张图改页面",
      mode: "do",
      files: [{ name: "设计稿.png", data: PNG.toString("base64") }],
    });
    await client.approve(t.id);
    const start = await until(async () => opener.starts[0]);
    const saved = join(filesDir(t.id), "1", "设计稿.png");
    assert.ok(start.prompt.includes(saved), start.prompt);
    assert.deepEqual(start.readDirs, [filesDir(t.id)]);
    const args = claudeTaskArgs(start);
    assert.equal(args[args.indexOf("--add-dir") + 1], filesDir(t.id));
  });

  test("a file that is not there is said plainly, and nothing is sent", async () => {
    const codex = await mcpClient(client, CODEX, relay.url);
    const result = await codex.callTool({ name: "send_request", arguments: { to: "我的 Claude", topic: "找不到", message: "看看", files: ["/没有/这个.png"] } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /找不到文件：\/没有\/这个\.png/);
    assert.ok(!(await client.listThreads()).some((t) => t.topic === "找不到"));
  });
});
