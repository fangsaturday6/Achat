import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NewFile } from "../attachments.js";
import type { Attachment, Message, MessageKind, Scope, Thread, ThreadMode, ThreadStatus } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'answer',
  prior_status TEXT,
  prior_mode TEXT,
  max_rounds INTEGER NOT NULL,
  budget_usd REAL NOT NULL,
  rounds_used INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  responder_session TEXT,
  asker_seen INTEGER NOT NULL DEFAULT 0,
  reminded INTEGER NOT NULL DEFAULT 0,
  reply_mailed INTEGER NOT NULL DEFAULT 0,
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
  by_person INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
-- How far each reader (an account, or the person on this computer) has read.
CREATE TABLE IF NOT EXISTS thread_reads (
  reader TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (reader, thread_id)
);
-- Pictures and other files sent with a message.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  thread_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS files_by_thread ON files (thread_id, message_id, position);
CREATE INDEX IF NOT EXISTS threads_to ON threads (to_agent, status);
CREATE INDEX IF NOT EXISTS threads_from ON threads (from_agent, created_at);
`;

interface ThreadRow {
  id: string;
  topic: string;
  from_agent: string;
  to_agent: string;
  status: string;
  mode: string;
  prior_status: string | null;
  prior_mode: string | null;
  max_rounds: number;
  budget_usd: number;
  rounds_used: number;
  cost_usd: number;
  responder_session: string | null;
  asker_seen: number;
  reminded: number;
  reply_mailed: number;
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
  by_person: number;
  created_at: string;
}

function asMode(value: string | null): ThreadMode {
  return value === "do" ? "do" : "answer";
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    topic: row.topic,
    from: row.from_agent,
    to: row.to_agent,
    status: row.status as ThreadStatus,
    mode: asMode(row.mode),
    prior: row.prior_status ? { status: row.prior_status as ThreadStatus, mode: asMode(row.prior_mode) } : null,
    scope: { maxRounds: row.max_rounds, budgetUsd: row.budget_usd },
    roundsUsed: row.rounds_used,
    costUsd: row.cost_usd,
    responderSession: row.responder_session,
    askerSeen: row.asker_seen,
    reminded: row.reminded === 1,
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
    byPerson: row.by_person === 1,
    files: [],
    createdAt: row.created_at,
  };
}

export interface NewThread {
  id: string;
  topic: string;
  from: string;
  to: string;
  mode: ThreadMode;
  scope: Scope;
  quiet: boolean;
}

export interface NewMessage {
  sender: string | null;
  kind: MessageKind;
  body: string;
  redactions?: number;
  costUsd?: number;
  byPerson?: boolean;
  files?: NewFile[];
}

export interface ThreadPatch {
  status?: ThreadStatus;
  mode?: ThreadMode;
  prior?: { status: ThreadStatus; mode: ThreadMode } | null;
  // Cleared whenever the thread becomes pending again.
  reminded?: boolean;
  scope?: Scope;
  roundsUsed?: number;
  costUsd?: number;
  responderSession?: string | null;
}

export class Store {
  // Shared with the cloud's account tables, which live in the same file.
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // Threads from before asker_seen: their asking AIs got every answer while
    // waiting, so nothing in them is new.
    const columns = this.db.prepare("PRAGMA table_info(threads)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "asker_seen")) {
      this.db.exec(`
        ALTER TABLE threads ADD COLUMN asker_seen INTEGER NOT NULL DEFAULT 0;
        UPDATE threads SET asker_seen = (SELECT COALESCE(MAX(seq), 0) FROM messages WHERE thread_id = threads.id);
      `);
    }
    // Columns added later; older rows take the defaults (问答, nothing
    // waiting, nothing reminded or mailed, written by an AI).
    const add = (table: string, column: string, ddl: string): void => {
      const have = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!have.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    };
    add("threads", "mode", "TEXT NOT NULL DEFAULT 'answer'");
    add("threads", "prior_status", "TEXT");
    add("threads", "prior_mode", "TEXT");
    add("threads", "reminded", "INTEGER NOT NULL DEFAULT 0");
    add("threads", "reply_mailed", "INTEGER NOT NULL DEFAULT 0");
    add("messages", "by_person", "INTEGER NOT NULL DEFAULT 0");
  }

  close(): void {
    this.db.close();
  }

  createThread(t: NewThread, now: string): Thread {
    this.db
      .prepare(
        `INSERT INTO threads (id, topic, from_agent, to_agent, status, mode, max_rounds, budget_usd, quiet, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.topic, t.from, t.to, t.mode, t.scope.maxRounds, t.scope.budgetUsd, t.quiet ? 1 : 0, now, now);
    return this.getThread(t.id)!;
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    return row ? toThread(row) : null;
  }

  listThreads(filter: { agent?: string; agents?: string[]; to?: string; status?: ThreadStatus; unseen?: string }): Thread[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.agents) {
      if (!filter.agents.length) return [];
      const marks = filter.agents.map(() => "?").join(", ");
      where.push(`(from_agent IN (${marks}) OR to_agent IN (${marks}))`);
      params.push(...filter.agents, ...filter.agents);
    }
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
    // Threads this AI asked in which the other side said something it has not seen.
    if (filter.unseen) {
      where.push(
        "from_agent = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.seq > threads.asker_seen AND m.sender = threads.to_agent)",
      );
      params.push(filter.unseen);
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
    if (patch.mode !== undefined) {
      sets.push("mode = ?");
      params.push(patch.mode);
    }
    if (patch.prior !== undefined) {
      sets.push("prior_status = ?", "prior_mode = ?");
      params.push(patch.prior?.status ?? null, patch.prior?.mode ?? null);
    }
    if (patch.reminded !== undefined) {
      sets.push("reminded = ?");
      params.push(patch.reminded ? 1 : 0);
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
        `INSERT INTO messages (thread_id, seq, sender, kind, body, redactions, cost_usd, by_person, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, next.seq, m.sender, m.kind, m.body, m.redactions ?? 0, m.costUsd ?? 0, m.byPerson ? 1 : 0, now);
    const messageId = Number(result.lastInsertRowid);
    const insert = this.db.prepare(
      "INSERT INTO files (id, message_id, thread_id, position, name, type, size, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    (m.files ?? []).forEach((f, position) =>
      insert.run(`f_${randomBytes(9).toString("base64url")}`, messageId, threadId, position, f.name, f.type, f.data.length, f.data),
    );
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as unknown as MessageRow;
    return this.withFiles(threadId, [toMessage(row)])[0];
  }

  messages(threadId: string, afterSeq = 0): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq")
      .all(threadId, afterSeq) as unknown as MessageRow[];
    return this.withFiles(threadId, rows.map(toMessage));
  }

  // Fills in each message's files, without their bytes.
  private withFiles(threadId: string, messages: Message[]): Message[] {
    if (!messages.length) return messages;
    const rows = this.db
      .prepare("SELECT id, message_id, name, type, size FROM files WHERE thread_id = ? AND message_id >= ? ORDER BY message_id, position")
      .all(threadId, messages[0].id) as unknown as (Attachment & { message_id: number })[];
    const byMessage = new Map<number, Attachment[]>();
    for (const { message_id, ...f } of rows) {
      if (!byMessage.has(message_id)) byMessage.set(message_id, []);
      byMessage.get(message_id)!.push(f);
    }
    for (const m of messages) m.files = byMessage.get(m.id) ?? [];
    return messages;
  }

  file(id: string): (Attachment & { threadId: string; data: Uint8Array }) | null {
    const row = this.db.prepare("SELECT id, thread_id, name, type, size, data FROM files WHERE id = ?").get(id) as
      | (Attachment & { thread_id: string; data: Uint8Array })
      | undefined;
    if (!row) return null;
    const { thread_id, ...f } = row;
    return { ...f, threadId: thread_id };
  }

  readSeq(reader: string, threadId: string): number {
    const row = this.db.prepare("SELECT seq FROM thread_reads WHERE reader = ? AND thread_id = ?").get(reader, threadId) as
      | { seq: number }
      | undefined;
    return row?.seq ?? 0;
  }

  markRead(reader: string, threadId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO thread_reads (reader, thread_id, seq) VALUES (?, ?, ?)
         ON CONFLICT (reader, thread_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      )
      .run(reader, threadId, seq);
  }

  // Leaves updated_at alone: seeing a thread is not news for the list.
  markAskerSeen(threadId: string, seq: number): void {
    this.db.prepare("UPDATE threads SET asker_seen = MAX(asker_seen, ?) WHERE id = ?").run(seq, threadId);
  }

  // Leaves updated_at alone, which says since when the request waits.
  markReminded(threadId: string): void {
    this.db.prepare("UPDATE threads SET reminded = 1 WHERE id = ?").run(threadId);
  }

  markReplyMailed(threadId: string, seq: number): void {
    this.db.prepare("UPDATE threads SET reply_mailed = MAX(reply_mailed, ?) WHERE id = ?").run(seq, threadId);
  }

  // Threads where the asked side said something before `before` that the
  // asking AI has not been shown and nobody was mailed about: the latest such
  // message of each.
  unseenReplies(before: string): { thread: Thread; message: Message }[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, m.seq AS reply_seq FROM threads t
         JOIN messages m ON m.thread_id = t.id AND m.sender = t.to_agent
         WHERE m.seq > t.asker_seen AND m.seq > t.reply_mailed AND m.created_at <= ?
           AND m.seq = (SELECT MAX(seq) FROM messages WHERE thread_id = t.id AND sender = t.to_agent)`,
      )
      .all(before) as unknown as (ThreadRow & { reply_seq: number })[];
    return rows.map((row) => ({
      thread: toThread(row),
      message: this.messages(row.id, row.reply_seq - 1)[0],
    }));
  }

  // Who wrote each message after `seq`, leaving out Achat's own notes.
  sendersAfter(threadId: string, seq: number): (string | null)[] {
    return (
      this.db
        .prepare("SELECT sender FROM messages WHERE thread_id = ? AND seq > ? AND kind != 'system'")
        .all(threadId, seq) as { sender: string | null }[]
    ).map((r) => r.sender);
  }

  lastMessage(threadId: string): Message | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1")
      .get(threadId) as MessageRow | undefined;
    return row ? this.withFiles(threadId, [toMessage(row)])[0] : null;
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
