import assert from "node:assert/strict";
import { after, afterEach, before, describe, mock, test } from "node:test";
import { RelayClientError } from "../src/client.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { BudgetExceededError, type AgentRunner, type RunInput, type RunOutput } from "../src/sidecar/runners.js";
import type { Choice, ChoicePrompt } from "../src/sidecar/dialog.js";
import { Sidecar, type SidecarOptions } from "../src/sidecar/sidecar.js";
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

  function sidecarFor(computer: typeof fangMac, agent: string, runner: AgentRunner, more: Partial<SidecarOptions> = {}): void {
    const sidecar = new Sidecar({ client: computer.client, agents: [], runners: { [agent]: runner }, notify: () => {}, webUrl: cloud.url, log: () => {}, ...more });
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

  // What everyone in the group sees under the @ when the answer fails.
  async function failedReason(name: string, error: Error): Promise<string> {
    const codex = wangLaptop.agent("codex");
    sidecarFor(wangLaptop, codex, {
      run: async () => {
        throw error;
      },
    });
    const g = await meeting(name);
    const asked = await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "@老王的 Codex 在吗", mentions: [codex] });
    const seq = asked.messages.at(-1).seq;
    const receipt = await until(async () => {
      const d: GroupDetail = await fang.call("GET", `/api/groups/${g.id}`);
      const r = d.messages.find((m) => m.seq === seq)!.receipts[0];
      return r.state === "failed" ? r : null;
    });
    return receipt.reason ?? "";
  }

  test("an answer over the $1 cap fails with a plain sentence, not the runner's error text", async () => {
    assert.equal(await failedReason("超预算", new BudgetExceededError("error_max_budget_usd")), "这次回答超过了 $1 的上限");
  });

  test("any other failure shows one short redacted line", async () => {
    const reason = await failedReason("出错", new Error(`  spawn failed at /Users/someone/.claude/x\nsecond line ${"很长".repeat(100)}`));
    assert.ok(!reason.includes("someone"), reason);
    assert.ok(!reason.includes("\n"), reason);
    assert.match(reason, /^spawn failed at ~\/\.claude\/x/);
    assert.ok(reason.length <= 120, String(reason.length));
  });

  test("a failure whose first lines are empty shows its first line with words", async () => {
    assert.equal(await failedReason("空行开头", new Error("\n  \n\t钱包连不上 /Users/someone/x\n后面的")), "钱包连不上 ~/x");
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

  // Says it need not reply every time, so only the 每天次数 count.
  const counting = (): AgentRunner => new ByPrompt(() => "无需回复：只是在数次数");

  // An AI is in the group with its computer on: its event stream is open,
  // so the computer hears what comes next.
  async function online(groupId: string, agent: string): Promise<void> {
    await until(async () => (await fang.call("GET", `/api/groups/${groupId}`)).members.find((m: any) => m.agent === agent)?.online);
  }

  // 老方's own AIs in a group of their own, their computers on.
  async function ownGroup(name: string, agents: string[]): Promise<GroupDetail> {
    const [first, ...others] = agents;
    const g = await fangMac.client.createGroup({ from: first, name, members: others.map((agent) => ({ agent })) });
    for (const agent of agents) await online(g.id, agent);
    return g;
  }

  // 老方 @s his AI `n` times; each wake uses one of its 每天次数.
  async function wake(groupId: string, agent: string, n: number): Promise<void> {
    for (let i = 1; i <= n; i++) await fang.call("POST", `/api/groups/${groupId}/messages`, { from: fangSeat, body: `第 ${i} 次`, mentions: [agent] });
  }

  test("with 5 of today's 30 left the person is asked once, 加 30 次 adds a day's more, and their other computer stays quiet", async () => {
    const claude = fangMac.agent("claude");
    const iMac = await addComputer(cloud, fang, "iMac", ["codex"]);
    const codex = iMac.agent("codex");
    const asked: ChoicePrompt[] = [];
    let pick!: (c: Choice) => void;
    sidecarFor(fangMac, claude, counting(), {
      choose: (prompt) => {
        asked.push(prompt);
        const answer = new Promise<Choice>((r) => (pick = r));
        return { answer, close: () => pick("stop") };
      },
    });
    // The same account's other computer hears the event too, and has no such AI.
    const elsewhere: string[] = [];
    sidecarFor(iMac, codex, counting(), {
      choose: (prompt) => {
        elsewhere.push(prompt.title);
        return null;
      },
      notify: (title) => elsewhere.push(title),
    });
    const g = await ownGroup("支付对接", [claude, codex]);

    await wake(g.id, claude, 25);
    await until(async () => asked.length === 1);
    assert.deepEqual(asked[0], { icon: "answer", title: "你的 Claude 在「支付对接」群今天还剩 5 次", body: "25 / 30 次", more: "加 30 次", stop: "用完就停" });
    pick("more");
    const mine = await until(async () => {
      const d: GroupDetail = await fang.call("GET", `/api/groups/${g.id}`);
      const m = d.members.find((x) => x.agent === claude)!;
      return m.extraToday === 30 ? m : null;
    });
    assert.deepEqual([mine.quota, mine.usedToday], [30, 25], "a day's more on top; the 每天次数 itself stays");
    assert.deepEqual(elsewhere, [], "nothing on the computer without that AI");
  });

  test("where no dialog can be shown a notification opens the group's settings, and a day asks once", async () => {
    const claude = fangMac.agent("claude");
    const told: string[][] = [];
    sidecarFor(fangMac, claude, counting(), { choose: () => null, notify: (title, body, url) => told.push([title, body, url]) });
    const g = await ownGroup("发版计划", [claude]);
    await fangMac.client.setGroupQuota(g.id, claude, 12);

    await wake(g.id, claude, 7);
    await until(async () => told.length === 1);
    assert.deepEqual(told[0], ["你的 Claude 在「发版计划」群今天还剩 5 次", "7 / 12 次", `${cloud.url}/#/g/${g.id}/settings`]);
    await wake(g.id, claude, 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(told.length, 1, "4 left asks nothing more today");
  });

  test("its own AI @ing the person, and an invite to a group, each show a notification that opens the group", async () => {
    const claude = fangMac.agent("claude");
    const codex = wangLaptop.agent("codex");
    const fangTold: string[][] = [];
    const wangTold: string[][] = [];
    sidecarFor(fangMac, claude, new ScriptedRunner([]), { notify: (title, body, url) => fangTold.push([title, body, url]) });
    sidecarFor(wangLaptop, codex, new ScriptedRunner([]), { notify: (title, body, url) => wangTold.push([title, body, url]) });
    const g = await meeting("支付对接");
    await online(g.id, claude);
    const page = `${cloud.url}/#/g/${g.id}`;

    const body = "@老方 微信商户号用哪家公司的营业执照，你来定";
    await fangMac.client.postGroupMessage(g.id, { from: claude, body, mentions: [fangSeat] });
    assert.deepEqual(await until(async () => fangTold.find(([, said]) => said.includes("营业执照"))), ["支付对接", `我的 Claude：${body}`, page]);
    const long = `@老方 ${"这句话很长".repeat(30)}`;
    await fangMac.client.postGroupMessage(g.id, { from: claude, body: long, mentions: [fangSeat] });
    assert.deepEqual(await until(async () => fangTold.find(([, said]) => said.includes("这句话很长"))), ["支付对接", `我的 Claude：${long.slice(0, 100)}`, page]);
    assert.ok(!wangTold.some(([, said]) => said.startsWith("我的 Claude")), "only 老方 is told");

    // 老方 starts another group on the web and invites 老王, whose computer is on.
    const later = await fang.call("POST", "/api/groups", { from: fangSeat, name: "发版计划", members: [{ agent: claude }, { account: wangId }] });
    const card = `${cloud.url}/#/g/${later.id}`;
    assert.deepEqual(await until(async () => wangTold.find(([, , url]) => url === card)), ["发版计划", "[待加入] 老方邀请你", card]);
    assert.ok(!fangTold.some(([, , url]) => url === card), "the one who invited is not told");
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
