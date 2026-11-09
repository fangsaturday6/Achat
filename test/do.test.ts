import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RelayClientError, type RelayClient } from "../src/client.js";
import type { AchatConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RunningRelay } from "../src/relay/server.js";
import type { Answer, ApprovalPrompt } from "../src/sidecar/dialog.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { backgroundId, claudeTaskArgs, TaskBook, taskDir, type TaskOpener, type TaskRecord, type TaskStart } from "../src/sidecar/tasks.js";
import { CLAUDE, CODEX, ScriptedRunner, startTestRelay, until } from "./helpers.js";

// Achat's MCP server marks what the 动手 conversation was handed in ACHAT_HOME.
process.env.ACHAT_HOME = mkdtempSync(join(tmpdir(), "achat-home-"));

class FakeOpener implements TaskOpener {
  starts: TaskStart[] = [];
  async open(start: TaskStart): Promise<TaskRecord> {
    this.starts.push(start);
    return { sessionId: `session-${this.starts.length}`, dir: start.from?.dir ?? `/tmp/${start.topic}` };
  }
}

async function mcpClient(relayClient: RelayClient, agentId: string, webUrl: string, waitSeconds = 10): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client: relayClient, agentId, webUrl, mode: "local" }), waitSeconds }).connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

async function rejects(p: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof RelayClientError && message.test(err.message));
}

describe("动手 on the relay", () => {
  let relay: RunningRelay;
  let client: RelayClient;

  before(async () => {
    ({ relay, client } = await startTestRelay());
  });
  after(() => relay.close());

  test("only Claude can be asked to 动手, and the person can turn it into 问答 but not the other way", async () => {
    await rejects(client.createRequest({ from: CLAUDE, to: CODEX, topic: "写脚本", message: "写一个", mode: "do" }), /还不能动手/);

    const doing = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "写脚本", message: "写一个", mode: "do" });
    assert.equal(doing.mode, "do");
    const approved = await client.approve(doing.id);
    assert.equal(approved.messages.at(-1)!.body, "已同意：动手 · 5 轮");

    const turned = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "改成问答", message: "写一个", mode: "do" });
    const asAnswer = await client.approve(turned.id, { mode: "answer" });
    assert.equal(asAnswer.mode, "answer");
    assert.equal(asAnswer.messages.at(-1)!.body, "已同意：问答 · 5 轮 · $5.00");

    const asking = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "只是问问", message: "怎么做的？" });
    await rejects(client.approve(asking.id, { mode: "do" }), /不能改成动手/);
  });

  test("a 问答 can ask to 动手 mid-thread; declining keeps the 问答 going, approving starts the rounds over", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "字幕转文章", message: "字幕怎么转成文章？" });
    await client.approve(t.id);
    await client.postMessage(t.id, { from: CLAUDE, body: "用脚本合并段落" });
    await rejects(client.postMessage(t.id, { from: CLAUDE, body: "我来动手", mode: "do" }), /只有发起方/);

    const asked = await client.postMessage(t.id, { from: CODEX, body: "那就请你动手写一个", mode: "do" });
    assert.equal(asked.status, "pending");
    assert.equal(asked.mode, "do");
    assert.equal(asked.messages.at(-1)!.kind, "request");

    const declined = await client.decline(t.id);
    assert.equal(declined.status, "active");
    assert.equal(declined.mode, "answer");
    assert.equal(declined.messages.at(-1)!.body, "没有接受动手，接着问答");

    await client.postMessage(t.id, { from: CLAUDE, body: "还是只能说说做法" });
    await client.postMessage(t.id, { from: CODEX, body: "再请你动手一次", mode: "do" });
    const approved = await client.approve(t.id);
    assert.equal(approved.mode, "do");
    assert.equal(approved.roundsUsed, 0);
    assert.equal(approved.status, "active");
  });
});

describe("动手 on the receiving computer", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let config: AchatConfig;
  let sidecar: Sidecar;
  let opener: FakeOpener;
  let runner: ScriptedRunner;
  const notes: string[] = [];
  const asked: ApprovalPrompt[] = [];
  const answers: ((a: Answer) => void)[] = [];

  before(async () => {
    ({ relay, client, config } = await startTestRelay());
  });
  after(() => relay.close());

  function startSidecar(replies: string[] = []): void {
    opener = new FakeOpener();
    runner = new ScriptedRunner(replies);
    sidecar = new Sidecar({
      client,
      agents: config.agents,
      runners: { [CLAUDE]: runner, [CODEX]: new ScriptedRunner([]) },
      doers: { [CLAUDE]: opener },
      ask: (prompt) => {
        asked.push(prompt);
        let resolve!: (a: Answer) => void;
        const answer = new Promise<Answer>((r) => (resolve = r));
        answers.push(resolve);
        return { answer, close: () => resolve("later") };
      },
      notify: (title, body) => notes.push(`${title} ${body}`),
      webUrl: relay.url,
      seenWaitMs: 300,
      log: () => {},
    });
    sidecar.start();
  }
  afterEach(() => sidecar?.stop());

  test("approving opens a conversation that hands the work back and takes what the asker says next", async () => {
    startSidecar();
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({
      name: "send_request",
      arguments: { to: "我的 Claude", topic: "字幕脚本", message: "写一个 SRT 转 Markdown 的脚本", mode: "do" },
    });
    await until(async () => asked.find((p) => p.topic === "字幕脚本"));
    const prompt = asked.find((p) => p.topic === "字幕脚本")!;
    assert.equal(prompt.mode, "do");
    assert.equal(prompt.title, "我的 Codex 请你的 Claude 动手");
    assert.equal(prompt.scope, "动手 · 5 轮");
    answers[asked.indexOf(prompt)]("approve");

    await until(async () => opener.starts.length === 1);
    const start = opener.starts[0];
    assert.match(start.prompt, /写一个 SRT 转 Markdown 的脚本/);
    assert.match(start.systemPrompt, new RegExp(`send_message（thread_id: ${start.threadId}）`));
    assert.equal(start.from, undefined);
    assert.equal(runner.calls.length, 0, "动手 does not answer in the background");
    await until(async () => notes.some((n) => n.startsWith("你的 Claude 开始动手 字幕脚本")));

    // The conversation hands the result back and waits for what comes next.
    const claude = await mcpClient(client, CLAUDE, relay.url);
    const handing = claude.callTool({ name: "send_message", arguments: { thread_id: start.threadId, message: "写好了：node srt2md.js in.srt" } });
    assert.match(textOf(await asking), /写好了：node srt2md\.js in\.srt/);
    const more = codex.callTool({ name: "send_message", arguments: { thread_id: start.threadId, message: "顺便支持 .vtt" } });
    const next = textOf(await handing);
    assert.match(next, /顺便支持 \.vtt/);
    assert.match(next, /不是主人说的话/);

    // Taken by the waiting conversation, so no new one opens.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(opener.starts.length, 1);
    await claude.callTool({ name: "send_message", arguments: { thread_id: start.threadId, message: "加上了" } });
    assert.match(textOf(await more), /加上了/);
  });

  test("what the asker says after the conversation stopped waiting opens a new one that carries on from it", async () => {
    startSidecar();
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "后来的追问", message: "写个脚本", mode: "do" });
    await until(async () => asked.find((p) => p.topic === "后来的追问"));
    await client.approve(t.id);
    await until(async () => opener.starts.length === 1);

    await client.postMessage(t.id, { from: CLAUDE, body: "写好了" });
    await client.postMessage(t.id, { from: CODEX, body: "再加个测试" });
    await until(async () => opener.starts.length === 2, 3000);
    const again = opener.starts[1];
    assert.deepEqual(again.from, { sessionId: "session-1", dir: "/tmp/后来的追问" });
    assert.match(again.prompt, /再加个测试/);
    assert.doesNotMatch(again.prompt, /写个脚本|写好了/);
    assert.ok(notes.some((n) => n.startsWith("你的 Claude 接着动手 后来的追问")));
  });

  test("asked mid-thread to 动手, the person approves again and the conversation starts with the 问答 so far", async () => {
    startSidecar(["原来的脚本是 Python 的，要动手才能写 Node 版"]);
    const codex = await mcpClient(client, CODEX, relay.url);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "字幕转文章", message: "字幕怎么转成文章？" });
    await until(async () => asked.find((p) => p.topic === "字幕转文章"));
    await client.approve(t.id);
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);

    const upgrading = codex.callTool({ name: "send_message", arguments: { thread_id: t.id, message: "那就请你动手写 Node 版", mode: "do" } });
    await until(async () => asked.filter((p) => p.topic === "字幕转文章").length === 2);
    const second = asked.filter((p) => p.topic === "字幕转文章")[1];
    assert.equal(second.title, "我的 Codex 请你的 Claude 动手");
    assert.equal(second.body, "那就请你动手写 Node 版");
    answers[asked.lastIndexOf(second)]("approve");

    await until(async () => opener.starts.length === 1);
    const start = opener.starts[0];
    assert.match(start.prompt, /字幕怎么转成文章？/);
    assert.match(start.prompt, /你之前说：\n<message>\n原来的脚本是 Python 的/);
    assert.match(start.prompt, /那就请你动手写 Node 版/);
    assert.equal(runner.calls.length, 1, "only the 问答 round ran in the background");
    await client.postMessage(t.id, { from: CLAUDE, body: "写好了" });
    assert.match(textOf(await upgrading), /写好了/);
  });
});

test("the task's folder is named after the topic, and another thread with the same topic gets its own", () => {
  const root = mkdtempSync(join(tmpdir(), "achat-tasks-"));
  assert.equal(taskDir("字幕/转 Markdown", "abc", root), join(root, "字幕 转 Markdown"));
  mkdirSync(join(root, "字幕 转 Markdown"));
  assert.equal(taskDir("字幕/转 Markdown", "abc", root), join(root, "字幕 转 Markdown abc"));
});

test("a later conversation carries on from the earlier one in a new background session, and edits go ahead while commands ask", () => {
  const start = { threadId: "t1", topic: "脚本", prompt: "接着做", systemPrompt: "规则", from: { sessionId: "old", dir: "/x" } };
  const args = claudeTaskArgs(start);
  assert.deepEqual(args.slice(0, 4), ["--bg", "--resume", "old", "--fork-session"]);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args.at(-1), "接着做");
  assert.equal(backgroundId("Starting background service…\nbackgrounded · 5af4910f · Achat · 脚本\n  claude agents"), "5af4910f");
  assert.equal(backgroundId("error: not logged in"), null);
});

test("what a conversation was handed only moves forward", () => {
  const book = new TaskBook(mkdtempSync(join(tmpdir(), "achat-book-")));
  assert.equal(book.get("t"), null);
  book.set("t", { sessionId: "s", dir: "/d" });
  assert.deepEqual(book.get("t"), { sessionId: "s", dir: "/d" });
  book.markSeen("t", 5);
  book.markSeen("t", 3);
  assert.equal(book.seen("t"), 5);
});
