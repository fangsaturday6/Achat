import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanFiles } from "../src/attachments.js";
import { Store } from "../src/relay/store.js";

test("a database from before keeps its files, and a group's files go in the same table", () => {
  const path = join(mkdtempSync(join(tmpdir(), "achat-files-")), "achat.db");
  // The files table as it was: tied to messages(id).
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, topic TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, status TEXT NOT NULL, max_rounds INTEGER NOT NULL, budget_usd REAL NOT NULL, rounds_used INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, responder_session TEXT, quiet INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id), seq INTEGER NOT NULL, sender TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, redactions INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (thread_id, seq));
    CREATE TABLE files (id TEXT PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id), thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL);
    INSERT INTO threads (id, topic, from_agent, to_agent, status, max_rounds, budget_usd, created_at, updated_at) VALUES ('t1', '话题', 'a', 'b', 'active', 5, 5, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
    INSERT INTO messages (thread_id, seq, sender, kind, body, created_at) VALUES ('t1', 1, 'a', 'request', '看图', '2026-11-01T00:00:00Z');
    INSERT INTO files VALUES ('f_old', 1, 't1', 0, 'a.png', 'image/png', 3, x'010203');
    INSERT INTO files VALUES ('f_big', 1, 'big', 1, 'big.bin', 'application/octet-stream', 3000000, zeroblob(3000000));
  `);
  old.close();

  const store = new Store(path);
  // The rebuild went through the -wal file; it is given back, not left as big as the attachments.
  assert.ok(!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0, "the -wal file is emptied after the rebuild");
  assert.deepEqual(store.messages("t1")[0].files.map((f) => f.name), ["a.png"]);
  assert.deepEqual([...store.file("f_old")!.data], [1, 2, 3]);
  // No row in messages has this id: a group message's files are keyed by its group.
  store.addFiles("g_test", 999, [{ name: "b.txt", type: "text/plain", data: new Uint8Array([4]) }]);
  const [held] = store.filesFor("g_test", [{ id: 999, files: [] as { id: string; name: string; type: string; size: number }[] }]);
  assert.deepEqual(held.files.map((f) => f.name), ["b.txt"]);
  assert.equal(store.file(held.files[0].id)!.threadId, "g_test");
  store.close();

  // Checked on the file itself, not through Store: no foreign key left, and a second start changes nothing.
  const check = (): { links: number; rows: unknown[] } => {
    const db = new DatabaseSync(path);
    const links = db.prepare("PRAGMA foreign_key_list(files)").all().length;
    const rows = db.prepare("SELECT id, message_id, thread_id, position, name, type, size, hex(data) AS data FROM files ORDER BY id").all();
    db.close();
    return { links, rows };
  };
  const first = check();
  assert.equal(first.links, 0);
  assert.equal(first.rows.length, 3);
  new Store(path).close();
  assert.deepEqual(check(), first);
  assert.deepEqual({ ...(first.rows.find((r) => (r as { id: string }).id === "f_old") as object) }, { id: "f_old", message_id: 1, thread_id: "t1", position: 0, name: "a.png", type: "image/png", size: 3, data: "010203" });
});

test("files are checked the same way wherever they are sent", () => {
  assert.deepEqual(cleanFiles([{ name: "../../x/报错.png", type: "", data: new Uint8Array([1]) }]).map((f) => [f.name, f.type]), [["报错.png", "image/png"]]);
  assert.throws(() => cleanFiles(Array.from({ length: 10 }, () => ({ name: "a.txt", type: "", data: new Uint8Array([1]) }))), /一次最多 9 个文件/);
});
