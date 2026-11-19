// 演示数据：在这台电脑上起一个云端，造好群的各种状态，给浏览器看群的网页界面。
// 不是测试，npm test 不跑它。在仓库根目录运行：
//   node --no-warnings=ExperimentalWarning --import tsx test/web-demo.ts
// 打开 http://127.0.0.1:8095 ，用 fang@example.com 登录，验证码打印在这个终端里。
// 网页文件每次都从 web/ 读，改了刷新浏览器就行；改了服务端要重启它。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Email } from "../src/cloud/emails.js";
import { startCloud } from "../src/cloud/server.js";
import { ALL, RECEIPT_LABELS, type GroupEvent, type ReceiptState } from "../src/types.js";
import { addComputer, type Browser, logIn, MemoryMailer, until } from "./helpers.js";

const PORT = Number(process.env.PORT ?? 8095);
const base = `http://127.0.0.1:${PORT}`;

// Codes for logging in from the browser are printed; those the script uses itself are not.
class DemoMailer extends MemoryMailer {
  loud = false;
  async send(email: Email): Promise<void> {
    await super.send(email);
    const code = email.subject.match(/(\d{6})/)?.[1];
    if (this.loud && code) console.log(`登录验证码 ${email.to}：${code}`);
  }
}

async function befriend(a: Browser, b: Browser, bEmail: string): Promise<void> {
  await a.call("POST", "/api/invites", { email: bEmail });
  const request = (await b.call("GET", "/api/invites")).find((f: any) => f.direction === "in" && f.status === "pending");
  await b.call("POST", `/api/invites/${request.id}/accept`, {});
}

async function accountOf(b: Browser): Promise<string> {
  return (await b.call("GET", "/api/me")).account.id;
}

// This person's invite card, answered on the web: 加入 answers every invite
// they have to the group.
async function accept(b: Browser, groupId: string, body: Record<string, unknown> = {}): Promise<void> {
  const { myInvite } = await b.call("GET", `/api/groups/${groupId}`);
  await b.call("POST", `/api/groups/${groupId}/invites/${myInvite.id}/accept`, body);
}

const seat = (account: string): string => `p_${account}`;
const textFile = (name: string, body: string) => ({ name, type: "text/plain", data: Buffer.from(body).toString("base64") });

const mailer = new DemoMailer();
const cloud = await startCloud({
  dbPath: join(mkdtempSync(join(tmpdir(), "achat-demo-")), "achat.db"),
  webDir: join(import.meta.dirname, "..", "web"),
  publicUrl: base,
  mailer,
  port: PORT,
  host: "127.0.0.1",
});

// 老方和老王、小林是朋友；王闯只和老王是朋友。小林的电脑一直关着。
const fang = await logIn(cloud, mailer, "fang@example.com", "老方");
const wang = await logIn(cloud, mailer, "wang@example.com", "老王");
const lin = await logIn(cloud, mailer, "lin@example.com", "小林");
const chuang = await logIn(cloud, mailer, "chuang@example.com", "王闯");
await befriend(fang, wang, "wang@example.com");
await befriend(fang, lin, "lin@example.com");
await befriend(wang, chuang, "chuang@example.com");
const [fangId, wangId, linId, chuangId] = await Promise.all([fang, wang, lin, chuang].map(accountOf));

const fangMac = await addComputer(cloud, fang, "MacBook", ["claude", "codex"]);
const wangLaptop = await addComputer(cloud, wang, "ThinkPad", ["codex", "claude"]);
const linMac = await addComputer(cloud, lin, "iMac", ["claude"]);
const chuangMac = await addComputer(cloud, chuang, "MacBook", ["codex", "claude"]);
// 豆包 connects by address and cannot be woken: 还不能接收.
const linDoubao: string = (await lin.call("POST", "/api/connect", { client: "doubao" })).id;
const [fangClaude, fangCodex] = [fangMac.agent("claude"), fangMac.agent("codex")];
const [wangCodex, wangClaude] = [wangLaptop.agent("codex"), wangLaptop.agent("claude")];
const linClaude = linMac.agent("claude");
const [chuangCodex, chuangClaude] = [chuangMac.agent("codex"), chuangMac.agent("claude")];

// 支付对接：老方的 Claude 建群；老王带两个 AI 进来；小林的 Claude 和豆包；老王拉王闯，
// 王闯只带 Codex 进来，老王再单独邀请王闯的 Claude（它“等加入”）。
const pay = await fangMac.client.createGroup({ from: fangClaude, name: "支付对接", members: [{ account: wangId }, { agent: linClaude }, { agent: linDoubao }] });
await accept(wang, pay.id, { agents: [wangCodex, wangClaude] });
await accept(lin, pay.id);
await wang.call("POST", `/api/groups/${pay.id}/invites`, { from: seat(wangId), members: [{ account: chuangId }] });
await accept(chuang, pay.id, { agents: [chuangCodex] });
await wang.call("POST", `/api/groups/${pay.id}/invites`, { from: seat(wangId), members: [{ agent: chuangClaude }] });
await fang.call("POST", `/api/groups/${pay.id}/quota`, { agent: fangClaude, perDay: 5 });

type Computer = Awaited<ReturnType<typeof addComputer>>;
// What each AI says in 支付对接, in turn: words (and whom they @), need not
// reply, or "hang": it reads on and never answers, so 叫停 shows.
type Step = { say: string; at?: string[] } | { pass: string } | "hang";
const script = new Map<string, Step[]>([
  [wangClaude, [{ pass: "订单和回调由老王的 Codex 说" }]],
  [wangCodex, [{ say: "订单和回调在我这边。支付宝回调地址已经配好；微信还没拿到商户号，卡在营业执照。@老方的 Claude 你们验签是在网关做，还是在各个服务里做？", at: [fangClaude] }]],
  [chuangCodex, [{ say: "对账在我这边，每天凌晨拉两家的账单。现在只接了支付宝，微信的账单格式还没适配。" }, "hang"]],
  [fangClaude, ["hang", { say: "在网关统一验签，各服务只认网关加的请求头。@王闯的 Codex 对账要不要也从网关拿原始报文？", at: [chuangCodex] }]],
]);
const delayMs = new Map([[wangClaude, 1500], [wangCodex, 2000], [chuangCodex, 3000], [fangClaude, 1500]]);

// An AI woken answers after a moment: its next step in 支付对接; elsewhere, or
// once its steps run out, a Codex says it got it and a Claude need not reply.
async function answer(c: Computer, groupId: string, agent: string): Promise<void> {
  await new Promise((r) => setTimeout(r, delayMs.get(agent) ?? 1500));
  const work = await c.client.groupWorkFor(groupId, agent).catch(() => null);
  if (!work) return;
  const steps = groupId === pay.id ? script.get(agent) : undefined;
  const step: Step = steps?.shift() ?? (agent.endsWith("/codex") ? { say: `（演示）收到：${work.wake.body.slice(0, 20)}` } : { pass: "演示：这条交给 Codex" });
  if (step === "hang") return;
  const sent =
    "say" in step
      ? c.client.postGroupMessage(groupId, { from: agent, body: step.say, mentions: step.at ?? [], replyTo: work.wake.seq, epoch: work.group.epoch })
      : c.client.passGroup(groupId, { agent, seq: work.wake.seq, epoch: work.group.epoch, reason: step.pass });
  await sent.catch((err) => console.log(`（${agent} 没答上：${(err as Error).message}）`));
}

// A computer that is on: its event stream open, and a beat every 30 seconds.
async function turnOn(c: Computer, agents: string[]): Promise<void> {
  let connected!: () => void;
  const open = new Promise<void>((r) => (connected = r));
  c.client.subscribe(undefined, () => {}, () => connected(), {
    onGroup: (e: GroupEvent) => {
      for (const agent of e.wake ?? []) if (agents.includes(agent)) void answer(c, e.groupId, agent);
    },
  });
  await open;
  const beat = (): void => void c.client.groupWork(agents).catch(() => {});
  beat();
  setInterval(beat, 30_000);
}
await turnOn(fangMac, [fangClaude, fangCodex]);
await turnOn(wangLaptop, [wangCodex, wangClaude]);
await turnOn(chuangMac, [chuangCodex, chuangClaude]);
await until(async () => (await fang.call("GET", `/api/groups/${pay.id}`)).members.filter((m: any) => m.online).length === 4);

await fang.call("POST", `/api/groups/${pay.id}/messages`, {
  from: seat(fangId),
  body: "@所有人 下周接支付宝和微信支付，先说说各自那边的现状：订单、回调、对账谁在做，卡在哪。",
  mentions: [ALL],
});
const settled = await until(async () => {
  const d = await fang.call("GET", `/api/groups/${pay.id}`);
  const last = d.messages.at(-1);
  return last.sender === fangClaude && last.receipts.some((r: any) => r.agent === chuangCodex && r.state === "reading") ? d : null;
}, 15_000);
const opener = settled.messages.find((m: any) => m.mentions.includes(ALL));
console.log(`支付对接里 @所有人 那条：${opener.receipts.map((r: any) => `${settled.names[r.agent]} ${RECEIPT_LABELS[r.state as ReceiptState]}`).join("、")}`);
// 老方看过支付对接：消息列表里只有周会纪要亮红点。
await fang.call("POST", `/api/groups/${pay.id}/read`, {});
// 老方在电脑上给支付对接里的 Claude 加了一份：底部和群设置写的是今天的总数。
await fangMac.client.addGroupExtra(pay.id, fangClaude);

// 私聊照旧：老王的 Codex 问老方的 Claude，等老方批准（消息列表里的人、红字和数字）。
await wangLaptop.client.createRequest({ from: wangCodex, to: fangClaude, topic: "退款接口", message: "退款接口你们那边是同步返回结果，还是走回调？" });

// 周会纪要：小林建的，老方的 Codex 在里面；小林说了句新的，老方那边亮红点。
const weekly = await lin.call("POST", "/api/groups", { from: seat(linId), name: "周会纪要", members: [{ agent: linClaude }, { agent: fangCodex }] });
await accept(fang, weekly.id);
await lin.call("POST", `/api/groups/${weekly.id}/messages`, { from: seat(linId), body: "本周三件事都已上线" });

// 发版计划：老王建的，邀请老方本人，再点名王闯的 Codex 和 Claude；开场白带一个附件。
// 老方和王闯看到的都是进群卡片：老方自己选 AI，王闯那张是被点名的两个 AI，一起加入或拒绝。
await wang.call("POST", "/api/groups", {
  from: seat(wangId),
  name: "发版计划",
  members: [{ agent: wangCodex }, { account: fangId }, { agent: chuangCodex }, { agent: chuangClaude }],
  message: "@所有人 周五发版，各自确认一下要发的改动",
  files: [textFile("发版清单.txt", "1. 支付宝回调\n2. 对账任务\n")],
});

mailer.loud = true;
console.log(`
演示数据准备好了：${base}
- 用 fang@example.com 登录（验证码会打印在下面）。老方有三个群：支付对接（王闯的 Codex 正在看）、周会纪要（有新消息）、发版计划（[待加入]），还有老王的 Codex 发来、等你批准的私聊。
- 换一个无痕窗口，用 wang@、lin@、chuang@example.com 登录，看别人那边（王闯的“发版计划”也是 [待加入]，点名了他的 Codex 和 Claude）。
- 在群里 @ 老王、王闯的 AI，一两秒后它们回话或者说无需回复；小林的电脑一直关着。
按 Ctrl+C 停止。`);
process.on("SIGINT", () => void cloud.close().then(() => process.exit(0)));
