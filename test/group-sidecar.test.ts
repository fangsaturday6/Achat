import assert from "node:assert/strict";
import { after, afterEach, before, describe, mock, test } from "node:test";
import { RelayClientError } from "../src/client.js";
import type { RunningCloud } from "../src/cloud/server.js";
import type { AgentRunner, RunInput, RunOutput } from "../src/sidecar/runners.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import type { GroupDetail } from "../src/types.js";
import { addComputer, type Browser, logIn, ScriptedRunner, startTestCloud, until, type MemoryMailer } from "./helpers.js";

async function befriend(a: Browser, b: Browser, bEmail: string): Promise<void> {
  await a.call("POST", "/api/invites", { email: bEmail });
  const request = (await b.call("GET", "/api/invites")).find((f: any) => f.direction === "in" && f.status === "pending");
  await b.call("POST", `/api/invites/${request.id}/accept`, {});
}

// Answers by what it read.
class ByPrompt implements AgentRunner {
  calls: RunInput[] = [];
  constructor(private pick: (prompt: string) => string) {}
  async run(input: RunInput): Promise<RunOutput> {
    this.calls.push(input);
    return { text: this.pick(input.prompt), sessionId: input.sessionId ?? `s${this.calls.length}`, costUsd: 0.02 };
  }
}

describe("an AI @ed in a group answers in the background", () => {
  let cloud: RunningCloud;
  let mailer: MemoryMailer;
  let fang: Browser;
  let wang: Browser;
  let fangMac: Awaited<ReturnType<typeof addComputer>>;
  let wangLaptop: Awaited<ReturnType<typeof addComputer>>;
  let fangSeat: string;
  let wangId: string;
  let sidecars: Sidecar[] = [];

  before(async () => {
    ({ cloud, mailer } = await startTestCloud());
    fang = await logIn(cloud, mailer, "fang@example.com", "老方");
    wang = await logIn(cloud, mailer, "wang@example.com", "老王");
    await befriend(fang, wang, "wang@example.com");
    fangMac = await addComputer(cloud, fang, "MacBook", ["claude"]);
    wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex"]);
    fangSeat = `p_${(await fang.call("GET", "/api/me")).account.id}`;
    wangId = (await wang.call("GET", "/api/me")).account.id;
  });
  after(() => cloud.close());
  afterEach(() => {
    for (const s of sidecars) s.stop();
    sidecars = [];
  });

  function sidecarFor(computer: typeof fangMac, agent: string, runner: AgentRunner): void {
    const sidecar = new Sidecar({ client: computer.client, agents: [], runners: { [agent]: runner }, notify: () => {}, webUrl: cloud.url, log: () => {} });
    sidecar.start();
    sidecars.push(sidecar);
  }

  // 老方's Claude starts a group with 老王's Codex in it, both computers on.
  async function meeting(name: string): Promise<GroupDetail> {
    const g = await fangMac.client.createGroup({ from: fangMac.agent("claude"), name, members: [{ account: wangId }] });
    const [invited] = (await wang.call("GET", "/api/groups")).filter((s: any) => s.id === g.id);
    await wang.call("POST", `/api/groups/${g.id}/invites/${invited.myInvite.id}/accept`, { agents: [wangLaptop.agent("codex")] });
    const codex = wangLaptop.agent("codex");
    await until(async () => (await fang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === codex)?.online);
    return fang.call("GET", `/api/groups/${g.id}`);
  }

  test("it reads the group, says something or that it need not, and calls others by name", async () => {
    const claude = fangMac.agent("claude");
    const codex = wangLaptop.agent("codex");
    const wangRunner = new ScriptedRunner(["订单和回调在我这边。@老方的 Claude 验签放哪？"]);
    const fangRunner = new ByPrompt((prompt) => (prompt.includes("验签放哪") ? "在网关统一验签" : "无需回复：是主人自己发起的"));
    sidecarFor(wangLaptop, codex, wangRunner);
    sidecarFor(fangMac, claude, fangRunner);
    const g = await meeting("支付对接");

    const asked = await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "@所有人 说说现状", mentions: ["all"] });
    const seq = asked.messages.at(-1).seq;
    const done = await until(async () => {
      const d: GroupDetail = await fang.call("GET", `/api/groups/${g.id}`);
      return d.messages.some((m) => m.sender === claude && m.body === "在网关统一验签") ? d : null;
    });
    const wangReply = done.messages.find((m) => m.sender === codex)!;
    assert.equal(wangReply.replyTo, seq);
    assert.deepEqual(wangReply.mentions, [claude]);
    assert.equal(done.messages.find((m) => m.sender === claude)!.replyTo, wangReply.seq);
    assert.equal(done.messages.find((m) => m.seq === seq)!.receipts.find((r) => r.agent === codex)!.state, "replied");
    assert.match(wangRunner.calls[0].prompt, /群里最近的消息/);
    assert.match(wangRunner.calls[0].prompt, /说说现状/);
    assert.match(wangRunner.calls[0].systemPrompt, /无需回复/);
    assert.equal(wangRunner.calls[0].budgetUsd, 1);
  });

  test("an answer that comes after 叫停 is not posted", async () => {
    const codex = wangLaptop.agent("codex");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let called = false;
    sidecarFor(wangLaptop, codex, {
      run: async () => {
        called = true;
        await gate;
        return { text: "晚到的回答", sessionId: "s", costUsd: 0 };
      },
    });
    const g = await meeting("叫停");
    const asked = await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "@老王的 Codex 在吗", mentions: [codex] });
    await until(async () => called);
    await fang.call("POST", `/api/groups/${g.id}/stop`, {});
    release();
    await new Promise((r) => setTimeout(r, 300));
    const d: GroupDetail = await fang.call("GET", `/api/groups/${g.id}`);
    assert.ok(!d.messages.some((m) => m.body === "晚到的回答"));
    assert.equal(d.messages.find((m) => m.seq === asked.messages.at(-1).seq)!.receipts[0].state, "stopped");
  });
});

test("a computer that updated before the cloud asks again in ten minutes, not never", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let beats = 0;
  const relay = {
    subscribe: () => () => {},
    beat: async () => {
      beats += 1;
      if (beats === 1) throw new RelayClientError(404, "没有这个接口");
    },
  };
  const sidecar = new Sidecar({ client: { patient: () => relay } as any, agents: [], runners: {}, notify: () => {}, webUrl: "http://x", log: () => {} });
  try {
    sidecar.start();
    await until(async () => beats === 1);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(beats, 1, "not after 30 seconds");
    mock.timers.tick(10 * 60_000);
    await until(async () => beats === 2);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(30_000);
    await until(async () => beats === 3);
  } finally {
    sidecar.stop();
    mock.timers.reset();
  }
});
