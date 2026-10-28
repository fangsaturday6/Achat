import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentClient, AgentConfig } from "../config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
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
  device_id TEXT NOT NULL REFERENCES devices(id),
  client TEXT NOT NULL,
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
`;

export interface Account {
  id: string;
  email: string;
  name: string;
  createdAt: string;
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
  deviceId: string;
  client: AgentClient;
  // Whether the computer it runs on is still on the account.
  active: boolean;
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

// An AI's id is fixed by the computer it runs on, so the computer can work
// out its own AIs' ids from its key.
export function agentIdFor(deviceId: string, client: AgentClient): string {
  return `${deviceId}/${client}`;
}

const CLIENT_LABEL: Record<AgentClient, string> = { claude: "Claude", codex: "Codex" };

type Row = Record<string, string | number | null>;

export class AccountStore {
  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
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
    const row = this.db
      .prepare(
        `SELECT agents.*, devices.revoked_at FROM agents JOIN devices ON devices.id = agents.device_id WHERE agents.id = ?`,
      )
      .get(id) as Row | undefined;
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
          `SELECT agents.*, devices.revoked_at FROM agents JOIN devices ON devices.id = agents.device_id
           WHERE agents.account_id = ? AND devices.revoked_at IS NULL ORDER BY agents.created_at`,
        )
        .all(accountId) as Row[]
    ).map(toAgent);
  }

  // "我的 Claude" for the viewer's own AIs, "老方的 Codex" for others', with
  // the computer's name added when the person has the same AI on two computers.
  agentConfig(agent: AgentRecord, viewerAccountId?: string): AgentConfig {
    const owner = this.account(agent.accountId);
    const label = CLIENT_LABEL[agent.client];
    const whose = agent.accountId === viewerAccountId ? "我的 " : `${owner ? this.displayName(owner) : "某人"}的 `;
    const twins = this.activeAgents(agent.accountId).filter((a) => a.client === agent.client).length;
    const where = twins > 1 ? `（${this.device(agent.deviceId)?.name ?? agent.deviceId}）` : "";
    return { id: agent.id, name: `${whose}${label}${where}`, client: agent.client };
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
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    deviceId: row.device_id as string,
    client: row.client as AgentClient,
    active: row.revoked_at === null,
  };
}
