import type { NewFile } from "../attachments.js";
import { isEffort, type Effort } from "../models.js";
import type { Group, GroupAct, GroupActStatus, GroupMessage, GroupStatus, Receipt, ReceiptState } from "../types.js";
import { addColumn, type Store } from "./store.js";

// 群（8n）: tables of their own beside the threads', in the same file. A
// group's files are in the threads' files table, keyed by the group's id.
// ("groups" is an SQL keyword, hence chat_groups.)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 群主: an account.
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  -- Goes up with every 叫停.
  epoch INTEGER NOT NULL DEFAULT 0,
  opener_seq INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The AIs in a group. The row stays when one leaves (left_at).
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES chat_groups(id),
  agent TEXT NOT NULL,
  owner TEXT NOT NULL,
  quota INTEGER NOT NULL,
  -- The last message before it joined: it sees 20 before that and all after.
  joined_seq INTEGER NOT NULL,
  -- How far its background session has read, and which session.
  read_seq INTEGER NOT NULL DEFAULT 0,
  session TEXT,
  -- How far its front session, the one its person talks to, looked.
  seen_seq INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (group_id, agent)
);
-- The groups an AI is in, for its computer and its front session.
CREATE INDEX IF NOT EXISTS group_members_by_agent ON group_members (agent);
CREATE TABLE IF NOT EXISTS group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_groups(id),
  -- The person invited, and the AI asked for by name (null: they pick).
  account TEXT NOT NULL,
  agent TEXT,
  invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_invites_by_account ON group_invites (account, answered);
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES chat_groups(id),
  seq INTEGER NOT NULL,
  sender TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  reply_to INTEGER,
  by_person INTEGER NOT NULL DEFAULT 0,
  redactions INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT,
  effort TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (group_id, seq)
);
-- What became of each AI a message woke.
CREATE TABLE IF NOT EXISTS group_receipts (
  group_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agent TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  epoch INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, seq, agent)
);
-- How many times each AI was woken in a group, per day in 北京时间; how many
-- more its person let it be that day (加一份), and whether they were told it
-- was nearly used up.
CREATE TABLE IF NOT EXISTS group_usage (
  group_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  extra INTEGER NOT NULL DEFAULT 0,
  warned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, agent, day)
);
CREATE TABLE IF NOT EXISTS group_reads (
  reader TEXT NOT NULL,
  group_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (reader, group_id)
);
-- 动手 asked for in a group: who asked which AI, and how far it went. One
-- yes covers the same asker's requests for 10 rounds.
CREATE TABLE IF NOT EXISTS group_acts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES chat_groups(id),
  -- An AI, or a person's seat.
  asker TEXT NOT NULL,
  doer TEXT NOT NULL,
  status TEXT NOT NULL,
  -- Its person's own asking (GroupAct.own): no dialog.
  own INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL,
  rounds_used INTEGER NOT NULL DEFAULT 0,
  -- The latest message that asked.
  ask_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_acts_by_doer ON group_acts (group_id, doer, status);
`;

export interface MemberRow {
  groupId: string;
  agent: string;
  owner: string;
  quota: number;
  joinedSeq: number;
  readSeq: number;
  session: string | null;
  seenSeq: number;
  joinedAt: string;
  leftAt: string | null;
}

export interface InviteRow {
  id: string;
  groupId: string;
  account: string;
  agent: string | null;
  invitedBy: string;
  expiresAt: string;
  answered: "accepted" | "declined" | null;
  createdAt: string;
}

export interface StoredReceipt extends Receipt {
  seq: number;
  epoch: number;
  updatedAt: string;
}

export interface NewGroupMessage {
  sender: string | null;
  kind: "message" | "system";
  body: string;
  mentions?: string[];
  replyTo?: number | null;
  byPerson?: boolean;
  redactions?: number;
  costUsd?: number;
  files?: NewFile[];
  model?: string | null;
  effort?: Effort | null;
}

export interface GroupPatch {
  name?: string;
  owner?: string;
  status?: GroupStatus;
  epoch?: number;
  openerSeq?: number | null;
}

type Row = Record<string, string | number | null>;

function toGroup(r: Row): Group {
  return {
    id: r.id as string,
    name: r.name as string,
    owner: r.owner as string,
    status: r.status as GroupStatus,
    epoch: r.epoch as number,
    openerSeq: (r.opener_seq as number | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toMember(r: Row): MemberRow {
  return {
    groupId: r.group_id as string,
    agent: r.agent as string,
    owner: r.owner as string,
    quota: r.quota as number,
    joinedSeq: r.joined_seq as number,
    readSeq: r.read_seq as number,
    session: (r.session as string | null) ?? null,
    seenSeq: r.seen_seq as number,
    joinedAt: r.joined_at as string,
    leftAt: (r.left_at as string | null) ?? null,
  };
}

function toInvite(r: Row): InviteRow {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    account: r.account as string,
    agent: (r.agent as string | null) ?? null,
    invitedBy: r.invited_by as string,
    expiresAt: r.expires_at as string,
    answered: (r.answered as "accepted" | "declined" | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toReceipt(r: Row): StoredReceipt {
  return {
    agent: r.agent as string,
    state: r.state as ReceiptState,
    reason: (r.reason as string | null) ?? null,
    seq: r.seq as number,
    epoch: r.epoch as number,
    updatedAt: r.updated_at as string,
  };
}

function toMessage(r: Row): GroupMessage {
  return {
    id: r.id as number,
    groupId: r.group_id as string,
    seq: r.seq as number,
    sender: (r.sender as string | null) ?? null,
    kind: r.kind === "system" ? "system" : "message",
    body: r.body as string,
    mentions: JSON.parse(r.mentions as string) as string[],
    replyTo: (r.reply_to as number | null) ?? null,
    byPerson: r.by_person === 1,
    redactions: r.redactions as number,
    costUsd: r.cost_usd as number,
    files: [],
    receipts: [],
    model: (r.model as string | null) ?? null,
    effort: isEffort(r.effort) ? r.effort : null,
    createdAt: r.created_at as string,
  };
}

function toAct(r: Row): GroupAct {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    asker: r.asker as string,
    doer: r.doer as string,
    status: r.status as GroupActStatus,
    own: r.own === 1,
    maxRounds: r.max_rounds as number,
    roundsUsed: r.rounds_used as number,
    askSeq: r.ask_seq as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export interface GroupActPatch {
  status?: GroupActStatus;
  roundsUsed?: number;
  askSeq?: number;
}

export class GroupStore {
  readonly db: Store["db"];

  constructor(private store: Store) {
    this.db = store.db;
    this.db.exec(SCHEMA);
    // Columns added later; older rows take the defaults (nothing added, nobody
    // told).
    addColumn(this.db, "group_usage", "extra", "INTEGER NOT NULL DEFAULT 0");
    addColumn(this.db, "group_usage", "warned", "INTEGER NOT NULL DEFAULT 0");
    // Acts from before were all asked for by someone else: their person said yes.
    addColumn(this.db, "group_acts", "own", "INTEGER NOT NULL DEFAULT 0");
    // Members from before have their front session start where their group
    // is now: what was answered before is no news, as for one joining now.
    if (addColumn(this.db, "group_members", "seen_seq", "INTEGER NOT NULL DEFAULT 0")) {
      this.db.exec("UPDATE group_members SET seen_seq = (SELECT COALESCE(MAX(seq), 0) FROM group_messages WHERE group_id = group_members.group_id)");
    }
  }

  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }

  createGroup(g: { id: string; name: string; owner: string }, now: string): Group {
    this.db.prepare("INSERT INTO chat_groups (id, name, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(g.id, g.name, g.owner, now, now);
    return this.group(g.id)!;
  }

  group(id: string): Group | null {
    const r = this.db.prepare("SELECT * FROM chat_groups WHERE id = ?").get(id) as Row | undefined;
    return r ? toGroup(r) : null;
  }

  updateGroup(id: string, patch: GroupPatch, now: string): Group {
    const sets = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.owner !== undefined) {
      sets.push("owner = ?");
      params.push(patch.owner);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.epoch !== undefined) {
      sets.push("epoch = ?");
      params.push(patch.epoch);
    }
    if (patch.openerSeq !== undefined) {
      sets.push("opener_seq = ?");
      params.push(patch.openerSeq);
    }
    params.push(id);
    this.db.prepare(`UPDATE chat_groups SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.group(id)!;
  }

  // Groups where any of these AIs is a member now, the latest first.
  groupsWith(agents: string[]): Group[] {
    if (!agents.length) return [];
    const marks = agents.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT * FROM chat_groups WHERE id IN (SELECT group_id FROM group_members WHERE left_at IS NULL AND agent IN (${marks}))
           ORDER BY updated_at DESC`,
        )
        .all(...agents) as Row[]
    ).map(toGroup);
  }

  member(groupId: string, agent: string): MemberRow | null {
    const r = this.db.prepare("SELECT * FROM group_members WHERE group_id = ? AND agent = ?").get(groupId, agent) as Row | undefined;
    return r ? toMember(r) : null;
  }

  // The members now, in the order they joined.
  members(groupId: string): MemberRow[] {
    return (this.db.prepare("SELECT * FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY joined_at, rowid").all(groupId) as Row[]).map(toMember);
  }

  // Joins, or joins again after leaving, from where the group is now: what
  // was answered before is no news to its front session.
  addMember(m: { groupId: string; agent: string; owner: string; quota: number; joinedSeq: number }, now: string): void {
    this.db
      .prepare(
        `INSERT INTO group_members (group_id, agent, owner, quota, joined_seq, seen_seq, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, agent) DO UPDATE SET owner = excluded.owner, quota = excluded.quota, joined_seq = excluded.joined_seq,
           joined_at = excluded.joined_at, read_seq = 0, session = NULL, seen_seq = excluded.seen_seq, left_at = NULL`,
      )
      .run(m.groupId, m.agent, m.owner, m.quota, m.joinedSeq, m.joinedSeq, now);
  }

  leaveMember(groupId: string, agent: string, now: string): void {
    this.db.prepare("UPDATE group_members SET left_at = ? WHERE group_id = ? AND agent = ?").run(now, groupId, agent);
  }

  setQuota(groupId: string, agent: string, quota: number): void {
    this.db.prepare("UPDATE group_members SET quota = ? WHERE group_id = ? AND agent = ?").run(quota, groupId, agent);
  }

  // How far its background session read, and the session, once it answered.
  setRead(groupId: string, agent: string, readSeq: number, session: string | null): void {
    this.db
      .prepare("UPDATE group_members SET read_seq = MAX(read_seq, ?), session = COALESCE(?, session) WHERE group_id = ? AND agent = ?")
      .run(readSeq, session, groupId, agent);
  }

  // How far an AI's front session looked in a group; it only goes forward.
  markSeen(groupId: string, agent: string, seq: number): void {
    this.db.prepare("UPDATE group_members SET seen_seq = MAX(seen_seq, ?) WHERE group_id = ? AND agent = ?").run(seq, groupId, agent);
  }

  // The groups `agent` is in where, after its front session last looked,
  // someone else answered a message it wrote in front (their reply_to is one
  // of its messages that answer nothing: its background answers and 动手's
  // results each answer an @), each with the newest such answer; the latest first.
  unseenReplies(agent: string): { groupId: string; seq: number }[] {
    return (
      this.db
        .prepare(
          `SELECT r.group_id, MAX(r.seq) AS seq, MAX(r.id) AS latest FROM group_members m
           JOIN group_messages r ON r.group_id = m.group_id AND r.seq > m.seen_seq AND r.kind = 'message' AND r.sender IS NOT m.agent
           JOIN group_messages mine ON mine.group_id = r.group_id AND mine.seq = r.reply_to AND mine.sender = m.agent AND mine.reply_to IS NULL
           WHERE m.agent = ? AND m.left_at IS NULL
           GROUP BY r.group_id ORDER BY latest DESC`,
        )
        .all(agent) as Row[]
    ).map((r) => ({ groupId: r.group_id as string, seq: r.seq as number }));
  }

  addInvite(i: Omit<InviteRow, "answered" | "createdAt">, now: string): InviteRow {
    this.db
      .prepare("INSERT INTO group_invites (id, group_id, account, agent, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(i.id, i.groupId, i.account, i.agent, i.invitedBy, i.expiresAt, now);
    return this.invite(i.id)!;
  }

  invite(id: string): InviteRow | null {
    const r = this.db.prepare("SELECT * FROM group_invites WHERE id = ?").get(id) as Row | undefined;
    return r ? toInvite(r) : null;
  }

  // Invites nobody answered that have not run out, oldest first. A dissolved
  // group has none: its invites end with it, however it ended.
  openInvites(groupId: string, now: string): InviteRow[] {
    return (
      this.db
        .prepare(
          `SELECT i.* FROM group_invites i JOIN chat_groups g ON g.id = i.group_id
           WHERE i.group_id = ? AND i.answered IS NULL AND i.expires_at > ? AND g.status != 'dissolved' ORDER BY i.created_at, i.rowid`,
        )
        .all(groupId, now) as Row[]
    ).map(toInvite);
  }

  invitesFor(account: string, now: string): InviteRow[] {
    return (
      this.db
        .prepare(
          `SELECT i.* FROM group_invites i JOIN chat_groups g ON g.id = i.group_id
           WHERE i.account = ? AND i.answered IS NULL AND i.expires_at > ? AND g.status != 'dissolved' ORDER BY i.created_at, i.rowid`,
        )
        .all(account, now) as Row[]
    ).map(toInvite);
  }

  answerInvite(id: string, answered: "accepted" | "declined"): void {
    this.db.prepare("UPDATE group_invites SET answered = ? WHERE id = ?").run(answered, id);
  }

  renewInvite(id: string, expiresAt: string): void {
    this.db.prepare("UPDATE group_invites SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  }

  lastSeq(groupId: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM group_messages WHERE group_id = ?").get(groupId) as { seq: number }).seq;
  }

  addMessage(groupId: string, m: NewGroupMessage, now: string): GroupMessage {
    const seq = this.lastSeq(groupId) + 1;
    const result = this.db
      .prepare(
        `INSERT INTO group_messages (group_id, seq, sender, kind, body, mentions, reply_to, by_person, redactions, cost_usd, model, effort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        groupId,
        seq,
        m.sender,
        m.kind,
        m.body,
        JSON.stringify(m.mentions ?? []),
        m.replyTo ?? null,
        m.byPerson ? 1 : 0,
        m.redactions ?? 0,
        m.costUsd ?? 0,
        m.model ?? null,
        m.effort ?? null,
        now,
      );
    this.store.addFiles(groupId, Number(result.lastInsertRowid), m.files ?? []);
    // A group's time in 消息 is that of its latest words.
    this.db.prepare("UPDATE chat_groups SET updated_at = ? WHERE id = ?").run(now, groupId);
    return this.message(groupId, seq)!;
  }

  message(groupId: string, seq: number): GroupMessage | null {
    const r = this.db.prepare("SELECT * FROM group_messages WHERE group_id = ? AND seq = ?").get(groupId, seq) as Row | undefined;
    return r ? this.fill(groupId, [toMessage(r)])[0] : null;
  }

  // In order, after `afterSeq`; with `limit`, only the last ones.
  messages(groupId: string, afterSeq = 0, limit?: number): GroupMessage[] {
    const rows = limit
      ? (this.db
          .prepare("SELECT * FROM (SELECT * FROM group_messages WHERE group_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq")
          .all(groupId, afterSeq, limit) as Row[])
      : (this.db.prepare("SELECT * FROM group_messages WHERE group_id = ? AND seq > ? ORDER BY seq").all(groupId, afterSeq) as Row[]);
    return this.fill(groupId, rows.map(toMessage));
  }

  private fill(groupId: string, messages: GroupMessage[]): GroupMessage[] {
    this.store.filesFor(groupId, messages);
    if (!messages.length) return messages;
    const rows = this.db
      .prepare("SELECT * FROM group_receipts WHERE group_id = ? AND seq >= ? AND seq <= ? ORDER BY rowid")
      .all(groupId, messages[0].seq, messages.at(-1)!.seq) as Row[];
    const bySeq = new Map<number, Receipt[]>();
    for (const r of rows.map(toReceipt)) {
      if (!bySeq.has(r.seq)) bySeq.set(r.seq, []);
      bySeq.get(r.seq)!.push({ agent: r.agent, state: r.state, reason: r.reason });
    }
    for (const m of messages) m.receipts = bySeq.get(m.seq) ?? [];
    return messages;
  }

  // Who wrote each message after `seq`, leaving out Achat's notes.
  sendersAfter(groupId: string, seq: number): (string | null)[] {
    return (
      this.db.prepare("SELECT sender FROM group_messages WHERE group_id = ? AND seq > ? AND kind != 'system'").all(groupId, seq) as { sender: string | null }[]
    ).map((r) => r.sender);
  }

  setReceipt(groupId: string, seq: number, agent: string, state: ReceiptState, reason: string | null, epoch: number, now: string): void {
    this.db
      .prepare(
        `INSERT INTO group_receipts (group_id, seq, agent, state, reason, epoch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, seq, agent) DO UPDATE SET state = excluded.state, reason = excluded.reason, epoch = excluded.epoch, updated_at = excluded.updated_at`,
      )
      .run(groupId, seq, agent, state, reason, epoch, now);
  }

  receipt(groupId: string, seq: number, agent: string): StoredReceipt | null {
    const r = this.db.prepare("SELECT * FROM group_receipts WHERE group_id = ? AND seq = ? AND agent = ?").get(groupId, seq, agent) as Row | undefined;
    return r ? toReceipt(r) : null;
  }

  // An AI's receipts in a group in any of `states`, newest first.
  receiptsOf(groupId: string, agent: string, states: ReceiptState[]): StoredReceipt[] {
    if (!states.length) return [];
    const marks = states.map(() => "?").join(", ");
    return (
      this.db
        .prepare(`SELECT * FROM group_receipts WHERE group_id = ? AND agent = ? AND state IN (${marks}) ORDER BY seq DESC`)
        .all(groupId, agent, ...states) as Row[]
    ).map(toReceipt);
  }

  // What `asker` asked of the AIs it woke, in any of `states`, newest first:
  // of one AI (`doer`), the requests of its act.
  requests(groupId: string, asker: string, states: ReceiptState[], doer?: string): StoredReceipt[] {
    if (!states.length) return [];
    const marks = states.map(() => "?").join(", ");
    const only = doer === undefined ? "" : " AND r.agent = ?";
    return (
      this.db
        .prepare(
          `SELECT r.* FROM group_receipts r JOIN group_messages m ON m.group_id = r.group_id AND m.seq = r.seq
           WHERE r.group_id = ? AND m.sender = ? AND r.state IN (${marks})${only} ORDER BY r.seq DESC`,
        )
        .all(groupId, asker, ...states, ...(doer === undefined ? [] : [doer])) as Row[]
    ).map(toReceipt);
  }

  // The newest message an AI is done with in a group: answered, passed on or failed.
  doneSeq(groupId: string, agent: string): number {
    return (
      this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM group_receipts WHERE group_id = ? AND agent = ? AND state IN ('replied', 'passed', 'failed')")
        .get(groupId, agent) as { seq: number }
    ).seq;
  }

  // Every receipt of a group in one state moves to another, such as 正在看 to 已叫停.
  moveAll(groupId: string, from: ReceiptState, to: ReceiptState, now: string): void {
    this.db.prepare("UPDATE group_receipts SET state = ?, updated_at = ? WHERE group_id = ? AND state = ?").run(to, now, groupId, from);
  }

  // How many times an AI was woken in a group on `day`, and how many more
  // than its 每天次数 its person let it be woken that day (加一份).
  usage(groupId: string, agent: string, day: string): { used: number; extra: number } {
    const r = this.db.prepare("SELECT used, extra FROM group_usage WHERE group_id = ? AND agent = ? AND day = ?").get(groupId, agent, day) as
      | { used: number; extra: number }
      | undefined;
    return { used: r?.used ?? 0, extra: r?.extra ?? 0 };
  }

  use(groupId: string, agent: string, day: string): void {
    this.db
      .prepare("INSERT INTO group_usage (group_id, agent, day, used) VALUES (?, ?, ?, 1) ON CONFLICT (group_id, agent, day) DO UPDATE SET used = used + 1")
      .run(groupId, agent, day);
  }

  // 加一份: another day's 每天次数 (`share`) for `day`, once. Asked again, or
  // a request tried again, it adds nothing more; a 每天次数 raised since
  // brings it up to the new one.
  addShare(groupId: string, agent: string, day: string, share: number): void {
    this.db
      .prepare(
        "INSERT INTO group_usage (group_id, agent, day, extra) VALUES (?, ?, ?, ?) ON CONFLICT (group_id, agent, day) DO UPDATE SET extra = MAX(extra, excluded.extra)",
      )
      .run(groupId, agent, day, share);
  }

  // Marks that an AI's person was told its 每天次数 for `day` is nearly used
  // up: true the first time, so they are told once a day.
  warn(groupId: string, agent: string, day: string): boolean {
    const r = this.db
      .prepare("INSERT INTO group_usage (group_id, agent, day, warned) VALUES (?, ?, ?, 1) ON CONFLICT (group_id, agent, day) DO UPDATE SET warned = 1 WHERE warned = 0")
      .run(groupId, agent, day);
    return Number(r.changes) > 0;
  }

  readSeq(reader: string, groupId: string): number {
    const r = this.db.prepare("SELECT seq FROM group_reads WHERE reader = ? AND group_id = ?").get(reader, groupId) as { seq: number } | undefined;
    return r?.seq ?? 0;
  }

  markRead(reader: string, groupId: string, seq: number): void {
    this.db
      .prepare("INSERT INTO group_reads (reader, group_id, seq) VALUES (?, ?, ?) ON CONFLICT (reader, group_id) DO UPDATE SET seq = MAX(seq, excluded.seq)")
      .run(reader, groupId, seq);
  }

  addAct(a: Omit<GroupAct, "createdAt" | "updatedAt">, now: string): GroupAct {
    this.db
      .prepare(
        `INSERT INTO group_acts (id, group_id, asker, doer, status, own, max_rounds, rounds_used, ask_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.groupId, a.asker, a.doer, a.status, a.own ? 1 : 0, a.maxRounds, a.roundsUsed, a.askSeq, now, now);
    return this.act(a.id)!;
  }

  act(id: string): GroupAct | null {
    const r = this.db.prepare("SELECT * FROM group_acts WHERE id = ?").get(id) as Row | undefined;
    return r ? toAct(r) : null;
  }

  // What `asker` asked of `doer` that still waits for its person or is under way: the latest.
  openAct(groupId: string, asker: string, doer: string): GroupAct | null {
    const r = this.db
      .prepare("SELECT * FROM group_acts WHERE group_id = ? AND asker = ? AND doer = ? AND status IN ('asking', 'active') ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(groupId, asker, doer) as Row | undefined;
    return r ? toAct(r) : null;
  }

  // The acts asked of `doer` in a group that are `status` now, the oldest first.
  actsOf(groupId: string, doer: string, status: GroupActStatus): GroupAct[] {
    return (
      this.db.prepare("SELECT * FROM group_acts WHERE group_id = ? AND doer = ? AND status = ? ORDER BY created_at, rowid").all(groupId, doer, status) as Row[]
    ).map(toAct);
  }

  updateAct(id: string, patch: GroupActPatch, now: string): GroupAct {
    const sets = ["updated_at = ?"];
    const params: (string | number)[] = [now];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.roundsUsed !== undefined) {
      sets.push("rounds_used = ?");
      params.push(patch.roundsUsed);
    }
    if (patch.askSeq !== undefined) {
      sets.push("ask_seq = ?");
      params.push(patch.askSeq);
    }
    params.push(id);
    this.db.prepare(`UPDATE group_acts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.act(id)!;
  }

  // Every act of a group still waiting or under way ends, such as at 叫停;
  // with `who`, only those asked of that AI, or by it, such as when it leaves.
  endActs(groupId: string, status: GroupActStatus, now: string, who?: { doer: string } | { asker: string }): void {
    const only = who === undefined ? "" : "doer" in who ? " AND doer = ?" : " AND asker = ?";
    this.db
      .prepare(`UPDATE group_acts SET status = ?, updated_at = ? WHERE group_id = ? AND status IN ('asking', 'active')${only}`)
      .run(status, now, groupId, ...(who === undefined ? [] : ["doer" in who ? who.doer : who.asker]));
  }
}
