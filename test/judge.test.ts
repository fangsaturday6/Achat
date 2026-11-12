import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RelayClientError, type RelayClient } from "../src/client.js";
import { LOCAL_PERSON, type AchatConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { RunningRelay } from "../src/relay/server.js";
import type { Answer, ApprovalPrompt } from "../src/sidecar/dialog.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import type { TaskOpener, TaskRecord, TaskStart } from "../src/sidecar/tasks.js";
import type { ThreadMode } from "../src/types.js";
import { CLAUDE, CODEX, JudgingRunner, ScriptedRunner, startTestRelay, until } from "./helpers.js";

// Where a 动手 conversation's records go.
process.env.ACHAT_HOME = mkdtempSync(join(tmpdir(), "achat-home-"));

class FakeOpener implements TaskOpener {
  starts: TaskStart[] = [];
  async open(start: TaskStart): Promise<TaskRecord> {
    this.starts.push(start);
    return { sessionId: `session-${this.starts.length}`, dir: `/tmp/${start.topic}` };
  }
}

async function rejects(p: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof RelayClientError && message.test(err.message));
}

describe("问答 or 动手, judged by the asked computer: the relay", () => {
  let relay: RunningRelay;
  let client: RelayClient;

  before(async () => {
    ({ relay, client } = await startTestRelay());
  });
  after(() => relay.close());

  test("a request judged 动手 asks to 动手, each of the asker's words is judged once, and the person has the last word", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "灌测试库", message: "把 CSV 灌进测试库，核对条数" });
    assert.equal(t.mode, "answer");
    assert.equal(t.judged, 0);
    const seq = t.messages[0].seq;

    const judged = await client.judge(t.id, seq, "do");
    assert.equal(judged.status, "pending");
    assert.equal(judged.mode, "do");
    assert.equal(judged.judged, seq);
    assert.equal((await client.judge(t.id, seq, "answer")).mode, "do", "judged once");

    const asAnswer = await client.approve(t.id, { mode: "answer" });
    assert.equal(asAnswer.mode, "answer");
    assert.equal(asAnswer.messages.at(-1)!.body, "已同意：问答 · 5 轮 · $5.00");
  });

  test("judged 动手 in a 问答 under way is a request the person approves; declined, the 问答 goes on and is not judged again", async () => {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "渠道标签", message: "上周的渠道标签放在哪？" });
    await client.approve(t.id);
    await client.postMessage(t.id, { from: CLAUDE, body: "在 data/lastweek 下" });
    const asked = await client.postMessage(t.id, { from: CODEX, body: "那你帮我灌进测试库" });
    const seq = asked.messages.at(-1)!.seq;

    const upgrade = await client.judge(t.id, seq, "do");
    assert.equal(upgrade.status, "pending");
    assert.equal(upgrade.mode, "do");
    assert.deepEqual(upgrade.prior, { status: "active", mode: "answer" });

    const declined = await client.decline(t.id);
    assert.equal(declined.status, "active");
    assert.equal(declined.mode, "answer");
    assert.equal(declined.messages.at(-1)!.body, "没有接受动手，接着问答");
    const again = await client.judge(t.id, seq, "do");
    assert.equal(again.status, "active");
    assert.equal(again.mode, "answer");
  });

  test("between one person's own AIs, a judged 动手 starts without approval", async () => {
    const t = await client.createRequest({ from: LOCAL_PERSON.id, to: CLAUDE, topic: "改个文件", message: "把 README 的安装一节改短" });
    assert.equal(t.status, "active");
    assert.equal(t.own, true);
    const judged = await client.judge(t.id, t.messages.find((m) => m.kind === "request")!.seq, "do");
    assert.equal(judged.status, "active");
    assert.equal(judged.mode, "do");
    assert.equal(judged.messages.at(-1)!.body, "改成动手 · 5 轮");
  });

  test("only what the asker said is judged, and only Claude is judged into 动手", async () => {
    const t = await client.createRequest({ from: CLAUDE, to: CODEX, topic: "问 Codex", message: "帮我跑一下测试" });
    await rejects(client.judge(t.id, 99, "do"), /seq/);
    const judged = await client.judge(t.id, t.messages[0].seq, "do");
    assert.equal(judged.mode, "answer");
    assert.equal(judged.judged, t.messages[0].seq);
  });
});

describe("问答 or 动手, judged by the asked computer: the receiving computer", () => {
  let relay: RunningRelay;
  let client: RelayClient;
  let config: AchatConfig;
  let sidecar: Sidecar;
  let runner: JudgingRunner;
  const asked: ApprovalPrompt[] = [];
  const answers: ((a: Answer) => void)[] = [];

  before(async () => {
    ({ relay, client, config } = await startTestRelay());
  });
  after(() => relay.close());
  afterEach(() => sidecar?.stop());

  function startSidecar(replies: string[], judgments: (ThreadMode | Error)[]): void {
    runner = new JudgingRunner(replies, judgments);
    sidecar = new Sidecar({
      client,
      agents: config.agents,
      runners: { [CLAUDE]: runner, [CODEX]: new ScriptedRunner([]) },
      doers: { [CLAUDE]: new FakeOpener() },
      ask: (prompt) => {
        asked.push(prompt);
        let resolve!: (a: Answer) => void;
        const answer = new Promise<Answer>((r) => (resolve = r));
        answers.push(resolve);
        return { answer, close: () => resolve("later") };
      },
      notify: () => {},
      webUrl: relay.url,
      log: () => {},
    });
    sidecar.start();
  }

  const prompts = (topic: string): ApprovalPrompt[] => asked.filter((p) => p.topic === topic);

  test("a request is judged before its dialog, and judged 动手 the dialog asks to 动手, once", async () => {
    startSidecar([], ["do"]);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "灌测试库", message: "把 CSV 灌进测试库，核对条数" });
    await until(async () => prompts("灌测试库").length === 1);
    const prompt = prompts("灌测试库")[0];
    assert.equal(prompt.mode, "do");
    assert.equal(prompt.title, "我的 Codex 请你的 Claude 动手");
    assert.deepEqual(runner.judged, [{ topic: "灌测试库", message: "把 CSV 灌进测试库，核对条数", files: [] }]);
    answers[asked.indexOf(prompt)]("later");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(prompts("灌测试库").length, 1, "the judgment does not bring the dialog back");
    await client.decline(t.id);
  });

  test("asked to do something in a 问答, the person is asked to approve 动手 first; declined, it is answered as 问答", async () => {
    startSidecar(["在 data/lastweek 下", "我只能说做法：用导入脚本"], ["answer", "do"]);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "渠道标签", message: "上周的渠道标签放在哪？" });
    await until(async () => prompts("渠道标签").length === 1);
    assert.equal(prompts("渠道标签")[0].mode, "answer");
    answers[asked.indexOf(prompts("渠道标签")[0])]("approve");
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);

    await client.postMessage(t.id, { from: CODEX, body: "那你帮我灌进测试库" });
    await until(async () => prompts("渠道标签").length === 2);
    const second = prompts("渠道标签")[1];
    assert.equal(second.title, "我的 Codex 请你的 Claude 动手");
    assert.equal(second.body, "那你帮我灌进测试库");
    assert.equal(runner.calls.length, 1, "only the first question was answered in the background");
    answers[asked.indexOf(second)]("decline");
    await until(async () => (await client.getThread(t.id)).roundsUsed === 2);
    assert.equal(runner.judged.length, 2, "not judged again after the person said no");
  });

  test("a judgment that fails is 问答, and what the person chose is answered without judging again", async () => {
    startSidecar(["做法是先导出再灌"], [new Error("网络断了")]);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "怎么灌", message: "渠道标签怎么灌进去？" });
    await until(async () => prompts("怎么灌").length === 1);
    assert.equal(prompts("怎么灌")[0].mode, "answer");
    answers[asked.indexOf(prompts("怎么灌")[0])]("approve");
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);
    assert.equal(runner.judged.length, 1);
  });

  test("a judged 动手 the person turns into 问答 is answered in the background", async () => {
    startSidecar(["先导出 CSV，再用脚本灌"], ["do"]);
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "只要做法", message: "帮我把标签灌进测试库" });
    await until(async () => prompts("只要做法").length === 1);
    assert.equal(prompts("只要做法")[0].mode, "do");
    await client.approve(t.id, { mode: "answer" });
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.judged.length, 1);
  });
});

test("the asking AI only says what it wants: neither tool asks it to pick 问答 or 动手", async () => {
  const { relay, client } = await startTestRelay();
  try {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ connection: () => ({ client, agentId: CODEX, webUrl: relay.url, mode: "local" }) }).connect(serverSide);
    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(clientSide);
    const { tools } = await mcp.listTools();
    for (const name of ["send_request", "send_message"]) {
      const tool = tools.find((t) => t.name === name)!;
      assert.equal("mode" in (tool.inputSchema.properties ?? {}), false, `${name} has no mode`);
    }
    assert.match(tools.find((t) => t.name === "send_request")!.description!, /对方的电脑会判断是问答还是动手/);
  } finally {
    relay.close();
  }
});
