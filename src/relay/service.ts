import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { cleanName, filesProblem, typeOf, type NewFile } from "../attachments.js";
import type { AchatConfig, AgentConfig } from "../config.js";
import {
  isTerminal,
  latestAnswer,
  MODE_LABELS,
  personWaiting,
  waitingForAsker,
  type Attachment,
  type Message,
  type RelayEvent,
  type Scope,
  type Thread,
  type ThreadDetail,
  type ThreadMode,
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Below this a 问答 round cannot do anything useful, so asking again needs
// more money, approved like the first time.
export const MIN_ROUND_BUDGET_USD = 0.1;
// A request nobody handled: its person is reminded once, and after three
// days it is given up.
export const REMIND_AFTER_MS = 4 * HOUR_MS;
export const EXPIRE_AFTER_MS = 3 * DAY_MS;
export const SWEEP_EVERY_MS = 10 * 60 * 1000;

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

function checkMode(mode: unknown): ThreadMode | undefined {
  if (mode === undefined || mode === null) return undefined;
  if (mode !== "answer" && mode !== "do") throw new RelayError(400, 'mode 只能是 "answer"（问答）或 "do"（动手）');
  return mode;
}

export interface CreateRequestInput {
  from: string;
  to: string;
  topic: string;
  message: string;
  mode?: ThreadMode;
  // Written by the person on the web page, not by their AI.
  byPerson?: boolean;
  files?: NewFile[];
}

// Where the relay looks up the AIs it carries messages between: the fixed
// list in config.json locally, the accounts database in the cloud.
export interface AgentDirectory {
  get(id: string): AgentConfig | undefined;
}

export type RelaySettings = Pick<AchatConfig, "defaults" | "limits">;

export interface PostMessageInput {
  from: string;
  body: string;
  costUsd?: number;
  redactions?: number;
  sessionId?: string;
  // "do" from the asker in a 问答 thread asks the other side to 动手; its
  // person approves again.
  mode?: ThreadMode;
  byPerson?: boolean;
  // The asker's computer answering in the background what the other side
  // said on its own: it wakes no AI and is not a round.
  reply?: boolean;
  files?: NewFile[];
}

// Owns the thread state machine. Every state change goes through here so the
// HTTP API, the sidecar and the MCP tools see the same rules.
export class RelayService {
  private events = new EventEmitter();

  constructor(
    private store: Store,
    private config: RelaySettings,
    private agents: AgentDirectory,
    private now: () => Date = () => new Date(),
  ) {
    this.events.setMaxListeners(0);
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

  // Only Claude Code opens a conversation of its own to do the work, so far.
  private requireDoer(id: string): void {
    const agent = this.requireAgent(id);
    if (agent.client !== "claude") throw new RelayError(400, `${agent.name}还不能动手，只能问答`);
  }

  // The rounds, or for 问答 the money, the person allowed are used up.
  private spent(t: Thread): boolean {
    return t.roundsUsed >= t.scope.maxRounds || (t.mode === "answer" && t.scope.budgetUsd - t.costUsd < MIN_ROUND_BUDGET_USD);
  }

  // The person's own seat writes as a person, not as an AI.
  private byPerson(agent: string, said?: boolean): boolean {
    return said === true || this.agents.get(agent)?.client === "person";
  }

  // Names without folders, types by the name, and no more than a message may carry.
  private checkFiles(files: NewFile[] = []): NewFile[] {
    const problem = filesProblem(files);
    if (problem) throw new RelayError(400, problem);
    return files.map((f) => {
      const name = cleanName(f.name);
      return { name, type: typeOf(name, f.type), data: f.data };
    });
  }

  file(id: string): (Attachment & { threadId: string; data: Uint8Array }) | null {
    return this.store.file(id);
  }

  getThread(id: string): ThreadDetail {
    const thread = this.requireThread(id);
    return { ...thread, messages: this.store.messages(id) };
  }

  listThreads(filter: {
    agent?: string;
    agents?: string[];
    to?: string;
    status?: ThreadStatus;
    surfaced?: boolean;
    unseen?: string;
  }): ThreadSummary[] {
    return this.store
      .listThreads(filter)
      .filter((t) => !filter.surfaced || !t.quiet)
      .map((t) => ({ ...t, lastMessage: this.store.lastMessage(t.id) }));
  }

  // Whether the reader has a message they have not seen: one from the other
  // person's AI, or between their own AIs, an answer.
  unread(thread: Thread, reader: string, mine: (agent: string) => boolean): boolean {
    const own = mine(thread.from) && mine(thread.to);
    return this.store
      .sendersAfter(thread.id, this.store.readSeq(reader, thread.id))
      .some((sender) => sender !== null && (own ? sender === thread.to : !mine(sender)));
  }

  readSeq(reader: string, threadId: string): number {
    return this.store.readSeq(reader, threadId);
  }

  markRead(reader: string, threadId: string): void {
    const last = this.store.lastMessage(threadId);
    if (last) this.store.markRead(reader, threadId, last.seq);
  }

  // The asking AI was shown the thread up to `seq`.
  markSeen(threadId: string, seq: number): void {
    this.requireThread(threadId);
    if (!Number.isInteger(seq) || seq < 0) throw new RelayError(400, "seq 需要是消息编号");
    this.store.markAskerSeen(threadId, seq);
  }

  // `autoApprove` starts the thread right away with the default scope, for
  // requests between AIs of the same person.
  createRequest(input: CreateRequestInput, opts: { autoApprove?: boolean } = {}): ThreadDetail {
    this.requireAgent(input.from);
    this.requireAgent(input.to);
    if (input.from === input.to) throw new RelayError(400, "不能给自己发请求");
    const mode = checkMode(input.mode) ?? "answer";
    if (mode === "do") this.requireDoer(input.to);
    const topic = input.topic.trim();
    const message = input.message.trim();
    const files = this.checkFiles(input.files);
    if (!topic || topic.length > 80) throw new RelayError(400, "话题需要在 1 到 80 个字之间");
    if ((!message && !files.length) || message.length > 8000) throw new RelayError(400, "消息需要在 1 到 8000 个字之间");

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
          mode,
          scope: this.config.defaults,
          quiet,
        },
        now,
      );
      const msg = this.store.addMessage(
        thread.id,
        { sender: input.from, kind: "request", body: message, byPerson: this.byPerson(input.from, input.byPerson), files },
        now,
      );
      if (!opts.autoApprove) return { ...thread, messages: [msg] };
      const started = this.store.updateThread(thread.id, { status: "active" }, now);
      const note = this.store.addMessage(
        thread.id,
        {
          sender: null,
          kind: "system",
          body: `${this.agents.get(input.from)?.client === "person" ? "问自己的 AI" : "同一个人的 AI"}，自动接待 · ${this.scopeNote(started.scope, mode)}`,
        },
        now,
      );
      return { ...started, messages: [msg, note] };
    });
    this.emit("thread.created", detail);
    return detail;
  }

  // The person may turn a 动手 request into 问答, not the other way round.
  // Approving a 动手 asked for mid-thread starts the rounds over.
  approve(id: string, scope?: Partial<Scope> & { mode?: ThreadMode }): ThreadDetail {
    const thread = this.requireThread(id);
    if (thread.status !== "pending") throw new RelayError(409, "这次协作已经处理过了");
    const finalScope = clampScope(scope, thread.scope);
    const mode = checkMode(scope?.mode) ?? thread.mode;
    if (mode === "do" && thread.mode !== "do") throw new RelayError(400, "对方要的是问答，不能改成动手");
    const now = this.stamp();
    const updated = this.store.transaction(() => {
      // A request inside the thread is a new allowance: rounds and money start over.
      const restart = thread.prior ? { roundsUsed: 0, costUsd: 0 } : {};
      const t = this.store.updateThread(id, { status: "active", mode, scope: finalScope, prior: null, reminded: false, ...restart }, now);
      this.store.addMessage(
        id,
        {
          sender: null,
          kind: "system",
          body: `已同意：${this.scopeNote(finalScope, mode)}`,
        },
        now,
      );
      return t;
    });
    this.emit("thread.updated", updated);
    return this.getThread(id);
  }

  // 动手 runs on the person's Claude subscription, so it has no dollar figure.
  private scopeNote(scope: Scope, mode: ThreadMode): string {
    const rounds = `${MODE_LABELS[mode]} · ${scope.maxRounds} 轮`;
    return mode === "do" ? rounds : `${rounds} · $${scope.budgetUsd.toFixed(2)}`;
  }

  // Declining a first request ends it. Declining one made inside the thread
  // goes back to where it was: a 动手 asked for in a 问答 with rounds left
  // keeps the 问答 going; asking to go on leaves it ended.
  decline(id: string): ThreadDetail {
    const thread = this.requireThread(id);
    if (thread.status !== "pending") throw new RelayError(409, "这次协作已经处理过了");
    if (!thread.prior) return this.finish(id, "declined", "没有接受");
    return this.goBack(thread, "没有同意接着聊");
  }

  private goBack(thread: Thread, note: string): ThreadDetail {
    const prior = thread.prior!;
    const keepsGoing = prior.status === "active" && !this.spent({ ...thread, mode: prior.mode });
    const now = this.stamp();
    const updated = this.store.transaction(() => {
      const t = this.store.updateThread(
        thread.id,
        { status: keepsGoing ? "active" : "closed", mode: prior.mode, prior: null, reminded: false },
        now,
      );
      this.store.addMessage(thread.id, { sender: null, kind: "system", body: keepsGoing ? "没有接受动手，接着问答" : note }, now);
      return t;
    });
    this.emit("thread.updated", updated);
    return this.getThread(thread.id);
  }

  // The asked side ran out of money in the middle of answering: the question
  // waits for its person to allow more instead of the thread ending.
  askMore(id: string, note: string): ThreadDetail {
    const thread = this.requireThread(id);
    if (thread.status !== "active") return this.getThread(id);
    const now = this.stamp();
    const updated = this.store.transaction(() => {
      const t = this.store.updateThread(id, { status: "pending", prior: { status: "closed", mode: thread.mode }, reminded: false }, now);
      this.store.addMessage(id, { sender: null, kind: "system", body: note }, now);
      return t;
    });
    this.emit("thread.updated", updated);
    return this.getThread(id);
  }

  // Run every few minutes: a request waiting for hours is brought up again
  // once; one waiting for days is given up, and one made inside a thread
  // goes back to where the thread was.
  sweep(): void {
    const now = this.now().getTime();
    for (const t of this.store.listThreads({ status: "pending" })) {
      const waited = now - Date.parse(t.updatedAt);
      if (waited >= EXPIRE_AFTER_MS) {
        if (t.prior) this.goBack(t, "3 天没人处理，没有接着聊");
        else this.finish(t.id, "expired", "3 天没人处理，已过期");
      } else if (waited >= REMIND_AFTER_MS && !t.reminded) {
        this.store.markReminded(t.id);
        this.emit("thread.reminded", t);
      }
    }
  }

  // Replies of the asked side that nobody on the asking side has seen since
  // `before`; marks them so each is reported once.
  unseenReplies(before: Date): { thread: Thread; message: Message }[] {
    const found = this.store.unseenReplies(before.toISOString());
    for (const { thread, message } of found) this.store.markReplyMailed(thread.id, message.seq);
    return found;
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

  // A note from the receiving side that leaves the thread as it is, such as
  // its AI waiting for a login.
  note(id: string, body: string): ThreadDetail {
    const thread = this.requireThread(id);
    if (isTerminal(thread.status)) return this.getThread(id);
    const msg = this.store.addMessage(id, { sender: null, kind: "system", body }, this.stamp());
    this.emit("message.created", thread, msg);
    return this.getThread(id);
  }

  fail(id: string, reason: string): ThreadDetail {
    return this.end(id, `接收方出错：${reason}`);
  }

  // Ends a thread for a reason that is not an error, such as the budget
  // running out, with the note shown to both sides as is.
  end(id: string, note: string): ThreadDetail {
    const thread = this.requireThread(id);
    if (isTerminal(thread.status)) return this.getThread(id);
    return this.finish(id, "closed", note);
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

  // The asker waits for each answer, since every question costs the other side
  // a round in the background. The asked side can add to a thread at any time,
  // even after it ended on its own, for example to say the work is done; that
  // is not a round. What the asked side's person says there is for the AI
  // that asked, whose next word answers them; what its AI adds on its own,
  // the asker's computer may answer in the background without asking it
  // anything. Only a thread a person stopped or declined is shut.
  postMessage(id: string, input: PostMessageInput): ThreadDetail {
    const thread = this.requireThread(id);
    if (input.from !== thread.from && input.from !== thread.to) {
      throw new RelayError(403, "不是这次协作的参与方");
    }
    const fromResponder = input.from === thread.to;
    if (thread.status === "pending") throw new RelayError(409, "这次协作还没被批准");
    if (thread.status === "stopped" || thread.status === "declined") throw new RelayError(409, "这次协作已经停止了");
    if (thread.status === "expired" && fromResponder) throw new RelayError(409, "这个请求已经过期了");
    const upgrade = checkMode(input.mode) === "do" && thread.mode !== "do";
    if (upgrade && fromResponder) throw new RelayError(400, "只有发起方可以请对方动手");
    if (upgrade) this.requireDoer(thread.to);
    const spoken = this.store.messages(id).filter((m) => m.kind !== "system");
    const lastSpoken = spoken.at(-1);
    const personSays = this.byPerson(input.from, input.byPerson);
    // The other side's person spoke since the asker last did, or the asker's
    // computer answers what the other side said on its own: an answer, and
    // their AI is not asked anything.
    if (input.reply && (fromResponder || !waitingForAsker(thread, spoken))) throw new RelayError(409, "对方没有在等你回");
    const toPerson = !fromResponder && !upgrade && (input.reply === true || personWaiting(thread, spoken) !== null);
    // The first word from the asked AI after the asker's latest question
    // answers it; the person's own words are not a round.
    const answers = fromResponder && !personSays && latestAnswer(thread, spoken) === undefined;
    // A computer from before answers that wake no AI takes the asker's answer
    // for a question and answers it in the background. Kept, it would be
    // something said on its own, which the asker's computer answers in turn,
    // and the two would go on by themselves.
    if (fromResponder && input.sessionId && !answers && spoken.findLast((m) => m.sender === thread.from)?.toPerson) {
      throw new RelayError(409, "对方是在回你，不用回答");
    }
    // The asker asking to 动手, or to go on once the thread ended or its
    // allowance is used up: a request of its own, which the person approves.
    const asks = !fromResponder && !toPerson && (upgrade || thread.status !== "active" || this.spent(thread));
    const body = input.body.trim();
    const files = this.checkFiles(input.files);
    if ((!body && !files.length) || body.length > 20000) throw new RelayError(400, "消息需要在 1 到 20000 个字之间");

    // A call tried again after its reply was lost must not post twice. Asking
    // to go on may repeat a question that was never answered.
    const sameFiles = (m: Message): boolean => m.files.map((f) => `${f.name}:${f.size}`).join() === files.map((f) => `${f.name}:${f.data.length}`).join();
    if (!asks && lastSpoken?.sender === input.from && lastSpoken.body === body && sameFiles(lastSpoken)) {
      throw new RelayError(409, "这条已经发过了");
    }
    if (!asks && !fromResponder && lastSpoken?.sender === input.from && !lastSpoken.toPerson) {
      throw new RelayError(409, "还没轮到你说话，先等对方回复");
    }

    const now = this.stamp();
    let closingNote: string | null = null;
    const result = this.store.transaction(() => {
      const msg = this.store.addMessage(
        id,
        {
          sender: input.from,
          kind: asks ? "request" : "message",
          body,
          redactions: input.redactions ?? 0,
          costUsd: fromResponder ? (input.costUsd ?? 0) : 0,
          byPerson: personSays,
          toPerson,
          files,
        },
        now,
      );
      let t = thread;
      if (fromResponder) {
        const roundsUsed = thread.roundsUsed + (answers ? 1 : 0);
        const costUsd = Math.round((thread.costUsd + (input.costUsd ?? 0)) * 10000) / 10000;
        let status: ThreadStatus = thread.status;
        if (status === "active" && costUsd >= thread.scope.budgetUsd) {
          status = "closed";
          closingNote = `花费到了上限 $${thread.scope.budgetUsd.toFixed(2)}，协作结束`;
        } else if (status === "active" && answers && roundsUsed >= thread.scope.maxRounds) {
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
        t = this.store.updateThread(
          id,
          asks
            ? { status: "pending", mode: upgrade ? "do" : thread.mode, prior: { status: thread.status, mode: thread.mode }, reminded: false }
            : {},
          now,
        );
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
