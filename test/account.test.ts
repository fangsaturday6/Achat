import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RelayClient } from "../src/client.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { loadConfig } from "../src/config.js";
import { connect } from "../src/connection.js";
import { checkLink, startLink, unlink } from "../src/link.js";
import { createMcpServer, type McpConnection } from "../src/mcp/server.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { addComputer, Browser, logIn, ScriptedRunner, startTestCloud, until, type MemoryMailer } from "./helpers.js";

async function mcp(connection: () => McpConnection, link?: (url?: string) => Promise<any>): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection, link, waitSeconds: 10 }).connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { text: string }[]).map((c) => c.text).join("\n");
}

describe("account mode", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  let fang: Browser;

  before(async () => {
    ({ cloud, mailer } = await startTestCloud());
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
  });
  after(() => cloud.close());

  describe("this computer", () => {
    const saved = { home: process.env.ACHAT_HOME, keystore: process.env.ACHAT_KEYSTORE, path: process.env.PATH };
    beforeEach(() => {
      const home = mkdtempSync(join(tmpdir(), "achat-home-"));
      // Pretend Claude Code is installed, so the computer registers a Claude.
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
      chmodSync(join(bin, "claude"), 0o755);
      process.env.ACHAT_HOME = home;
      process.env.ACHAT_KEYSTORE = "file";
      // Leave out folders holding a real Codex, so the test passes on computers that have one.
      const others = (saved.path ?? "").split(delimiter).filter((dir) => dir && !existsSync(join(dir, "codex")));
      process.env.PATH = [bin, ...others].join(delimiter);
    });
    afterEach(() => {
      for (const [key, value] of [["ACHAT_HOME", saved.home], ["ACHAT_KEYSTORE", saved.keystore], ["PATH", saved.path]]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }
    });

    test("joins an account once the person confirms, switches over, and can leave", async () => {
      const ticket = await startLink(cloud.url);
      assert.equal(connect().mode, "local", "nothing changes before the person confirms");
      assert.equal(await checkLink(), null);

      const id = ticket.url.split("/").at(-1)!;
      const page = await fang.call("GET", `/api/device-links/${id}`);
      assert.deepEqual(page.clients, ["claude"], "only AIs installed on this computer are registered");
      await fang.call("POST", `/api/device-links/${id}/approve`, {});
      assert.equal(await checkLink(), "老方");

      const conn = connect();
      assert.equal(conn.mode, "cloud");
      assert.equal(conn.agentId("claude@local"), `${conn.deviceId}/claude`);
      assert.equal(conn.webUrl, cloud.url);
      await assert.rejects(startLink(cloud.url), /已经加入了/);

      assert.match(await unlink(), /已经退出/);
      assert.equal(connect().mode, "local");
      assert.equal(loadConfig().cloud, undefined);
      assert.ok(!existsSync(join(process.env.ACHAT_HOME!, "device.key")), "the key is deleted");
      const devices = (await fang.call("GET", "/api/me")).devices;
      assert.ok(!devices.some((d: { id: string }) => d.id === conn.deviceId), "the computer is gone from the account");
    });

    test("the running service switches to the account once the link is confirmed", async () => {
      const free = (await import("node:net")).createServer();
      await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
      const port = (free.address() as { port: number }).port;
      await new Promise((r) => free.close(r));
      writeFileSync(join(process.env.ACHAT_HOME!, "config.json"), JSON.stringify({ port, token: "t", agents: loadConfig().agents }));
      const cli = ["--no-warnings=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts")];
      const daemon = spawn(process.execPath, [...cli, "start"], { env: process.env });
      let out = "";
      daemon.stdout.on("data", (d) => (out += d));
      daemon.stderr.on("data", (d) => (out += d));
      try {
        await until(async () => out.includes("Achat 已启动："), 30_000);
        const ticket = await startLink(cloud.url);
        await fang.call("POST", `/api/device-links/${ticket.url.split("/").at(-1)}/approve`, {});
        await until(async () => out.includes("Achat 已启动（账号模式）"), 30_000);
        assert.match(out, /这台电脑已加入 老方 的 Achat 账号/);
        const health = await (await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-achat-token": "t" } })).json();
        assert.equal(health.mode, "cloud");
        const page = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
        assert.equal(page.headers.get("location"), `${cloud.url}/`);

        await unlink();
        await until(async () => (out.match(/Achat 已启动：/g) ?? []).length === 2, 30_000);
      } finally {
        daemon.kill("SIGTERM");
      }
    });

    test("the AI can start linking and is told what the person should check", async () => {
      const local = connect();
      const tools = await mcp(
        () => ({ client: local.client, agentId: "codex@local", webUrl: local.webUrl, mode: "local" }),
        (url) => startLink(url ?? cloud.url),
      );
      assert.match(await call(tools, "create_invite"), /还没加入 Achat 账号/);
      const reply = await call(tools, "link_account");
      assert.match(reply, /请主人在浏览器打开：https:\/\/achat\.test\/link\/l_/);
      assert.match(reply, /配对码是 \d{3} \d{3}/);
    });
  });

  test("two people's AIs: invite, ask, approve on the web, answer in the background", async () => {
    const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    const fangMac = await addComputer(cloud, fang, "MacBook Air", ["claude", "codex"]);
    const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
    const as = (computer: { client: RelayClient; agent: (c: "claude" | "codex") => string }, client: "claude" | "codex") =>
      () => ({ client: computer.client, agentId: computer.agent(client), webUrl: cloud.url, mode: "cloud" as const });

    const notes: string[] = [];
    const runner = new ScriptedRunner(["我自己的 Codex 问的：先写分镜", "老王问的：先写分镜，再出图"]);
    const sidecar = new Sidecar({
      client: fangMac.client,
      agents: [],
      runners: { [fangMac.agent("claude")]: runner },
      notify: (title, body) => notes.push(`${title} ${body}`),
      webUrl: cloud.url,
      log: () => {},
    });
    sidecar.start();
    try {
      // 老方's own Codex asks his Claude: no approval.
      const fangCodex = await mcp(as(fangMac, "codex"));
      assert.match(await call(fangCodex, "send_request", { to: "我的 Claude", topic: "自己问", message: "视频怎么做？" }), /我自己的 Codex 问的/);
      assert.equal(notes.length, 0);

      // 老王's Codex cannot reach 老方 until 老方 invites him.
      const wangCodex = await mcp(as(wangLaptop, "codex"));
      assert.match(await call(wangCodex, "send_request", { to: "老方的 Claude", topic: "x", message: "y" }), /create_invite/);
      const fangClaude = await mcp(as(fangMac, "claude"));
      const invite = (await call(fangClaude, "create_invite")).match(/https?:\/\/\S+\/invite\/\S+/)![0];
      await wang.call("POST", `/api/invites/${invite.split("/").at(-1)}/accept`, {});
      assert.match(await call(wangCodex, "list_contacts"), /老方的 Claude/);

      const asking = call(wangCodex, "send_request", { to: "老方的Claude", topic: "视频制作流程", message: "上次的视频怎么做的？" });
      const pending = await until(async () => (await fangMac.client.listThreads({ status: "pending" }))[0]);
      await until(async () => notes.some((n) => n === "老王的 Codex [待批准] 视频制作流程"));
      assert.equal(runner.calls.length, 1, "nothing runs before 老方 approves");
      await fang.call("POST", `/api/threads/${pending.id}/approve`, {});
      const reply = await asking;
      assert.match(reply, /老方的 Claude的回复/);
      assert.match(reply, /老王问的：先写分镜，再出图/);
      assert.match(runner.calls[1].systemPrompt, /你是「我的 Claude」，正在通过 Achat 代表你的主人回答另一个 AI（老王的 Codex）/);
    } finally {
      sidecar.stop();
    }
  });
});
