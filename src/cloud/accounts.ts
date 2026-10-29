import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentClient, AgentConfig, AiClient, RemoteClient } from "../config.js";
import { agentIdFor } from "../device.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  email_notify INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS device_links (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  clients TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  -- Set for AIs that run on a computer; null for AIs that connect with a credential.
  device_id TEXT REFERENCES devices(id),
  client TEXT NOT NULL,
  label TEXT,
  token_hash TEXT UNIQUE,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  contact_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, contact_id)
);
CREATE TABLE IF NOT EXISTS enroll_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  device_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_emails (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  from_account TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS request_emails_by_pair ON request_emails (account_id, from_account, sent_at);
`;

const SCHEMA_VERSION = 2;

// Version 1 had computer AIs only (agents.device_id NOT NULL) and no email
// preference. Rebuilds the agents table in place, keeping its rows.
const MIGRATE_FROM_1 = `
CREATE TABLE agents_v2 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  device_id TEXT REFERENCES devices(id),
  client TEXT NOT NULL,
  label TEXT,
  token_hash TEXT UNIQUE,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO agents_v2 (id, account_id, device_id, client, created_at)
  SELECT id, account_id, device_id, client, created_at FROM agents;
DROP TABLE agents;
ALTER TABLE agents_v2 RENAME TO agents;
ALTER TABLE accounts ADD COLUMN email_notify INTEGER NOT NULL DEFAULT 1;
`;

export interface Account {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  // Email the person when someone sends one of their AIs a request.
  emailNotify: boolean;
}

export interface Device {
  id: string;
  accountId: string;
  name: string;
  publicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface DeviceLink {
  id: string;
  deviceId: string;
  name: string;
  publicKey: string;
  clients: AgentClient[];
  expiresAt: number;
  approvedBy: string | null;
}

export interface AgentRecord {
  id: string;
  accountId: string;
  // The computer it runs on; null for an AI that connects with a credential.
  deviceId: string | null;
  client: AiClient;
  // A name the person gave it, for "other" AIs.
  label: string | null;
  // Not removed, and its computer, if any, still on the account.
  active: boolean;
  // Only AIs on a computer answer requests, in the background.
  canReceive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface Invite {
  accountId: string;
  expiresAt: number;
  usedBy: string | null;
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newId(prefix: string, bytes = 8): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

export const CLIENT_LABEL: Record<AiClient, string> = {
  claude: "Claude",
  codex: "Codex",
  doubao: "豆包",
  workbuddy: "WorkBuddy",
  other: "AI",
};

type Row = Record<string, string | number | null>;

const AGENT_SELECT =
  "SELECT agents.*, devices.revoked_at AS device_revoked_at FROM agents LEFT JOIN devices ON devices.id = agents.device_id";

export class AccountStore {
  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date(),
  ) {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get();
    if (existing && version < SCHEMA_VERSION) {
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => db.exec(MIGRATE_FROM_1));
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    }
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // --- accounts and sessions

  account(id: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return row ? toAccount(row) : null;
  }

  accountByEmail(email: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as Row | undefined;
    return row ? toAccount(row) : null;
  }

  createAccount(email: string): Account {
    const id = newId("a_");
    this.db.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)").run(id, email, this.stamp());
    return this.account(id)!;
  }

  rename(id: string, name: string): Account {
    this.db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id);
    return this.account(id)!;
  }

  setEmailNotify(id: string, on: boolean): Account {
    this.db.prepare("UPDATE accounts SET email_notify = ? WHERE id = ?").run(on ? 1 : 0, id);
    return this.account(id)!;
  }

  // The name other people see; falls back to the part of the email before @.
  displayName(account: Account): string {
    return account.name || account.email.split("@")[0];
  }

  saveLoginCode(email: string, codeHash: string, expiresAt: number, sentAt: number): void {
    this.db
      .prepare(
        `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
           attempts = 0, sent_at = excluded.sent_at`,
      )
      .run(email, codeHash, expiresAt, sentAt);
  }

  loginCode(email: string): { codeHash: string; expiresAt: number; attempts: number; sentAt: number } | null {
    const row = this.db.prepare("SELECT * FROM login_codes WHERE email = ?").get(email) as Row | undefined;
    if (!row) return null;
    return {
      codeHash: row.code_hash as string,
      expiresAt: row.expires_at as number,
      attempts: row.attempts as number,
      sentAt: row.sent_at as number,
    };
  }

  countLoginAttempt(email: string): void {
    this.db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
  }

  deleteLoginCode(email: string): void {
    this.db.prepare("DELETE FROM login_codes WHERE email = ?").run(email);
  }

  createSession(accountId: string, ttlMs: number): string {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashSecret(token), accountId, this.now().getTime() + ttlMs, this.stamp());
    return token;
  }

  sessionAccount(token: string): Account | null {
    const row = this.db
      .prepare("SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(hashSecret(token), this.now().getTime()) as Row | undefined;
    return row ? this.account(row.account_id as string) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSecret(token));
  }

  // --- devices

  device(id: string): Device | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return row ? toDevice(row) : null;
  }

  devices(accountId: string): Device[] {
    return (
      this.db
        .prepare("SELECT * FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at")
        .all(accountId) as Row[]
    ).map(toDevice);
  }

  touchDevice(id: string): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.stamp(), id);
  }

  revokeDevice(id: string): void {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.stamp(), id);
  }

  createDeviceLink(link: Omit<DeviceLink, "id" | "approvedBy">): DeviceLink {
    const id = newId("l_", 12);
    this.db
      .prepare(
        "INSERT INTO device_links (id, device_id, name, public_key, clients, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, link.deviceId, link.name, link.publicKey, link.clients.join(","), link.expiresAt);
    return this.deviceLink(id)!;
  }

  deviceLink(id: string): DeviceLink | null {
    const row = this.db.prepare("SELECT * FROM device_links WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      deviceId: row.device_id as string,
      name: row.name as string,
      publicKey: row.public_key as string,
      clients: (row.clients as string).split(",").filter(Boolean) as AgentClient[],
      expiresAt: row.expires_at as number,
      approvedBy: (row.approved_by as string | null) ?? null,
    };
  }

  // Adds the computer and its AIs to the account. A computer that was removed
  // from the same account can be added back with the same key.
  approveDeviceLink(link: DeviceLink, accountId: string): Device {
    const now = this.stamp();
    this.transaction(() => {
      this.db.prepare("UPDATE device_links SET approved_by = ? WHERE id = ?").run(accountId, link.id);
      this.db
        .prepare(
          `INSERT INTO devices (id, account_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, revoked_at = NULL`,
        )
        .run(link.deviceId, accountId, link.name, link.publicKey, now);
      for (const client of link.clients) {
        this.db
          .prepare(
            "INSERT INTO agents (id, account_id, device_id, client, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
          )
          .run(agentIdFor(link.deviceId, client), accountId, link.deviceId, client, now);
      }
    });
    return this.device(link.deviceId)!;
  }

  // --- agents

  agent(id: string): AgentRecord | null {
    const row = this.db.prepare(`${AGENT_SELECT} WHERE agents.id = ?`).get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  // Every AI the account ever had, including on computers since removed, so
  // their past threads stay visible.
  agentIds(accountId: string): string[] {
    return (this.db.prepare("SELECT id FROM agents WHERE account_id = ?").all(accountId) as Row[]).map(
      (r) => r.id as string,
    );
  }

  activeAgents(accountId: string): AgentRecord[] {
    return (
      this.db
        .prepare(
          `${AGENT_SELECT} WHERE agents.account_id = ? AND agents.revoked_at IS NULL AND devices.revoked_at IS NULL
           ORDER BY agents.created_at`,
        )
        .all(accountId) as Row[]
    ).map(toAgent);
  }

  // "我的 Claude" for the viewer's own AIs, "老方的豆包" for others', with
  // the computer's name added when the person has the same AI on two computers.
  agentConfig(agent: AgentRecord, viewerAccountId?: string): AgentConfig {
    const owner = this.account(agent.accountId);
    const label = agent.label ?? CLIENT_LABEL[agent.client];
    const whose = agent.accountId === viewerAccountId ? "我的" : `${owner ? this.displayName(owner) : "某人"}的`;
    const space = /^[A-Za-z0-9]/.test(label) ? " " : "";
    const twins = agent.deviceId
      ? this.activeAgents(agent.accountId).filter((a) => a.client === agent.client && a.deviceId).length
      : 1;
    const where = twins > 1 ? `（${this.device(agent.deviceId!)?.name ?? agent.deviceId}）` : "";
    return { id: agent.id, name: `${whose}${space}${label}${where}`, client: agent.client, canReceive: agent.canReceive };
  }

  // --- AIs that connect with a credential (豆包, WorkBuddy, ...)

  // Creates the AI, or gives an existing one of the same kind and name a new
  // credential, which ends the old one. The credential is returned once.
  connectRemoteAgent(accountId: string, client: RemoteClient, label: string | null): { agent: AgentRecord; token: string } {
    const token = "ac_" + randomBytes(24).toString("base64url");
    const existing = this.activeAgents(accountId).find(
      (a) => !a.deviceId && a.client === client && (a.label ?? null) === label,
    );
    if (existing) {
      this.db
        .prepare("UPDATE agents SET token_hash = ?, last_used_at = NULL WHERE id = ?")
        .run(hashSecret(token), existing.id);
      return { agent: this.agent(existing.id)!, token };
    }
    const id = newId("r_");
    this.db
      .prepare(
        "INSERT INTO agents (id, account_id, device_id, client, label, token_hash, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
      )
      .run(id, accountId, client, label, hashSecret(token), this.stamp());
    return { agent: this.agent(id)!, token };
  }

  // The AI a credential belongs to, if it is still valid; records the use.
  agentByToken(token: string): AgentRecord | null {
    const row = this.db
      .prepare(`${AGENT_SELECT} WHERE agents.token_hash = ? AND agents.revoked_at IS NULL`)
      .get(hashSecret(token)) as Row | undefined;
    if (!row) return null;
    const agent = toAgent(row);
    if (!agent.lastUsedAt || this.now().getTime() - Date.parse(agent.lastUsedAt) > 60_000) {
      this.db.prepare("UPDATE agents SET last_used_at = ? WHERE id = ?").run(this.stamp(), agent.id);
    }
    return agent;
  }

  revokeAgent(id: string): void {
    this.db.prepare("UPDATE agents SET revoked_at = ?, token_hash = NULL WHERE id = ?").run(this.stamp(), id);
  }

  // --- one-time credentials that add a computer without a confirmation page

  createEnrollToken(accountId: string, ttlMs: number): { id: string; token: string; expiresAt: number } {
    const id = newId("e_");
    const token = "ac_" + randomBytes(24).toString("base64url");
    const expiresAt = this.now().getTime() + ttlMs;
    this.db
      .prepare("INSERT INTO enroll_tokens (id, account_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, accountId, hashSecret(token), expiresAt, this.stamp());
    return { id, token, expiresAt };
  }

  // A credential that is unused and not expired.
  enrollToken(token: string): { id: string; accountId: string } | null {
    const row = this.db
      .prepare("SELECT * FROM enroll_tokens WHERE token_hash = ? AND device_id IS NULL AND expires_at > ?")
      .get(hashSecret(token), this.now().getTime()) as Row | undefined;
    return row ? { id: row.id as string, accountId: row.account_id as string } : null;
  }

  useEnrollToken(id: string, deviceId: string): void {
    this.db.prepare("UPDATE enroll_tokens SET device_id = ? WHERE id = ?").run(deviceId, id);
  }

  enrollStatus(id: string, accountId: string): { deviceId: string | null; expiresAt: number } | null {
    const row = this.db
      .prepare("SELECT * FROM enroll_tokens WHERE id = ? AND account_id = ?")
      .get(id, accountId) as Row | undefined;
    return row ? { deviceId: (row.device_id as string | null) ?? null, expiresAt: row.expires_at as number } : null;
  }

  // --- request emails, counted per sender so one contact cannot flood an inbox

  countRequestEmails(accountId: string, fromAccount: string, since: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM request_emails WHERE account_id = ? AND from_account = ? AND sent_at >= ?")
        .get(accountId, fromAccount, since) as { n: number }
    ).n;
  }

  logRequestEmail(accountId: string, fromAccount: string): void {
    this.db
      .prepare("INSERT INTO request_emails (account_id, from_account, sent_at) VALUES (?, ?, ?)")
      .run(accountId, fromAccount, this.now().getTime());
  }

  // --- invites and contacts

  createInvite(accountId: string, ttlMs: number): { code: string; expiresAt: number } {
    const code = randomBytes(16).toString("base64url");
    const expiresAt = this.now().getTime() + ttlMs;
    this.db
      .prepare("INSERT INTO invites (code_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashSecret(code), accountId, expiresAt, this.stamp());
    return { code, expiresAt };
  }

  invite(code: string): Invite | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hashSecret(code)) as Row | undefined;
    if (!row) return null;
    return {
      accountId: row.account_id as string,
      expiresAt: row.expires_at as number,
      usedBy: (row.used_by as string | null) ?? null,
    };
  }

  acceptInvite(code: string, accountId: string, inviterId: string): void {
    const now = this.stamp();
    this.transaction(() => {
      this.db.prepare("UPDATE invites SET used_by = ? WHERE code_hash = ?").run(accountId, hashSecret(code));
      const add = this.db.prepare(
        "INSERT INTO contacts (account_id, contact_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      );
      add.run(accountId, inviterId, now);
      add.run(inviterId, accountId, now);
    });
  }

  isContact(accountId: string, otherId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM contacts WHERE account_id = ? AND contact_id = ?").get(accountId, otherId);
  }

  contacts(accountId: string): Account[] {
    return (
      this.db
        .prepare(
          `SELECT accounts.* FROM contacts JOIN accounts ON accounts.id = contacts.contact_id
           WHERE contacts.account_id = ? ORDER BY contacts.created_at`,
        )
        .all(accountId) as Row[]
    ).map(toAccount);
  }

  removeContact(accountId: string, otherId: string): void {
    this.db
      .prepare(
        "DELETE FROM contacts WHERE (account_id = ? AND contact_id = ?) OR (account_id = ? AND contact_id = ?)",
      )
      .run(accountId, otherId, otherId, accountId);
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function toAccount(row: Row): Account {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    emailNotify: row.email_notify !== 0,
  };
}

function toDevice(row: Row): Device {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    name: row.name as string,
    publicKey: row.public_key as string,
    createdAt: row.created_at as string,
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
  };
}

function toAgent(row: Row): AgentRecord {
  const deviceId = (row.device_id as string | null) ?? null;
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    deviceId,
    client: row.client as AiClient,
    label: (row.label as string | null) ?? null,
    active: row.revoked_at === null && row.device_revoked_at === null,
    canReceive: deviceId !== null,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}
