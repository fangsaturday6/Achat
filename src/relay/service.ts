import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AchatConfig, AgentConfig } from "../config.js";
import {
  isTerminal,
  type Message,
  type RelayEvent,
  type Scope,
  type Thread,
  type ThreadDetail,
  type ThreadStatus,
  type ThreadSummary,
} from "../types.js";
import type { Store } from "./store.js";

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clampScope(scope: Partial<Scope> | undefined, defaults: Scope): Scope {
  const maxRounds = Math.round(Number(scope?.maxRounds ?? defaults.maxRounds));
  const budgetUsd = Number(scope?.budgetUsd ?? defaults.budgetUsd);
  if (!Number.isFinite(maxRounds) || maxRounds < 1 || maxRounds > 20) {
    throw new RelayError(400, "轮数需要在 1 到 20 之间");
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0.1 || budgetUsd > 50) {
    throw new RelayError(400, "花费上限需要在 $0.10 到 $50 之间");
  }
  return { maxRounds, budgetUsd: Math.round(budgetUsd * 100) / 100 };
}

export interface CreateRequestInput {
  from: string;
  to: string;
  topic: string;
  message: string;
}

export interface PostMessageInput {
  from: string;
  body: string;
  costUsd?: number;
  redactions?: number;
  sessionId?: string;
}

// Owns the thread state machine. Every state change goes through here so the
// HTTP API, the sidecar and the MCP tools see the same rules.
export class RelayService {
  private events = new EventEmitter();
  private agents: Map<string, AgentConfig>;

  constructor(
    private store: Store,
    private config: AchatConfig,
    private now: () => Date = () => new Date(),
  ) {
    this.agents = new Map(config.agents.map((a) => [a.id, a]));
    this.events.setMaxListeners(0);
  }

  listAgents(): AgentConfig[] {
    return [...this.agents.values()];
  }

  agentName(id: string | null): string {
    if (!id) return "Achat";
    return this.agents.get(id)?.name ?? id;
  }

  onEvent(listener: (e: RelayEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private emit(type: RelayEvent["type"], thread: Thread, msg?: Message): void {
    const event: RelayEvent = {
      type,
      threadId: thread.id,
      status: thread.status,
      from: thread.from,
      to: thread.to,
      quiet: thread.quiet,
    };
    if (msg) {
      event.sender = msg.sender;
      event.seq = msg.seq;
    }
    this.events.emit("event", event);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private requireThread(id: string): Thread {
    const thread = this.store.getThread(id);
    if (!thread) throw new RelayError(404, "找不到这次协作");
    return thread;
  }

  private requireAgent(id: string): AgentConfig {
    const agent = this.agents.get(id);
    if (!agent) throw new RelayError(400, `不认识的 AI：${id}`);
    return agent;
  }

  getThread(id: string): ThreadDetail {
    const thread = this.requireThread(id);
    return { ...thread, messages: this.store.messages(id) };
  }

  listThreads(filter: { agent?: string; to?: string; status?: ThreadStatus; surfaced?: boolean }): ThreadSummary[] {
    return this.store
      .listThreads(filter)
      .filter((t) => !filter.surfaced || !t.quiet)
      .map((t) => ({ ...t, lastMessage: this.store.lastMessage(t.id) }));
  }

  createRequest(input: CreateRequestInput): ThreadDetail {
    this.requireAgent(input.from);
    this.requireAgent(input.to);
    if (input.from === input.to) throw new RelayError(400, "不能给自己发请求");
    const topic = input.topic.trim();
    const message = input.message.trim();
    if (!topic || topic.length > 80) throw new RelayError(400, "话题需要在 1 到 80 个字之间");
    if (!message || message.length > 8000) throw new RelayError(400, "消息需要在 1 到 8000 个字之间");

    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    if (this.store.countSentSince(input.from, since) >= this.config.limits.sentPerDay) {
      throw new RelayError(429, "24 小时内发出的请求太多了，需要先在 Achat 上通过校验");
    }
    const toSameContact = this.store.countSentSince(input.from, since, input.to);
    const quiet = toSameContact >= this.config.limits.surfacedPerContactPerDay;

    const now = this.stamp();
    const detail = this.store.transaction(() => {
      const thread = this.store.createThread(
        {
          id: randomBytes(5).toString("hex"),
          topic,
          from: input.from,
          to: input.to,
          scope: this.config.defaults,
          quiet,
        },
        now,
      );
      const msg = this.store.addMessage(thread.id, { sender: input.from, kind: "request", body: message }, now);
      return { ...thread, messages: [msg] };
    });
    this.emit("thread.created", detail);
    return detail;
  }

  approve(id: string, scope?: Partial<Scope>): ThreadDetail {
    const thread = this.requireThread(id);
    if (thread.status !== "pending") throw new RelayError(409, "这次协作已经处理过了");
    const finalScope = clampScope(scope, thread.scope);
    const now = this.stamp();
    const updated = this.store.transaction(() => {
      const t = this.store.updateThread(id, { status: "active", scope: finalScope }, now);
      this.store.addMessage(
        id,
        {
          sender: null,
          kind: "system",
          body: `已同意：只读对话记录 · ${finalScope.maxRounds} 轮 · $${finalScope.budgetUsd.toFixed(2)}`,
        },
        now,
      );
      return t;
    });
    this.emit("thread.updated", updated);
    return this.getThread(id);
  }

  decline(id: string): ThreadDetail {
    const thread = this.requireThread(id);
    if (thread.status !== "pending") throw new RelayError(409, "这次协作已经处理过了");
    return this.finish(id, "declined", "没有接受");
  }

  stop(id: string, by: string | null): ThreadDetail {
    const thread = this.requireThread(id);
    if (isTerminal(thread.status)) throw new RelayError(409, "这次协作已经结束了");
    return this.finish(id, "stopped", `${by ? this.agentName(by) + "的主人" : "主人"}停止了这次协作`);
  }

  close(id: string, by: string): ThreadDetail {
    const thread = this.requireThread(id);
    if (thread.status !== "active") throw new RelayError(409, "只有进行中的协作可以结束");
    if (by !== thread.from && by !== thread.to) throw new RelayError(403, "不是这次协作的参与方");
    return this.finish(id, "closed", `${this.agentName(by)}结束了这次协作`);
  }

  fail(id: string, reason: string): ThreadDetail {
    const thread = this.requireThread(id);
    if (isTerminal(thread.status)) return this.getThread(id);
    return this.finish(id, "closed", `接收方出错：${reason}`);
  }

  private finish(id: string, status: ThreadStatus, note: string): ThreadDetail {
    const now = this.stamp();
    const updated = this.store.transaction(() => {
      const t = this.store.updateThread(id, { status }, now);
      this.store.addMessage(id, { sender: null, kind: "system", body: note }, now);
      return t;
    });
    this.emit("thread.updated", updated);
    return this.getThread(id);
  }

  postMessage(id: string, input: PostMessageInput): ThreadDetail {
    const thread = this.requireThread(id);
    if (thread.status !== "active") {
      throw new RelayError(409, `这次协作${thread.status === "pending" ? "还没被批准" : "已经结束了"}`);
    }
    if (input.from !== thread.from && input.from !== thread.to) {
      throw new RelayError(403, "不是这次协作的参与方");
    }
    const body = input.body.trim();
    if (!body || body.length > 20000) throw new RelayError(400, "消息需要在 1 到 20000 个字之间");

    const lastSpoken = this.store
      .messages(id)
      .filter((m) => m.kind !== "system")
      .at(-1);
    if (lastSpoken?.sender === input.from) {
      throw new RelayError(409, "还没轮到你说话，先等对方回复");
    }
    const fromResponder = input.from === thread.to;
    if (!fromResponder && thread.roundsUsed >= thread.scope.maxRounds) {
      throw new RelayError(409, "已经到轮数上限了");
    }

    const now = this.stamp();
    let closingNote: string | null = null;
    const result = this.store.transaction(() => {
      const msg = this.store.addMessage(
        id,
        {
          sender: input.from,
          kind: "message",
          body,
          redactions: input.redactions ?? 0,
          costUsd: fromResponder ? (input.costUsd ?? 0) : 0,
        },
        now,
      );
      let t = thread;
      if (fromResponder) {
        const roundsUsed = thread.roundsUsed + 1;
        const costUsd = Math.round((thread.costUsd + (input.costUsd ?? 0)) * 10000) / 10000;
        let status: ThreadStatus = thread.status;
        if (costUsd >= thread.scope.budgetUsd) {
          status = "closed";
          closingNote = `花费到了上限 $${thread.scope.budgetUsd.toFixed(2)}，协作结束`;
        } else if (roundsUsed >= thread.scope.maxRounds) {
          status = "closed";
          closingNote = `已到 ${thread.scope.maxRounds} 轮上限，协作结束`;
        }
        t = this.store.updateThread(
          id,
          { roundsUsed, costUsd, status, responderSession: input.sessionId ?? thread.responderSession },
          now,
        );
        if (closingNote) this.store.addMessage(id, { sender: null, kind: "system", body: closingNote }, now);
      } else {
        t = this.store.updateThread(id, {}, now);
      }
      return { thread: t, msg };
    });
    this.emit("message.created", result.thread, result.msg);
    if (closingNote) this.emit("thread.updated", result.thread);
    return this.getThread(id);
  }

  // Resolves once the thread has a message after `afterSeq` or its status
  // differs from `status`, or when the timeout passes.
  waitFor(id: string, afterSeq: number, timeoutMs: number, status?: ThreadStatus): Promise<ThreadDetail> {
    this.requireThread(id);
    const changed = (): boolean => {
      const t = this.store.getThread(id)!;
      return (status !== undefined && t.status !== status) || this.store.messages(id, afterSeq).length > 0;
    };
    if (changed()) return Promise.resolve(this.getThread(id));
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        off();
        resolve(this.getThread(id));
      };
      const timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 60_000)));
      const off = this.onEvent((e) => {
        if (e.threadId === id && changed()) done();
      });
    });
  }
}
