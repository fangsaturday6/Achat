import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync as readdir, readFileSync, writeFileSync } from "node:fs";
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
import { doerSystemPrompt, Sidecar } from "../src/sidecar/sidecar.js";
import { actKey, backgroundId, claudeTaskArgs, codexSessionId, codexTaskArgs, CodexTaskOpener, TaskBook, taskDir, taskFor, type TaskOpener, type TaskRecord, type TaskStart } from "../src/sidecar/tasks.js";
import { codexCommand } from "../src/which.js";
import { CLAUDE, CODEX, JudgingRunner, ScriptedRunner, startTestRelay, until } from "./helpers.js";

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

  test("Claude and Codex can 动手, and the person picks 问答 or 动手 when approving", async () => {
    const toCodexDo = await client.createRequest({ from: CLAUDE, to: CODEX, topic: "画图", message: "画一张", mode: "do" });
    assert.equal(toCodexDo.mode, "do");

    const doing = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "写脚本", message: "写一个", mode: "do" });
    assert.equal(doing.mode, "do");
    const approved = await client.approve(doing.id);
    assert.equal(approved.messages.at(-1)!.body, "已同意：动手 · 10 轮");

    const turned = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "改成问答", message: "写一个", mode: "do" });
    const asAnswer = await client.approve(turned.id, { mode: "answer" });
    assert.equal(asAnswer.mode, "answer");
    assert.equal(asAnswer.messages.at(-1)!.body, "已同意：问答 · 10 轮 · $10.00");

    const asking = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "只是问问", message: "怎么做的？" });
    const asDo = await client.approve(asking.id, { mode: "do" });
    assert.equal(asDo.mode, "do");
    assert.equal(asDo.messages.at(-1)!.body, "已同意：动手 · 10 轮");

    const toCodex = await client.createRequest({ from: CLAUDE, to: CODEX, topic: "问 Codex", message: "怎么做的？" });
    assert.equal((await client.approve(toCodex.id, { mode: "do" })).mode, "do");
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
  let runner: JudgingRunner;
  const notes: string[] = [];
  const asked: ApprovalPrompt[] = [];
  const answers: ((a: Answer) => void)[] = [];

  before(async () => {
    ({ relay, client, config } = await startTestRelay());
  });
  after(() => relay.close());

  function startSidecar(replies: string[] = [], judgments: ("answer" | "do")[] = []): void {
    opener = new FakeOpener();
    runner = new JudgingRunner(replies, judgments);
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
    startSidecar([], ["do"]);
    const codex = await mcpClient(client, CODEX, relay.url);
    const asking = codex.callTool({
      name: "send_request",
      arguments: { to: "我的 Claude", topic: "字幕脚本", message: "写一个 SRT 转 Markdown 的脚本" },
    });
    await until(async () => asked.find((p) => p.topic === "字幕脚本"));
    const prompt = asked.find((p) => p.topic === "字幕脚本")!;
    assert.equal(prompt.mode, "do");
    assert.equal(prompt.title, "我的 Codex 请你的 Claude 动手");
    assert.equal(prompt.scope, "动手 · 10 轮");
    answers[asked.indexOf(prompt)]("approve");

    await until(async () => opener.starts.length === 1);
    const start = opener.starts[0];
    assert.match(start.prompt, /写一个 SRT 转 Markdown 的脚本/);
    assert.match(start.systemPrompt, new RegExp(`send_message（thread_id: ${start.threadId}）`));
    assert.deepEqual([start.from, start.inGroup], [undefined, undefined], "a thread's, handed back to the thread");
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
    startSidecar(["原来的脚本是 Python 的，要动手才能写 Node 版"], ["answer", "do"]);
    const codex = await mcpClient(client, CODEX, relay.url);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "字幕转文章", message: "字幕怎么转成文章？" });
    await until(async () => asked.find((p) => p.topic === "字幕转文章"));
    await client.approve(t.id);
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);

    const upgrading = codex.callTool({ name: "send_message", arguments: { thread_id: t.id, message: "那就请你动手写 Node 版" } });
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

test("the folder a 动手 conversation works in says which 动手 it is, the latest claimed if a folder was used again", () => {
  const book = new TaskBook(mkdtempSync(join(tmpdir(), "achat-book-")));
  const root = mkdtempSync(join(tmpdir(), "achat-root-"));
  const [a, b] = [join(root, "支付对接"), join(root, "画图")];
  for (const dir of [a, b]) mkdirSync(dir);
  assert.equal(book.at(a), null);
  book.claim("t_1", a);
  book.claim(actKey("g_1", "wang/codex", "fang/claude"), b);
  assert.equal(book.at(a), "t_1");
  assert.equal(book.at(join(b, ".")), "g_1~wang/codex~fang/claude");
  assert.deepEqual(taskFor(book.at(b)!), { group: "g_1", asker: "wang/codex", doer: "fang/claude" });
  assert.deepEqual(taskFor("t_1"), { thread: "t_1" });
  assert.equal(book.at(root), null, "nor any other folder");
  book.claim("t_2", a);
  assert.equal(book.at(a), "t_2");
});

test("Codex works in its folder with nobody to approve commands: online only between one person's own AIs in a thread, and a later run resumes", () => {
  const first = codexTaskArgs({ threadId: "t1", topic: "画图", prompt: "画", systemPrompt: "规则" });
  assert.deepEqual(first.slice(0, 2), ["exec", "--skip-git-repo-check"]);
  assert.ok(first.includes('sandbox_mode="workspace-write"'));
  assert.ok(first.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(first.includes(`developer_instructions=${JSON.stringify("规则")}`));
  assert.equal(first.at(-1), "-", "the prompt comes on stdin");
  const own = codexTaskArgs({ threadId: "t1", topic: "画图", prompt: "画", systemPrompt: "规则", own: true });
  assert.ok(own.includes("sandbox_workspace_write.network_access=true"));
  const later = codexTaskArgs({ threadId: "t1", topic: "画图", prompt: "接着画", systemPrompt: "规则", from: { sessionId: "0199-abc", dir: "/x" } });
  // Nobody is there to approve an MCP call either, so handing the work back
  // through Achat goes ahead, to the thread it works for; asking anyone else,
  // or speaking in the person's groups, still does not.
  const approved = (args: string[]) => args.filter((a) => a.endsWith('.approval_mode="approve"')).map((a) => a.split(".")[3]);
  for (const args of [first, later]) assert.deepEqual(approved(args), ["send_message", "check_thread"]);
  // 动手 asked for in a group hands back to the group, and nothing else.
  const inGroup = codexTaskArgs({ threadId: "ga_1", topic: "支付对接", prompt: "做", systemPrompt: "规则", inGroup: true });
  assert.deepEqual(approved(inGroup), ["send_group_message", "check_group"]);
  // What it reads in a group has others' words in it, whoever asked: never online.
  assert.ok(codexTaskArgs({ threadId: "ga_1", topic: "支付对接", prompt: "做", systemPrompt: "规则", inGroup: true, own: true }).includes("sandbox_workspace_write.network_access=false"));
  assert.deepEqual(later.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(later.slice(-2), ["0199-abc", "-"]);
  assert.equal(codexSessionId("OpenAI Codex v0.169\n--------\nworkdir: /x\nsession id: 01a1e4e6-9149-7ef2-a71d-01b8e8de82bc\n--------"), "01a1e4e6-9149-7ef2-a71d-01b8e8de82bc");
  assert.equal(codexSessionId("ERROR: not logged in"), null);
});

test("Codex is told it cannot have commands approved, and Claude that it can ask", () => {
  const from = { id: "x", name: "老王的 Claude", client: "claude" as const };
  assert.match(doerSystemPrompt({ id: CODEX, name: "我的 Codex", client: "codex" }, from, "t1"), /没有人能替你确认命令/);
  assert.match(doerSystemPrompt({ id: CLAUDE, name: "我的 Claude", client: "claude" }, from, "t1"), /照常让主人确认/);
});

test("the codex that runs is the one set, else a desktop app's, else the one on the PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "achat-codex-"));
  const bundled = join(dir, "codex");
  writeFileSync(bundled, "");
  assert.equal(codexCommand({ ACHAT_CODEX_BIN: "/opt/codex" }, [bundled]), "/opt/codex");
  assert.equal(codexCommand({}, [join(dir, "missing"), bundled]), bundled);
  assert.equal(codexCommand({}, [join(dir, "missing")]), "codex");
});

describe("a Codex conversation for 动手", () => {
  // A stand-in for `codex exec`: prints the header with a session id, what it
  // was asked on stdin, then works or fails as told.
  function fakeCodex(after: string): string {
    const dir = mkdtempSync(join(tmpdir(), "achat-fake-codex-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, ["#!/bin/bash", 'echo "args: $*"', "echo 'session id: 0199aaaa-bbbb-cccc'", "echo user", "cat", "echo", after, ""].join("\n"));
    chmodSync(bin, 0o755);
    return bin;
  }

  test("starts in a folder of its own and resolves with the session once it is under way", async () => {
    const scripts = mkdtempSync(join(tmpdir(), "achat-scripts-"));
    const root = mkdtempSync(join(tmpdir(), "achat-root-"));
    const opener = new CodexTaskOpener(fakeCodex("echo codex; echo 在画了"), scripts, root, false, 10_000);
    const claimed: string[] = [];
    const rec = await opener.open({ threadId: "t9", topic: "画小刘", prompt: "照设定图做 3D", systemPrompt: "规则", claim: (dir) => claimed.push(dir) });
    assert.equal(rec.sessionId, "0199aaaa-bbbb-cccc");
    assert.equal(rec.dir, join(root, "画小刘"));
    assert.deepEqual(claimed, [rec.dir], "its folder is told before it starts");
    await until(async () => {
      const logs = readdir(scripts).filter((f) => f.endsWith(".log"));
      return logs.length === 1 && /在画了/.test(readFileSync(join(scripts, logs[0]), "utf8"));
    });
    const log = readFileSync(join(scripts, readdir(scripts).find((f) => f.endsWith(".log"))!), "utf8");
    assert.match(log, /照设定图做 3D/, "the prompt went in on stdin");
    assert.match(log, /args: exec /);
  });

  test("says once it has stopped, so a round that never sent its result back is not left under way", async () => {
    const opener = new CodexTaskOpener(fakeCodex("echo codex; echo 画完了"), mkdtempSync(join(tmpdir(), "achat-scripts-")), mkdtempSync(join(tmpdir(), "achat-root-")), false, 10_000);
    let stopped = false;
    await opener.open({ threadId: "ga_1", topic: "画", prompt: "画", systemPrompt: "规则", onExit: () => (stopped = true) });
    await until(async () => stopped);
  });

  test("a run that fails at the start says why instead of waiting", async () => {
    const opener = new CodexTaskOpener(fakeCodex("echo 'ERROR: model is not supported'; exit 1"), mkdtempSync(join(tmpdir(), "achat-scripts-")), mkdtempSync(join(tmpdir(), "achat-root-")), false, 10_000);
    await assert.rejects(opener.open({ threadId: "t10", topic: "画", prompt: "画", systemPrompt: "规则" }), /打不开动手的对话：model is not supported/);
  });
});
