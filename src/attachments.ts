import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { achatHome } from "./config.js";
import type { Message } from "./types.js";

// Pictures and other files sent with a message: the rules the relay checks,
// and how an AI's computer sends them and keeps the ones it receives.

export const MAX_FILES = 9;
export const MAX_FILES_BYTES = 20 * 1024 * 1024;
// A message with files comes as base64 inside JSON. The limit leaves room
// past 20 MB, so a little too much gets a clear answer, not a cut connection.
export const FILES_BODY_LIMIT = 40_000_000;

// A file as it is sent: the bytes in base64.
export interface OutgoingFile {
  name: string;
  type?: string;
  data: string;
}

// A file as the relay keeps it.
export interface NewFile {
  name: string;
  type: string;
  data: Uint8Array;
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".patch": "text/x-diff",
  ".diff": "text/x-diff",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Pictures the page shows. Anything else is only downloaded, so a file sent
// in a conversation can never run as a page.
export const SHOWN_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// By the name first, which the sender cannot get wrong by accident.
export function typeOf(name: string, given?: string): string {
  const known = TYPES[extname(name).toLowerCase()];
  if (known) return known;
  return given && /^[\w.+-]+\/[\w.+-]+$/.test(given) ? given.toLowerCase() : "application/octet-stream";
}

// The name without folders or control characters, at most 120 characters
// with the extension kept.
export function cleanName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!base || base === "." || base === "..") return "文件";
  if (base.length <= 120) return base;
  const ext = extname(base).slice(0, 20);
  return base.slice(0, 120 - ext.length) + ext;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Why a set of files cannot go, or null.
export function filesProblem(files: { data: Uint8Array }[]): string | null {
  if (files.length > MAX_FILES) return `一次最多 ${MAX_FILES} 个文件`;
  if (files.reduce((n, f) => n + f.data.length, 0) > MAX_FILES_BYTES) return "文件太大，一次最多 20 MB";
  return null;
}

// --- on an AI's computer

// Where this computer keeps a thread's files: what came in, and what the
// AI answering or working on it may read.
export function filesDir(threadId: string): string {
  return join(achatHome(), "files", threadId.replace(/[^\w-]/g, "_"));
}

// Files on this computer, ready to send.
export function readFiles(paths: string[]): OutgoingFile[] {
  if (paths.length > MAX_FILES) throw new Error(`一次最多 ${MAX_FILES} 个文件`);
  let total = 0;
  return paths.map((given) => {
    const path = given.startsWith("~/") ? join(homedir(), given.slice(2)) : given;
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new Error();
      size = st.size;
    } catch {
      throw new Error(`找不到文件：${given}`);
    }
    total += size;
    if (total > MAX_FILES_BYTES) throw new Error("文件太大，一次最多 20 MB");
    return { name: basename(path), type: typeOf(path), data: readFileSync(path).toString("base64") };
  });
}

// Puts a message's files in the thread's folder, each message in its own
// folder so names never clash, and gives their paths. A file already there
// is not fetched again.
export async function saveFiles(client: { file(id: string): Promise<Uint8Array> }, m: Message): Promise<string[]> {
  if (!m.files?.length) return [];
  const dir = join(filesDir(m.threadId), String(m.seq));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const used = new Set<string>();
  const paths: string[] = [];
  for (const f of m.files) {
    const clean = cleanName(f.name);
    let name = clean;
    for (let i = 2; used.has(name); i++) name = `${basename(clean, extname(clean))} (${i})${extname(clean)}`;
    used.add(name);
    const path = join(dir, name);
    if (!existsSync(path) || statSync(path).size !== f.size) writeFileSync(path, await client.file(f.id), { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}

// One line per saved file, for an AI to read: "- /path（图片，12 KB）".
export function savedLines(m: Message, paths: string[]): string[] {
  return m.files.map((f, i) => `- ${paths[i]}（${SHOWN_TYPES.has(f.type) ? "图片，" : ""}${sizeLabel(f.size)}）`);
}
