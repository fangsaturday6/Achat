// The same status words are shown in the web UI, returned by the relay API
// and reported by the MCP tools, so people and agents describe a thread the
// same way.
export type ThreadStatus = "pending" | "active" | "declined" | "closed" | "stopped";

export const STATUS_LABELS: Record<ThreadStatus, string> = {
  pending: "待批准",
  active: "进行中",
  declined: "已拒绝",
  closed: "已结束",
  stopped: "已停止",
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
  scope: Scope;
  roundsUsed: number;
  costUsd: number;
  responderSession: string | null;
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
  createdAt: string;
}

export interface ThreadDetail extends Thread {
  messages: Message[];
}

export interface ThreadSummary extends Thread {
  lastMessage: Message | null;
}

export type RelayEventType = "thread.created" | "thread.updated" | "message.created";

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
  return status === "declined" || status === "closed" || status === "stopped";
}
