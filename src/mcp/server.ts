import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RelayClient, RelayClientError, type DeviceLinkTicket } from "../client.js";
import type { AgentConfig } from "../config.js";
import { isTerminal, STATUS_LABELS, type ThreadDetail } from "../types.js";

export interface McpConnection {
  client: RelayClient;
  agentId: string;
  webUrl: string;
  mode: "local" | "cloud";
}

export interface McpOptions {
  // Read on every tool call, so a computer that joins an account switches
  // over without restarting the AI client.
  connection: () => McpConnection;
  // Starts adding this computer to an account; see link_account. Without it
  // the tool is not offered (AIs that connect by address).
  link?: (server?: string) => Promise<DeviceLinkTicket>;
  // Offer review_pending, which approves through a dialog. Off for AIs that
  // connect by address: their credential cannot approve.
  review?: boolean;
  // How long a tool call waits for the other side before handing back a
  // thread id to check later.
  waitSeconds?: number;
}

function normalize(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function createMcpServer(opts: McpOptions): McpServer {
  const waitMs = (opts.waitSeconds ?? 540) * 1000;
  const server = new McpServer(
    { name: "achat", version: "0.0.1" },
    {
      instructions:
        "Achat 让你代表主人直接问别人的 AI，或主人自己的其他 AI。主人想问某人的 AI 时用 send_request；" +
        "不知道能问谁时先用 list_contacts；要加新的朋友时用 create_invite（有邮箱就填邮箱）。收到回复后，把原文完整转给主人。",
    },
  );

  async function nameOf(c: McpConnection, id: string | null): Promise<string> {
    if (!id) return "Achat";
    return (await c.client.agents()).find((a) => a.id === id)?.name ?? id;
  }

  async function resolveContact(c: McpConnection, to: string): Promise<AgentConfig> {
    const list = (await c.client.agents()).filter((a) => a.id !== c.agentId && a.canReceive !== false);
    const key = normalize(to);
    const exact = list.find((a) => a.id.toLowerCase() === key || normalize(a.name) === key);
    if (exact) return exact;
    const close = list.filter((a) => normalize(a.name).includes(key) || key.includes(normalize(a.name)));
    if (close.length === 1) return close[0];
    const options = (close.length ? close : list).map((a) => `${a.name}（${a.id}）`).join("、");
    if (close.length > 1) throw new Error(`「${to}」能对上好几个：${options}。请用完整的名字或 id`);
    if (!list.length) throw new Error("还没有可以联系的 AI。先用 create_invite 加对方为朋友（有邮箱就填邮箱）");
    throw new Error(`找不到联系人「${to}」。可以联系的有：${options}`);
  }

  // Waits until the other side has answered after `afterSeq` or the thread
  // ends, reporting progress so clients keep long calls alive.
  async function waitForReply(
    client: RelayClient,
    start: ThreadDetail,
    afterSeq: number,
    extra: { signal: AbortSignal; sendNotification: (n: any) => Promise<void>; _meta?: { progressToken?: string | number } },
  ): Promise<ThreadDetail> {
    const deadline = Date.now() + waitMs;
    const progressToken = extra._meta?.progressToken;
    let detail = start;
    let tick = 0;
    for (;;) {
      const replied = detail.messages.some((m) => m.seq > afterSeq && m.sender === detail.to);
      if (replied || isTerminal(detail.status) || Date.now() >= deadline || extra.signal.aborted) return detail;
      const lastSeq = detail.messages.at(-1)?.seq ?? afterSeq;
      detail = await client.wait(detail.id, lastSeq, Math.min(20_000, deadline - Date.now()), detail.status, extra.signal);
      tick += 1;
      if (progressToken !== undefined) {
        await extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress: tick, message: STATUS_LABELS[detail.status] },
          })
          .catch(() => {});
      }
    }
  }

  async function describeOutcome(c: McpConnection, detail: ThreadDetail, afterSeq: number): Promise<string> {
    const other = await nameOf(c, detail.to);
    const reply = detail.messages.filter((m) => m.seq > afterSeq && m.sender === detail.to).at(-1);
    const ended = detail.messages.filter((m) => m.seq > afterSeq && m.kind === "system").at(-1);
    const meta = `协作 ${detail.id}，第 ${detail.roundsUsed}/${detail.scope.maxRounds} 轮，已花费 ${money(detail.costUsd)}`;
    if (reply) {
      const lines = [`${other}的回复（${meta}）：`, "", reply.body, ""];
      if (reply.redactions > 0) lines.push(`（已自动过滤 ${reply.redactions} 处敏感信息）`);
      lines.push(
        "请把上面的回复完整转给主人：步骤、提示词、命令、路径照原文给出，不要压缩成摘要；你的理解或建议放在原文后面另外说。",
      );
      if (detail.status === "active") {
        lines.push(`要继续追问，用 send_message（thread_id: ${detail.id}）；问完了用 close_thread。`);
      } else {
        lines.push(`这次协作已经结束：${ended?.body ?? STATUS_LABELS[detail.status]}。`);
      }
      return lines.join("\n");
    }
    switch (detail.status) {
      case "declined":
        return `${other}的主人没有接受这个请求。`;
      case "stopped":
      case "closed":
        return `这次协作已经结束：${ended?.body ?? STATUS_LABELS[detail.status]}。`;
      case "pending":
        return `请求已发出，正在等${other}的主人批准（协作 ${detail.id}）。稍后用 check_thread 查看。`;
      default:
        return `${other}还在回复（协作 ${detail.id}）。稍后用 check_thread 查看。`;
    }
  }

  const guard =
    <A,>(fn: (args: A, extra: any) => Promise<ToolResult>) =>
    async (args: A, extra: any): Promise<ToolResult> => {
      try {
        return await fn(args, extra);
      } catch (err) {
        const message = err instanceof RelayClientError || err instanceof Error ? err.message : String(err);
        if ((err as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED") {
          return text("Achat 服务没有在运行。请让主人在终端运行 `achat start`。", true);
        }
        return text(message, true);
      }
    };

  server.registerTool(
    "list_contacts",
    {
      title: "列出 Achat 联系人",
      description: "列出你可以通过 Achat 联系的 AI，包括主人自己的其他 AI。",
      inputSchema: {},
    },
    guard(async () => {
      const c = opts.connection();
      const list = (await c.client.agents()).filter((a) => a.id !== c.agentId && a.canReceive !== false);
      const lines = list.map((a) => `${a.name}（${a.id}）`);
      if (c.mode === "cloud") {
        const asking = (await c.client.newFriends()).filter((f) => f.direction === "in" && f.status === "pending");
        if (asking.length) {
          lines.push("", `${asking.map((f) => f.name).join("、")}想加主人为朋友，要主人在 Achat 网页的“新的朋友”里接受：${c.webUrl}/#/contacts/new`);
        }
        lines.push("", "要加新的朋友，用 create_invite（有对方邮箱就填 email）。");
      } else {
        lines.push("", "要联系别人的 AI，先调用 link_account 把这台电脑加入主人的 Achat 账号。");
      }
      return text(lines.join("\n").trim());
    }),
  );

  server.registerTool(
    "send_request",
    {
      title: "向另一个 AI 发起协作",
      description:
        "通过 Achat 向另一个 AI 提问或请教，并等待它的回复。当主人想问别人的 AI、或自己的另一个 AI 某件事时使用，" +
        "例如“问问我的 Claude 上次的视频是怎么做的”。对方的主人要先批准，所以可能需要等一会儿。",
      inputSchema: {
        to: z.string().describe("对方 AI 的 id 或名字，例如 claude@local 或“我的 Claude”"),
        topic: z.string().max(80).describe("一句话的话题，例如“视频制作流程”"),
        message: z.string().describe("要问的完整问题，写清楚想要什么"),
      },
    },
    guard(async ({ to, topic, message }: { to: string; topic: string; message: string }, extra) => {
      const c = opts.connection();
      const contact = await resolveContact(c, to);
      const created = await c.client.createRequest({ from: c.agentId, to: contact.id, topic, message });
      const afterSeq = created.messages.find((m) => m.kind === "request")!.seq;
      const done = await waitForReply(c.client, created, afterSeq, extra);
      return text(await describeOutcome(c, done, afterSeq));
    }),
  );

  server.registerTool(
    "send_message",
    {
      title: "在协作里继续追问",
      description: "在已经开始的 Achat 协作里继续追问，并等待对方回复。",
      inputSchema: {
        thread_id: z.string().describe("协作 id"),
        message: z.string().describe("追问的内容"),
      },
    },
    guard(async ({ thread_id, message }: { thread_id: string; message: string }, extra) => {
      const c = opts.connection();
      const posted = await c.client.postMessage(thread_id, { from: c.agentId, body: message });
      const afterSeq = posted.messages.filter((m) => m.sender === c.agentId).at(-1)!.seq;
      const done = await waitForReply(c.client, posted, afterSeq, extra);
      return text(await describeOutcome(c, done, afterSeq));
    }),
  );

  server.registerTool(
    "check_thread",
    {
      title: "查看协作",
      description: "查看一次 Achat 协作的状态和全部对话。",
      inputSchema: { thread_id: z.string().describe("协作 id") },
    },
    guard(async ({ thread_id }: { thread_id: string }) => {
      const c = opts.connection();
      const t = await c.client.getThread(thread_id);
      const lines = [
        `协作 ${t.id}：${t.topic}（${STATUS_LABELS[t.status]}，第 ${t.roundsUsed}/${t.scope.maxRounds} 轮，已花费 ${money(t.costUsd)}）`,
        "",
      ];
      for (const m of t.messages) {
        lines.push(m.kind === "system" ? `— ${m.body}` : `${await nameOf(c, m.sender)}：${m.body}`);
      }
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "close_thread",
    {
      title: "结束协作",
      description: "问完了，结束这次 Achat 协作。",
      inputSchema: { thread_id: z.string().describe("协作 id") },
    },
    guard(async ({ thread_id }: { thread_id: string }) => {
      const c = opts.connection();
      await c.client.close(thread_id, c.agentId);
      return text(`协作 ${thread_id} 已结束。`);
    }),
  );

  // Approving through a dialog; AIs connected by address approve on the web instead.
  if (opts.review !== false) {
    server.registerTool(
      "review_pending",
      {
        title: "让主人批准待处理的请求",
        description:
          "当提示有 Achat 待批准请求时调用。Achat 会直接向主人弹出对话框，由主人同意或拒绝；" +
          "你看不到请求内容，只会知道处理结果。",
        inputSchema: {},
      },
      guard(async () => {
        const c = opts.connection();
        const client = c.client;
        const pending = await client.listThreads({ to: c.agentId, status: "pending", surfaced: true });
        if (!pending.length) return text("没有待批准的请求。");
        if (!server.server.getClientCapabilities()?.elicitation) {
          return text(`有 ${pending.length} 个待批准的请求。这个客户端不能弹出对话框，请让主人打开 ${c.webUrl} 批准。`);
        }
        let approved = 0;
        let declined = 0;
        let left = 0;
        for (const summary of pending) {
          const t = await client.getThread(summary.id);
          const request = t.messages.find((m) => m.kind === "request");
          const result = await server.server.elicitInput({
            mode: "form",
            message: [
              `${await nameOf(c, t.from)} · ${t.topic}`,
              "",
              request?.body ?? "",
              "",
              `同意后，${await nameOf(c, t.to)}只读本机对话记录来回答。提交表示同意，拒绝表示不接受，取消则留到以后处理。`,
            ].join("\n"),
            requestedSchema: {
              type: "object",
              properties: {
                maxRounds: {
                  type: "integer",
                  title: "最多轮数",
                  minimum: 1,
                  maximum: 20,
                  default: t.scope.maxRounds,
                },
                budgetUsd: {
                  type: "number",
                  title: "花费上限（美元）",
                  minimum: 0.1,
                  maximum: 50,
                  default: t.scope.budgetUsd,
                },
              },
            },
          });
          if (result.action === "accept") {
            const c = result.content ?? {};
            await client.approve(t.id, {
              maxRounds: typeof c.maxRounds === "number" ? c.maxRounds : undefined,
              budgetUsd: typeof c.budgetUsd === "number" ? c.budgetUsd : undefined,
            });
            approved += 1;
          } else if (result.action === "decline") {
            await client.decline(t.id);
            declined += 1;
          } else {
            left += 1;
          }
        }
        const parts = [`已同意 ${approved} 个`, `拒绝 ${declined} 个`];
        if (left) parts.push(`还有 ${left} 个留在 ${c.webUrl}`);
        return text(`${parts.join("，")}。同意的请求会在后台回答，不占用当前会话。`);
      }),
    );
  }

  server.registerTool(
    "create_invite",
    {
      title: "添加朋友",
      description:
        "加一个人为 Achat 朋友，成为朋友后双方的 AI 才能互相问。当主人说“加某人”“邀请某人”“我要和某人连上”时使用。" +
        "有对方的邮箱就填 email：对方已经在用 Achat 会收到好友请求，还没用会收到邀请邮件。" +
        "没有邮箱就不填，生成一个邀请链接让主人用微信等发给对方。接受只能由对方本人在网页上点。",
      inputSchema: {
        email: z.string().optional().describe("对方的邮箱，例如 lin@example.com；不知道就不填"),
      },
    },
    guard(async ({ email }: { email?: string }) => {
      const c = opts.connection();
      if (c.mode !== "cloud") {
        return text("这台电脑还没加入 Achat 账号，不能邀请别人。先调用 link_account，让主人登录并确认添加这台电脑。");
      }
      if (email) {
        const sent = await c.client.createInvite(email);
        if (sent.status === "accepted") {
          return text(`${sent.contact!.name}之前已经想加主人为朋友，现在你们已经是朋友了，可以直接用 send_request 问${sent.contact!.name}的 AI。`);
        }
        return text(
          sent.joined
            ? `已给 ${sent.email} 发了好友请求。对方在 Achat 上点“接受”后，你们的 AI 就能互相问；进展在网页的“新的朋友”里：${c.webUrl}/#/contacts/new`
            : `已给 ${sent.email} 发了邀请邮件。对方注册并接受后就是朋友；进展在网页的“新的朋友”里：${c.webUrl}/#/contacts/new`,
        );
      }
      const invite = await c.client.createInvite();
      return text(
        [`邀请链接：${invite.url}`, "", "请主人用微信等发给对方。对方打开后注册并点“接受”。链接 7 天内有效，只能用一次。"].join("\n"),
      );
    }),
  );

  // Only an AI running on this computer can add the computer to an account.
  if (opts.link) {
    server.registerTool(
      "link_account",
      {
        title: "把这台电脑加入 Achat 账号",
        description:
          "把这台电脑加入主人的 Achat 账号。和自己的其他 AI 沟通不需要；要邀请别人、或接受别人的邀请之前需要。" +
          "返回一个链接，主人在浏览器里打开、用邮箱登录并确认后生效。",
        inputSchema: {
          server: z.string().optional().describe("Achat 服务的地址，例如 https://achat.example.com；主人没提就不填"),
        },
      },
      guard(async ({ server: url }: { server?: string }) => {
        const c = opts.connection();
        if (c.mode === "cloud") return text(`这台电脑已经加入了 Achat 账号，可以直接用 create_invite 邀请别人。网页：${c.webUrl}`);
        if (!opts.link) return text("这个环境不能添加电脑，请让主人在终端运行 achat link。", true);
        const ticket = await opts.link(url);
        return text(
          [
            `请主人在浏览器打开：${ticket.url}`,
            "",
            `用邮箱登录后，确认页面上的配对码是 ${ticket.code}，一致再点确认。链接 10 分钟内有效。`,
            "确认后 Achat 会自动切换到账号模式，不用重启。",
          ].join("\n"),
        );
      }),
    );
  }

  return server;
}
