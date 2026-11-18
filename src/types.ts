import type { Effort, ModelUse } from "./models.js";

// The same status words are shown in the web UI, returned by the relay API
// and reported by the MCP tools, so people and agents describe a thread the
// same way.
export type ThreadStatus = "pending" | "active" | "declined" | "closed" | "stopped" | "expired";

export const STATUS_LABELS: Record<ThreadStatus, string> = {
  pending: "待批准",
  active: "进行中",
  declined: "已拒绝",
  closed: "已结束",
  stopped: "已停止",
  expired: "已过期",
};

// What the asker wants: an answer from the other side's history (问答), or
// the other side's AI doing the work on its computer (动手).
export type ThreadMode = "answer" | "do";

export const MODE_LABELS: Record<ThreadMode, string> = {
  answer: "问答",
  do: "动手",
};

export interface Scope {
  maxRounds: number;
  budgetUsd: number;
}

// What “加 10 轮” gives a thread under way, on top of what it had; 问答 gets
// the money for them too. web/app.js writes the same number on its button.
export const MORE_SCOPE: Scope = { maxRounds: 10, budgetUsd: 10 };

// Below this a 问答 round cannot do anything useful, so asking again needs
// more money, approved like the first time.
export const MIN_ROUND_BUDGET_USD = 0.1;

// The rounds, or for 问答 the money, the person allowed are used up.
export function allowanceSpent(t: Pick<Thread, "mode" | "scope" | "roundsUsed" | "costUsd">): boolean {
  return t.roundsUsed >= t.scope.maxRounds || (t.mode === "answer" && t.scope.budgetUsd - t.costUsd < MIN_ROUND_BUDGET_USD);
}

type RoundsView = Pick<Thread, "status" | "own" | "from" | "mode" | "scope" | "roundsUsed" | "costUsd">;

// The one rule for "加 10 轮": the asked side's person (never between one
// person's own AIs) can use it in the last round, or once rounds or money ran
// out, even if the thread has closed. The relay checks it; the page and the
// tools read what the relay computed.
export function canAddRounds(t: RoundsView): boolean {
  return !t.own && ((t.status === "active" && (t.scope.maxRounds - t.roundsUsed <= 1 || allowanceSpent(t))) || (t.status === "closed" && allowanceSpent(t)));
}

// The asker's question that opened the last round waits for its answer.
// `last`: the thread's last message that is not a system note.
export function inLastRound(t: RoundsView, last: Pick<Message, "sender" | "toPerson"> | null | undefined): boolean {
  return t.status === "active" && !t.own && t.roundsUsed + 1 >= t.scope.maxRounds && last?.sender === t.from && !last.toPerson;
}

export interface Thread {
  id: string;
  topic: string;
  from: string;
  to: string;
  status: ThreadStatus;
  // While pending, what is being asked for; once active, what was allowed.
  mode: ThreadMode;
  // While a request made inside the thread waits (to 动手, or to go on once
  // the rounds or the money ran out), the status and mode it had before;
  // declining goes back to them. Null for a first request.
  prior: { status: ThreadStatus; mode: ThreadMode } | null;
  // The asker's latest words the asked computer has judged (a message seq):
  // 问答 or 动手. Each is judged once, so what the person chose stands.
  judged: number;
  // Between one person's own AIs: no approval, 动手 included.
  own: boolean;
  scope: Scope;
  roundsUsed: number;
  costUsd: number;
  responderSession: string | null;
  // How far the asking AI has seen the thread (a message seq). Whatever the
  // other side says after this is brought back to the session that asked.
  askerSeen: number;
  // A pending request was already brought up again after waiting for hours.
  reminded: boolean;
  // A quiet request is kept on the web page only and never surfaces in the
  // receiver's AI session (rate limit per contact per day).
  quiet: boolean;
  // The model and 推理档位 the asked side's person picked for this
  // conversation; null: what they picked for the AI, or its own default.
  model: string | null;
  effort: Effort | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageKind = "request" | "message" | "system";

export interface Message {
  id: number;
  threadId: string;
  seq: number;
  sender: string | null;
  kind: MessageKind;
  body: string;
  redactions: number;
  costUsd: number;
  // Written by the person on the web page, not by their AI.
  byPerson: boolean;
  // The asking side answering, not asking their AI: it wakes no AI and is
  // not a round. Its next word after the other side's person spoke, or its
  // computer answering in the background what the other side's AI added on
  // its own. The name is from when only a person was answered; computers
  // already out there read it by this name.
  toPerson: boolean;
  // Pictures and other files sent with it; the bytes are fetched one by one.
  files: Attachment[];
  // For what the asked AI wrote: the model ("Opus 4.8") and 推理档位 it ran on.
  model: string | null;
  effort: Effort | null;
  createdAt: string;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface ThreadDetail extends Thread {
  messages: Message[];
  // What the asked AI answers and works with now; null while its computer
  // has not said what it can use.
  uses: ModelUse | null;
  canAddRounds: boolean;
  lastRound: boolean;
}

export interface ThreadSummary extends Thread {
  canAddRounds: boolean;
  lastRound: boolean;
  lastMessage: Message | null;
  // Set in lists: a message the caller has not seen yet.
  unread?: boolean;
}

// "thread.reminded": a request has waited for approval for hours.
// "thread.lastRound": the asker's question at `seq` opened the last round of a
// thread between two people's AIs; the asked side's person may give more.
export type RelayEventType = "thread.created" | "thread.updated" | "message.created" | "thread.reminded" | "thread.lastRound";

export interface RelayEvent {
  type: RelayEventType;
  threadId: string;
  status: ThreadStatus;
  from: string;
  to: string;
  quiet: boolean;
  sender?: string | null;
  seq?: number;
}

// The asked AI's answer to the asking side's latest question: its first word
// after that question, or undefined while it has not answered. The asking
// side's answers to what the other side said on its own are not questions.
// `spoken`: the thread's messages without the system notes.
export function latestAnswer(thread: Pick<Thread, "from" | "to">, spoken: Message[]): Message | undefined {
  const ask = spoken.findLastIndex((m) => m.sender === thread.from && !m.toPerson);
  return spoken.slice(ask + 1).find((m) => m.sender === thread.to && !m.byPerson);
}

// What the asked side's person said that the asking side has not answered:
// their latest words since the asking side last spoke, or null. The asking
// side's next word answers it.
export function personWaiting(thread: Pick<Thread, "from" | "to">, messages: Message[]): Message | null {
  const spoken = messages.filter((m) => m.kind !== "system");
  const since = spoken.slice(spoken.findLastIndex((m) => m.sender === thread.from) + 1);
  return since.filter((m) => m.sender === thread.to && m.byPerson).at(-1) ?? null;
}

// What the asked side said on its own that the asking side has not answered:
// its person's words, or its AI adding to the thread, which is anything but
// the answer to the latest question. The latest such message since the
// asking side last spoke, or null. If the session that asked does not, its
// computer answers it in the background.
export function waitingForAsker(thread: Pick<Thread, "from" | "to">, messages: Message[]): Message | null {
  const spoken = messages.filter((m) => m.kind !== "system");
  const answer = latestAnswer(thread, spoken);
  const since = spoken.slice(spoken.findLastIndex((m) => m.sender === thread.from) + 1);
  return since.filter((m) => m.sender === thread.to && m !== answer).at(-1) ?? null;
}

export function isTerminal(status: ThreadStatus): boolean {
  return status === "declined" || status === "closed" || status === "stopped" || status === "expired";
}

// --- 群（8n）：几个人的 AI 一起开会

export type GroupStatus = "open" | "stopped" | "dissolved";

export const GROUP_STATUS_LABELS: Record<GroupStatus, string> = {
  open: "进行中",
  stopped: "已叫停",
  dissolved: "已解散",
};

// What became of an AI a message woke. The line under the message shows
// every state but "replied": the reply itself is right below.
export type ReceiptState = "reading" | "replied" | "passed" | "offline" | "quota" | "cannot" | "stopped" | "failed";

export const RECEIPT_LABELS: Record<ReceiptState, string> = {
  reading: "正在看",
  replied: "回复了",
  passed: "无需回复",
  offline: "不在线",
  quota: "额度用完了",
  cannot: "还不能接收",
  stopped: "已叫停",
  failed: "没答上",
};

// "@所有人" in a message's mentions.
export const ALL = "all";

export interface Receipt {
  agent: string;
  state: ReceiptState;
  // Why it need not reply, in its own half sentence, or what went wrong.
  reason: string | null;
}

export interface GroupMessage {
  id: number;
  groupId: string;
  seq: number;
  // An AI, a person's seat (本人), or null for Achat's own notes.
  sender: string | null;
  kind: "message" | "system";
  body: string;
  // AIs' ids, ALL, or the seat of the sender's own person (an AI calling its owner).
  mentions: string[];
  // For a background answer: the message whose @ woke it.
  replyTo: number | null;
  byPerson: boolean;
  redactions: number;
  costUsd: number;
  files: Attachment[];
  // The AIs it woke and what became of them, in the order they were woken.
  receipts: Receipt[];
  model: string | null;
  effort: Effort | null;
  createdAt: string;
}

export interface GroupMember {
  agent: string;
  // From the caller's side: "我的 Claude", "老王的 Codex".
  name: string;
  // Its account.
  owner: string;
  canReceive: boolean;
  online: boolean;
  joinedAt: string;
  // The caller's own AIs only: times a day it may be woken here, and today so far.
  quota?: number;
  usedToday?: number;
}

export interface GroupInvite {
  id: string;
  // The person invited.
  account: string;
  name: string;
  // The AI asked for by name; null when the person picks.
  agent: string | null;
  agentName: string | null;
  invitedBy: string;
  invitedByName: string;
  expiresAt: string;
}

export interface Group {
  id: string;
  name: string;
  // 群主: the account of the AI that started it, or whoever it passed to.
  owner: string;
  status: GroupStatus;
  // Goes up with every 叫停, so answers to what was asked before are refused.
  epoch: number;
  // The opening message (@所有人), which wakes AIs as they join within a day.
  openerSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupDetail extends Group {
  // "invited": the caller only has an invite, and sees the opening message alone.
  role: "member" | "invited";
  members: GroupMember[];
  invites: GroupInvite[];
  myInvite: GroupInvite | null;
  messages: GroupMessage[];
  // Every sender in `messages` and every member, named from the caller's side.
  names: Record<string, string>;
}

export interface GroupSummary extends Group {
  role: "member" | "invited";
  memberCount: number;
  lastMessage: GroupMessage | null;
  unread: boolean;
  myInvite: GroupInvite | null;
}

// Someone to bring into a group: one AI, or a person, who picks their AIs.
export type GroupTarget = { agent: string } | { account: string };

// What an AI woken in a group reads: the message that woke it, and what came
// before it from where its background session left off.
export interface GroupWork {
  group: Group;
  wake: GroupMessage;
  messages: GroupMessage[];
  session: string | null;
  // Named from nobody's side ("老方的 Claude", never "我的 Claude").
  members: { agent: string; name: string }[];
  names: Record<string, string>;
  // Its own person, whom it may call with "@" and this name.
  owner: { seat: string; name: string };
}

// Sent on the same event stream as threads. `members`: every AI in the group
// and the seats of people invited, so each account hears of its own groups.
// `wake`: the AIs just woken.
export interface GroupEvent {
  type: "group.updated" | "group.message";
  groupId: string;
  seq?: number;
  wake?: string[];
  members: string[];
}
