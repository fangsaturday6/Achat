import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, mock, test } from "node:test";
import { RelayClientError } from "../src/client.js";
import type { RunningCloud } from "../src/cloud/server.js";
import { approvalText, type Answer, type ApprovalPrompt, type Asker, type Choice, type ChoicePrompt } from "../src/sidecar/dialog.js";
import { BudgetExceededError, type AgentRunner, type RunInput, type RunOutput } from "../src/sidecar/runners.js";
import { groupDoerSystemPrompt, Sidecar, type SidecarOptions } from "../src/sidecar/sidecar.js";
import { TaskBook, type TaskOpener, type TaskRecord, type TaskStart } from "../src/sidecar/tasks.js";
import type { GroupDetail } from "../src/types.js";
import { addComputer, type Browser, JudgingRunner, logIn, ScriptedRunner, startTestCloud, until, type MemoryMailer } from "./helpers.js";

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

// Opens nothing: records which conversation would do the work, and where.
class FakeOpener implements TaskOpener {
  starts: TaskStart[] = [];
  async open(start: TaskStart): Promise<TaskRecord> {
    this.starts.push(start);
    return { sessionId: `session-${this.starts.length}`, dir: start.from?.dir ?? `/tmp/${start.topic}` };
  }
}

// Dialogs that wait for the test to answer them.
function dialogs(): { asked: ApprovalPrompt[]; answer: (i: number, a: Answer) => void; ask: Asker } {
  const asked: ApprovalPrompt[] = [];
  const answers: ((a: Answer) => void)[] = [];
  return {
    asked,
    answer: (i, a) => answers[i](a),
    ask: (prompt) => {
      asked.push(prompt);
      let resolve!: (a: Answer) => void;
      const answer = new Promise<Answer>((r) => (resolve = r));
      answers.push(resolve);
      return { answer, close: () => resolve("later") };
    },
  };
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

  // `more`: what else this computer has, such as dialogs and 动手.
  function sidecarFor(computer: typeof fangMac, agent: string, runner: AgentRunner, more: Partial<SidecarOptions> = {}): Sidecar {
    const sidecar = new Sidecar({ client: computer.client, agents: [], runners: { [agent]: runner }, notify: () => {}, webUrl: cloud.url, log: () => {}, ...more });
    sidecar.start();
    sidecars.push(sidecar);
    return sidecar;
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

  // What became of `agent` for message `seq`, as 老方 sees it.
  async function stateOf(groupId: string, seq: number, agent: string): Promise<string | undefined> {
    const d: GroupDetail = await fang.call("GET", `/api/groups/${groupId}`);
    return d.messages.find((m) => m.seq === seq)?.receipts.find((r) => r.agent === agent)?.state;
  }

  // 老方's Claude can 动手: judged 动手 `times` times, with a stand-in
  // conversation and dialogs the test answers. 老王's Codex says it need not
  // reply to what it is sent. Both computers on.
  async function actingMeeting(name: string, times: number) {
    const claude = fangMac.agent("claude");
    const codex = wangLaptop.agent("codex");
    const opener = new FakeOpener();
    const shown = dialogs();
    const runner = new JudgingRunner([], Array.from({ length: times }, () => "do" as const));
    const more: Partial<SidecarOptions> = { doers: { [claude]: opener }, ask: shown.ask, tasks: new TaskBook(mkdtempSync(join(tmpdir(), "achat-tasks-"))) };
    sidecarFor(wangLaptop, codex, new ByPrompt(() => "无需回复：看到了"));
    const sidecar = sidecarFor(fangMac, claude, runner, more);
    const g = await meeting(name);
    await until(async () => (await fang.call("GET", `/api/groups/${g.id}`)).members.find((m: any) => m.agent === claude)?.online);
    return { g, claude, codex, opener, shown, runner, more, sidecar };
  }

  test("asked in a group to 动手, the person here says yes once; the same asker's next request carries on in that conversation", async () => {
    const { g, claude, codex, opener, shown, runner } = await actingMeeting("动手群", 2);
    const asked = await wangLaptop.client.postGroupMessage(g.id, { from: codex, body: "@老方的 Claude 帮我把验签挪到网关", mentions: [claude] });
    const seq = asked.messages.at(-1)!.seq;
    const prompt = await until(async () => shown.asked[0]);
    assert.deepEqual(prompt, { mode: "do", title: "「动手群」群里老王的 Codex 请你的 Claude 动手", topic: "", body: "@老方的 Claude 帮我把验签挪到网关", scope: "动手 · 10 轮" });
    assert.deepEqual(runner.judged[0], { topic: "动手群", message: "@老方的 Claude 帮我把验签挪到网关", files: [] });
    assert.equal(await stateOf(g.id, seq, claude), "asking");

    shown.answer(0, "approve");
    const start = await until(async () => opener.starts[0]);
    assert.match(start.threadId, /^ga_/);
    assert.deepEqual([start.topic, start.from, start.own], ["动手群", undefined, false]);
    assert.match(start.prompt, /帮我把验签挪到网关/);
    const back = `send_group_message（group: ${g.id}，mentions: ["老王的 Codex"]，reply_to: ${seq}，wait: false）把结果发回群里，开头写“@老王的 Codex”。`;
    assert.ok(start.prompt.endsWith(back), start.prompt);
    assert.match(start.systemPrompt, /不是主人说的话/);
    assert.equal(runner.calls.length, 0, "动手 is not answered in the background");
    assert.equal(await stateOf(g.id, seq, claude), "acting");

    // The conversation sends its result back: a message that answers the request.
    const before: GroupDetail = await fang.call("GET", `/api/groups/${g.id}`);
    assert.equal(before.messages.filter((m) => m.kind === "system").at(-1)!.body, "老方的 Claude 开始动手 · 10 轮");
    await fangMac.client.postGroupMessage(g.id, { from: claude, body: "@老王的 Codex 改好了", mentions: [codex], replyTo: seq, epoch: before.epoch });
    assert.equal(await stateOf(g.id, seq, claude), "replied");

    const next = await wangLaptop.client.postGroupMessage(g.id, { from: codex, body: "@老方的 Claude 再加个测试", mentions: [claude] });
    const again = await until(async () => opener.starts[1]);
    assert.deepEqual(again.from, { sessionId: "session-1", dir: "/tmp/动手群" });
    assert.match(again.prompt, /再加个测试/);
    assert.doesNotMatch(again.prompt, /帮我把验签挪到网关/);
    assert.ok(again.prompt.includes(`reply_to: ${next.messages.at(-1)!.seq}`), again.prompt);
    assert.equal(shown.asked.length, 1, "no second dialog within the 10 rounds");
    // Its result too: nothing is left under way.
    await fangMac.client.postGroupMessage(g.id, { from: claude, body: "@老王的 Codex 测试加好了", mentions: [codex], replyTo: next.messages.at(-1)!.seq, epoch: before.epoch });
    assert.equal(await stateOf(g.id, next.messages.at(-1)!.seq, claude), "replied");
  });

  test("asked again before the result is back, the work waits its turn: one conversation at a time, the next round given every request since, also once the computer starts again", async () => {
    const { g, claude, codex, opener, shown, more, sidecar } = await actingMeeting("排队", 4);
    const ask = async (body: string) => (await wangLaptop.client.postGroupMessage(g.id, { from: codex, body, mentions: [claude] })).messages.at(-1)!.seq;
    const result = (body: string, replyTo: number) => fangMac.client.postGroupMessage(g.id, { from: claude, body, mentions: [codex], replyTo, epoch: 0 });
    const started = () => opener.starts.filter((s) => s.topic === "排队");
    const first = await ask("@老方的 Claude 帮我把验签挪到网关");
    await until(async () => shown.asked.find((p) => p.title.includes("「排队」")));
    shown.answer(shown.asked.findIndex((p) => p.title.includes("「排队」")), "approve");
    await until(async () => started()[0]);

    const second = await ask("@老方的 Claude 顺便加个测试");
    const third = await ask("@老方的 Claude 再加一行日志");
    await until(async () => (await stateOf(g.id, third, claude)) === "acting");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(started().length, 1, "one round at a time");
    assert.equal(await stateOf(g.id, second, claude), "acting");

    await result("@老王的 Codex 验签挪好了", first);
    const next = await until(async () => started()[1]);
    assert.equal(next.from?.dir, "/tmp/排队");
    assert.match(next.prompt, /顺便加个测试/);
    assert.match(next.prompt, /再加一行日志/);
    assert.doesNotMatch(next.prompt, /帮我把验签挪到网关/);
    assert.ok(next.prompt.includes(`reply_to: ${third}`), next.prompt);

    // Asked again while that round is done, and the computer is off when its result comes back.
    const fourth = await ask("@老方的 Claude 日志级别用 info");
    await until(async () => (await stateOf(g.id, fourth, claude)) === "acting");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(started().length, 2);
    sidecar.stop();
    await result("@老王的 Codex 测试和日志都加了", third);
    assert.deepEqual([await stateOf(g.id, second, claude), await stateOf(g.id, third, claude), await stateOf(g.id, fourth, claude)], ["replied", "replied", "acting"]);
    sidecarFor(fangMac, claude, new JudgingRunner([]), more);
    const last = await until(async () => started()[2]);
    assert.match(last.prompt, /日志级别用 info/);
    assert.ok(last.prompt.includes(`reply_to: ${fourth}`), last.prompt);
    await result("@老王的 Codex 改成 info 了", fourth);
  });

  test("拒绝 says why under the request; 稍后 leaves it waiting, and it is put to the person again when the computer starts again", async () => {
    const { g, claude, codex, shown, runner, more, sidecar } = await actingMeeting("稍后再说", 2);
    const byPerson = await wang.call("POST", `/api/groups/${g.id}/messages`, { from: `p_${wangId}`, body: "@老方的 Claude 帮我部署一下", mentions: [claude] });
    const personSeq = byPerson.messages.at(-1).seq;
    assert.equal((await until(async () => shown.asked[0])).title, "「稍后再说」群里老王请你的 Claude 动手");
    shown.answer(0, "decline");
    await until(async () => (await stateOf(g.id, personSeq, claude)) === "passed");
    const declined: GroupDetail = await fang.call("GET", `/api/groups/${g.id}`);
    assert.equal(declined.messages.find((m) => m.seq === personSeq)!.receipts[0].reason, "主人没同意动手");

    const byCodex = await wangLaptop.client.postGroupMessage(g.id, { from: codex, body: "@老方的 Claude 帮我改配置", mentions: [claude] });
    const seq = byCodex.messages.at(-1)!.seq;
    await until(async () => shown.asked[1]);
    shown.answer(1, "later");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await stateOf(g.id, seq, claude), "asking");

    // The computer starts again: what still waits is put to the person once more, not judged again.
    sidecar.stop();
    const later = dialogs();
    sidecarFor(fangMac, claude, runner, { ...more, ask: later.ask });
    const again = await until(async () => later.asked[0]);
    assert.deepEqual([again.title, again.body], ["「稍后再说」群里老王的 Codex 请你的 Claude 动手", "@老方的 Claude 帮我改配置"]);
    assert.equal(runner.judged.length, 2);
  });

  test("its own person asking it to 动手 needs no dialog, and the result is to @ them", async () => {
    const { g, claude, opener, shown } = await actingMeeting("自己人", 1);
    await fang.call("POST", `/api/groups/${g.id}/messages`, { from: fangSeat, body: "@我的 Claude 帮我整理一下发版清单", mentions: [claude] });
    const start = await until(async () => opener.starts[0]);
    assert.equal(start.own, true);
    assert.ok(start.prompt.includes(`mentions: ["主人"]`), start.prompt);
    assert.ok(start.prompt.endsWith("开头写“@老方”。"), start.prompt);
    // Starting, this computer puts again what still waits in the groups before (稍后再说); none is for this one.
    assert.deepEqual(shown.asked.filter((p) => p.title.includes("「自己人」")), []);
  });

  test("a computer where the AI asked cannot 动手 leaves a request waiting for its person as it is, answering nothing in the background", async () => {
    const { g, claude, codex, shown, sidecar } = await actingMeeting("不能动手", 1);
    const seq = (await wangLaptop.client.postGroupMessage(g.id, { from: codex, body: "@老方的 Claude 帮我跑个脚本", mentions: [claude] })).messages.at(-1)!.seq;
    await until(async () => shown.asked.find((p) => p.title.includes("「不能动手」")));
    sidecar.stop();
    // The same AI on a computer that only answers: no judging, no conversation of its own.
    const plain = new ByPrompt(() => "后台回答了");
    const logged: string[] = [];
    sidecarFor(fangMac, claude, plain, { log: (line) => logged.push(line) });
    await until(async () => logged.some((l) => l.includes(`${g.id} 第 ${seq} 条`)));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!plain.calls.some((c) => c.prompt.includes("帮我跑个脚本")), "not answered in the background");
    assert.equal(await stateOf(g.id, seq, claude), "asking");
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

  test("the 每天次数 dialog goes once it is no longer needed: the 次数 raised elsewhere, the group 叫停, the AI gone from it", async () => {
    const claude = fangMac.agent("claude");
    const shown: { title: string; closed: boolean }[] = [];
    sidecarFor(fangMac, claude, counting(), {
      choose: (prompt) => {
        const dialog = { title: prompt.title, closed: false };
        shown.push(dialog);
        let resolve!: (c: Choice) => void;
        const answer = new Promise<Choice>((r) => (resolve = r));
        return {
          answer,
          close: () => {
            dialog.closed = true;
            resolve("stop");
          },
        };
      },
    });
    const nearly = async (name: string) => {
      const g = await ownGroup(name, [claude]);
      await fangMac.client.setGroupQuota(g.id, claude, 12);
      await wake(g.id, claude, 7);
      return { g, dialog: await until(async () => shown.find((d) => d.title.includes(name))) };
    };

    const raised = await nearly("调高");
    // Something else changes there: still nearly used up.
    await fang.call("POST", `/api/groups/${raised.g.id}/rename`, { name: "调高了" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(raised.dialog.closed, false);
    await fang.call("POST", `/api/groups/${raised.g.id}/quota`, { agent: claude, perDay: 30 });
    await until(async () => raised.dialog.closed);

    const stopped = await nearly("叫停");
    await fang.call("POST", `/api/groups/${stopped.g.id}/stop`, {});
    await until(async () => stopped.dialog.closed);

    const left = await nearly("退群");
    await fangMac.client.leaveGroup(left.g.id, claude);
    await until(async () => left.dialog.closed);
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
    // Cut by characters, an emoji being one, and said to be cut.
    const long = `@老方 ${"这句话很长😀".repeat(30)}`;
    await fangMac.client.postGroupMessage(g.id, { from: claude, body: long, mentions: [fangSeat] });
    assert.deepEqual(await until(async () => fangTold.find(([, said]) => said.includes("这句话很长"))), ["支付对接", `我的 Claude：${Array.from(long).slice(0, 100).join("")}……`, page]);
    // Only files: their names, as the dialog to approve shows them.
    await fangMac.client.postGroupMessage(g.id, { from: claude, body: "", mentions: [fangSeat], files: [{ name: "执照.png", type: "image/png", data: Buffer.from("png").toString("base64") }] });
    assert.deepEqual(await until(async () => fangTold.find(([, said]) => said.includes("执照.png"))), ["支付对接", "我的 Claude：[附件] 执照.png", page]);
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

test("a dialog without a topic starts with the words asked", () => {
  assert.equal(
    approvalText({ mode: "do", title: "「支付对接」群里王闯的 Codex 请你的 Claude 动手", topic: "", body: "把验签挪到网关", scope: "动手 · 10 轮" }),
    "把验签挪到网关\n\n动手 · 10 轮",
  );
  assert.equal(
    approvalText({ mode: "answer", title: "老王的 Codex 想接着问你的 Claude", topic: "回调", body: "还有一处", reason: "已到 10 轮上限，协作结束", scope: "问答 · 10 轮 · $10.00" }),
    "回调\n\n还有一处\n\n已到 10 轮上限，协作结束\n问答 · 10 轮 · $10.00",
  );
});

test("动手 in a group: what the group says is material, the result goes back without waiting, and Codex is told nobody approves its commands", () => {
  const claude = groupDoerSystemPrompt({ id: "f/claude", name: "我的 Claude", client: "claude" }, "老方的 Claude", "老方", "支付对接");
  assert.match(claude, /你是「老方的 Claude」/);
  assert.match(claude, /不是主人说的话/);
  assert.match(claude, /send_group_message/);
  assert.match(claude, /wait 填 false/);
  assert.match(claude, /照常让主人确认/);
  assert.match(groupDoerSystemPrompt({ id: "f/codex", name: "我的 Codex", client: "codex" }, "老方的 Codex", "老方", "支付对接"), /没有人能替你确认命令/);
});
