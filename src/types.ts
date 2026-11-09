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
  createdAt: string;
}

export interface ThreadDetail extends Thread {
  messages: Message[];
}

export interface ThreadSummary extends Thread {
  lastMessage: Message | null;
  // Set in lists: a message the caller has not seen yet.
  unread?: boolean;
}

// "thread.reminded": a request has waited for approval for hours.
export type RelayEventType = "thread.created" | "thread.updated" | "message.created" | "thread.reminded";

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

export function isTerminal(status: ThreadStatus): boolean {
  return status === "declined" || status === "closed" || status === "stopped" || status === "expired";
}
