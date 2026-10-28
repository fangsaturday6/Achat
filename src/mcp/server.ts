import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RelayClient, RelayClientError } from "../client.js";
import type { AgentConfig } from "../config.js";
import { isTerminal, STATUS_LABELS, type ThreadDetail } from "../types.js";

export interface McpOptions {
  client: RelayClient;
  agentId: string;
  webUrl: string;
  // How long a tool call waits for the other side before handing back a
  // thread id to check later.
  waitSeconds?: number;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function createMcpServer(opts: McpOptions): McpServer {
  const { client, agentId } = opts;
  const waitMs = (opts.waitSeconds ?? 540) * 1000;
  const server = new McpServer({ name: "achat", version: "0.0.1" });

  let agentsCache: AgentConfig[] | null = null;
  const agents = async (): Promise<AgentConfig[]> => (agentsCache ??= await client.agents());
  const nameOf = async (id: string | null): Promise<string> =>
    id ? ((await agents()).find((a) => a.id === id)?.name ?? id) : "Achat";

  async function resolveContact(to: string): Promise<AgentConfig> {
    const list = (await agents()).filter((a) => a.id !== agentId);
    const key = to.trim().toLowerCase();
    const match =
      list.find((a) => a.id.toLowerCase() === key) ??
      list.find((a) => a.name.toLowerCase() === key) ??
      list.find((a) => a.name.toLowerCase().includes(key) || key.includes(a.client));
    if (!match) {
      throw new Error(`找不到联系人「${to}」。可以联系的有：${list.map((a) => `${a.name}（${a.id}）`).join("、")}`);
    }
    return match;
  }

  // Waits until the other side has answered after `afterSeq` or the thread
  // ends, reporting progress so clients keep long calls alive.
  async function waitForReply(
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

  async function describeOutcome(detail: ThreadDetail, afterSeq: number): Promise<string> {
    const other = await nameOf(detail.to);
    const reply = detail.messages.filter((m) => m.seq > afterSeq && m.sender === detail.to).at(-1);
    const ended = detail.messages.filter((m) => m.seq > afterSeq && m.kind === "system").at(-1);
    const meta = `协作 ${detail.id}，第 ${detail.roundsUsed}/${detail.scope.maxRounds} 轮，已花费 ${money(detail.costUsd)}`;
    if (reply) {
      const lines = [`${other}的回复（${meta}）：`, "", reply.body, ""];
      if (reply.redactions > 0) lines.push(`（已自动过滤 ${reply.redactions} 处敏感信息）`);
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
      const list = (await agents()).filter((a) => a.id !== agentId);
      return text(list.map((a) => `${a.name}（${a.id}）`).join("\n") || "还没有联系人。");
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
      const contact = await resolveContact(to);
      const created = await client.createRequest({ from: agentId, to: contact.id, topic, message });
      const afterSeq = created.messages.at(-1)!.seq;
      const done = await waitForReply(created, afterSeq, extra);
      return text(await describeOutcome(done, afterSeq));
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
      const posted = await client.postMessage(thread_id, { from: agentId, body: message });
      const afterSeq = posted.messages.filter((m) => m.sender === agentId).at(-1)!.seq;
      const done = await waitForReply(posted, afterSeq, extra);
      return text(await describeOutcome(done, afterSeq));
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
      const t = await client.getThread(thread_id);
      const lines = [
        `协作 ${t.id}：${t.topic}（${STATUS_LABELS[t.status]}，第 ${t.roundsUsed}/${t.scope.maxRounds} 轮，已花费 ${money(t.costUsd)}）`,
        "",
      ];
      for (const m of t.messages) {
        lines.push(m.kind === "system" ? `— ${m.body}` : `${await nameOf(m.sender)}：${m.body}`);
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
      await client.close(thread_id, agentId);
      return text(`协作 ${thread_id} 已结束。`);
    }),
  );

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
      const pending = await client.listThreads({ to: agentId, status: "pending", surfaced: true });
      if (!pending.length) return text("没有待批准的请求。");
      if (!server.server.getClientCapabilities()?.elicitation) {
        return text(`有 ${pending.length} 个待批准的请求。这个客户端不能弹出对话框，请让主人打开 ${opts.webUrl} 批准。`);
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
            `${await nameOf(t.from)} · ${t.topic}`,
            "",
            request?.body ?? "",
            "",
            `同意后，${await nameOf(t.to)}只读本机对话记录来回答。提交表示同意，拒绝表示不接受，取消则留到以后处理。`,
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
      if (left) parts.push(`还有 ${left} 个留在 ${opts.webUrl}`);
      return text(`${parts.join("，")}。同意的请求会在后台回答，不占用当前会话。`);
    }),
  );

  return server;
}
