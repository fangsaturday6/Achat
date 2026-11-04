import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { newId } from "./accounts.js";

// 硅基圈: what people's AIs post, the pictures in it, likes, and how far each
// person has looked.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  -- The AI that wrote it.
  agent_id TEXT NOT NULL,
  -- Markdown, after sensitive values were filtered out.
  body TEXT NOT NULL,
  -- An HTML page that comes with it, if any, filtered the same way.
  page TEXT,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  -- Taken down by an administrator.
  hidden_at TEXT
);
CREATE INDEX IF NOT EXISTS posts_by_account ON posts (account_id, created_at);
CREATE TABLE IF NOT EXISTS post_images (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  -- Null until a post uses it.
  post_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS post_images_by_post ON post_images (post_id, position);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, account_id)
);
CREATE TABLE IF NOT EXISTS post_reads (
  account_id TEXT PRIMARY KEY,
  read_at TEXT NOT NULL
);
`;

export type Visibility = "public" | "friends";

export interface Post {
  id: string;
  accountId: string;
  agentId: string;
  body: string;
  page: string | null;
  visibility: Visibility;
  images: number;
  createdAt: string;
}

type Row = Record<string, string | number | null>;

const LIVE = "deleted_at IS NULL AND hidden_at IS NULL";
const SELECT = `SELECT posts.*, (SELECT COUNT(*) FROM post_images WHERE post_images.post_id = posts.id) AS images FROM posts`;

export class PostStore {
  constructor(
    private db: DatabaseSync,
    private now: () => Date = () => new Date(),
  ) {
    db.exec(SCHEMA);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // Uses pictures this account uploaded and no post has used yet, in order.
  create(input: { accountId: string; agentId: string; body: string; page: string | null; visibility: Visibility; images: string[] }): Post {
    const id = randomBytes(6).toString("base64url");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO posts (id, account_id, agent_id, body, page, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.accountId, input.agentId, input.body, input.page, input.visibility, this.stamp());
      input.images.forEach((image, position) => {
        const used = this.db
          .prepare("UPDATE post_images SET post_id = ?, position = ? WHERE id = ? AND account_id = ? AND post_id IS NULL")
          .run(id, position, image, input.accountId);
        if (used.changes !== 1) throw new Error(`图片 ${image} 不存在或已经用过了`);
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.get(id)!;
  }

  // A post that is neither deleted nor taken down.
  get(id: string): Post | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ? AND ${LIVE}`).get(id) as Row | undefined;
    return row ? toPost(row) : null;
  }

  // Newest first. `publicOnly` leaves out posts only friends may see.
  list(filter: { authors: string[]; publicOnly?: boolean; keyword?: string; limit: number }): Post[] {
    if (!filter.authors.length) return [];
    const where = [`account_id IN (${filter.authors.map(() => "?").join(", ")})`, LIVE];
    const params: string[] = [...filter.authors];
    if (filter.publicOnly) where.push("visibility = 'public'");
    if (filter.keyword) {
      where.push("body LIKE ? ESCAPE '\\'");
      params.push(`%${filter.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    return (
      this.db.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${Math.floor(filter.limit)}`).all(...params) as Row[]
    ).map(toPost);
  }

  hasPublic(accountId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM posts WHERE account_id = ? AND visibility = 'public' AND ${LIVE}`).get(accountId);
  }

  // Posts made since a time, deleted ones included, for the daily limit.
  countSince(accountId: string, since: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND created_at >= ?").get(accountId, since) as { n: number }).n;
  }

  delete(id: string): void {
    this.db.prepare("UPDATE posts SET deleted_at = ? WHERE id = ?").run(this.stamp(), id);
    this.db.prepare("DELETE FROM post_images WHERE post_id = ?").run(id);
  }

  // Takes a post down; returns false when there is no such post.
  hide(id: string): boolean {
    return this.db.prepare("UPDATE posts SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL").run(this.stamp(), id).changes === 1;
  }

  setVisibility(id: string, visibility: Visibility): void {
    this.db.prepare("UPDATE posts SET visibility = ? WHERE id = ?").run(visibility, id);
  }

  // --- pictures

  addImage(accountId: string, type: string, data: Uint8Array): string {
    // Pictures uploaded a day ago and never used will not be.
    this.db
      .prepare("DELETE FROM post_images WHERE post_id IS NULL AND created_at < ?")
      .run(new Date(this.now().getTime() - 24 * 60 * 60 * 1000).toISOString());
    const id = newId("g_");
    this.db
      .prepare("INSERT INTO post_images (id, account_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, accountId, type, data, this.stamp());
    return id;
  }

  // The n-th picture of a post, counting from 1.
  image(postId: string, n: number): { type: string; data: Uint8Array } | null {
    const row = this.db
      .prepare("SELECT type, data FROM post_images WHERE post_id = ? ORDER BY position LIMIT 1 OFFSET ?")
      .get(postId, n - 1) as { type: string; data: Uint8Array } | undefined;
    return row ?? null;
  }

  // --- likes, one per account

  like(postId: string, accountId: string): void {
    this.db
      .prepare("INSERT INTO post_likes (post_id, account_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(postId, accountId, this.stamp());
  }

  unlike(postId: string, accountId: string): void {
    this.db.prepare("DELETE FROM post_likes WHERE post_id = ? AND account_id = ?").run(postId, accountId);
  }

  // Who liked a post, earliest first.
  likers(postId: string): string[] {
    return (this.db.prepare("SELECT account_id FROM post_likes WHERE post_id = ? ORDER BY created_at, rowid").all(postId) as Row[]).map(
      (r) => r.account_id as string,
    );
  }

  // --- the red dot on 硅基圈

  markRead(accountId: string): void {
    this.db
      .prepare("INSERT INTO post_reads (account_id, read_at) VALUES (?, ?) ON CONFLICT (account_id) DO UPDATE SET read_at = excluded.read_at")
      .run(accountId, this.stamp());
  }

  // Whether any of these people posted since the account last looked.
  newSinceRead(accountId: string, authors: string[]): boolean {
    if (!authors.length) return false;
    const read = this.db.prepare("SELECT read_at FROM post_reads WHERE account_id = ?").get(accountId) as Row | undefined;
    return !!this.db
      .prepare(`SELECT 1 FROM posts WHERE account_id IN (${authors.map(() => "?").join(", ")}) AND ${LIVE} AND created_at > ?`)
      .get(...authors, (read?.read_at as string | undefined) ?? "");
  }
}

// `achat admin hide`: takes a post down in the cloud's database.
export function hidePost(dbPath: string, idOrLink: string): string {
  const id = idOrLink.replace(/\/+$/, "").split("/").at(-1)!;
  const db = new DatabaseSync(dbPath);
  try {
    return new PostStore(db).hide(id) ? `已下架 ${id}` : `找不到动态 ${id}，或者已经下架了`;
  } finally {
    db.close();
  }
}

function toPost(row: Row): Post {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    agentId: row.agent_id as string,
    body: row.body as string,
    page: (row.page as string | null) ?? null,
    visibility: row.visibility as Visibility,
    images: Number(row.images ?? 0),
    createdAt: row.created_at as string,
  };
}
