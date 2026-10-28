import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message, MessageKind, Scope, Thread, ThreadStatus } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  status TEXT NOT NULL,
  max_rounds INTEGER NOT NULL,
  budget_usd REAL NOT NULL,
  rounds_used INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  responder_session TEXT,
  quiet INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq INTEGER NOT NULL,
  sender TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE INDEX IF NOT EXISTS threads_to ON threads (to_agent, status);
CREATE INDEX IF NOT EXISTS threads_from ON threads (from_agent, created_at);
`;

interface ThreadRow {
  id: string;
  topic: string;
  from_agent: string;
  to_agent: string;
  status: string;
  max_rounds: number;
  budget_usd: number;
  rounds_used: number;
  cost_usd: number;
  responder_session: string | null;
  quiet: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  thread_id: string;
  seq: number;
  sender: string | null;
  kind: string;
  body: string;
  redactions: number;
  cost_usd: number;
  created_at: string;
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    topic: row.topic,
    from: row.from_agent,
    to: row.to_agent,
    status: row.status as ThreadStatus,
    scope: { maxRounds: row.max_rounds, budgetUsd: row.budget_usd },
    roundsUsed: row.rounds_used,
    costUsd: row.cost_usd,
    responderSession: row.responder_session,
    quiet: row.quiet === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    sender: row.sender,
    kind: row.kind as MessageKind,
    body: row.body,
    redactions: row.redactions,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  };
}

export interface NewThread {
  id: string;
  topic: string;
  from: string;
  to: string;
  scope: Scope;
  quiet: boolean;
}

export interface NewMessage {
  sender: string | null;
  kind: MessageKind;
  body: string;
  redactions?: number;
  costUsd?: number;
}

export interface ThreadPatch {
  status?: ThreadStatus;
  scope?: Scope;
  roundsUsed?: number;
  costUsd?: number;
  responderSession?: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createThread(t: NewThread, now: string): Thread {
    this.db
      .prepare(
        `INSERT INTO threads (id, topic, from_agent, to_agent, status, max_rounds, budget_usd, quiet, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.topic, t.from, t.to, t.scope.maxRounds, t.scope.budgetUsd, t.quiet ? 1 : 0, now, now);
    return this.getThread(t.id)!;
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  listThreads(filter: { agent?: string; to?: string; status?: ThreadStatus }): Thread[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.agent) {
      where.push("(from_agent = ? OR to_agent = ?)");
      params.push(filter.agent, filter.agent);
    }
    if (filter.to) {
      where.push("to_agent = ?");
      params.push(filter.to);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const sql = `SELECT * FROM threads ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
    return (this.db.prepare(sql).all(...params) as unknown as ThreadRow[]).map(toThread);
  }

  updateThread(id: string, patch: ThreadPatch, now: string): Thread {
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.scope !== undefined) {
      sets.push("max_rounds = ?", "budget_usd = ?");
      params.push(patch.scope.maxRounds, patch.scope.budgetUsd);
    }
    if (patch.roundsUsed !== undefined) {
      sets.push("rounds_used = ?");
      params.push(patch.roundsUsed);
    }
    if (patch.costUsd !== undefined) {
      sets.push("cost_usd = ?");
      params.push(patch.costUsd);
    }
    if (patch.responderSession !== undefined) {
      sets.push("responder_session = ?");
      params.push(patch.responderSession);
    }
    params.push(id);
    this.db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getThread(id)!;
  }

  addMessage(threadId: string, m: NewMessage, now: string): Message {
    const next = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = ?")
      .get(threadId) as { seq: number };
    const result = this.db
      .prepare(
        `INSERT INTO messages (thread_id, seq, sender, kind, body, redactions, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, next.seq, m.sender, m.kind, m.body, m.redactions ?? 0, m.costUsd ?? 0, now);
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as MessageRow;
    return toMessage(row);
  }

  messages(threadId: string, afterSeq = 0): Message[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq")
        .all(threadId, afterSeq) as unknown as MessageRow[]
    ).map(toMessage);
  }

  lastMessage(threadId: string): Message | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1")
      .get(threadId) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  countSentSince(from: string, since: string, to?: string): number {
    const sql = to
      ? "SELECT COUNT(*) AS n FROM threads WHERE from_agent = ? AND to_agent = ? AND created_at >= ?"
      : "SELECT COUNT(*) AS n FROM threads WHERE from_agent = ? AND created_at >= ?";
    const params = to ? [from, to, since] : [from, since];
    return (this.db.prepare(sql).get(...params) as { n: number }).n;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
