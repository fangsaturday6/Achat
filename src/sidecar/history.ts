import { createReadStream, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { Transform } from "node:stream";
import zlib from "node:zlib";
import { achatHome } from "../config.js";

// The background AI answers from the person's own history. Raw transcripts
// are JSON lines full of escaped tool output, so finding one fact in them
// took a dozen rounds of searching; it reads a plain copy instead, with who
// said what, the commands run and the start of their output.

export type HistoryKind = "claude" | "codex";

export function claudeProjectsDir(): string {
  return process.env.ACHAT_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
}

export function codexSessionsDir(): string {
  return process.env.ACHAT_CODEX_SESSIONS ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

// How much of a tool's output, and of what a tool was given, is kept.
const RESULT_CHARS = 1500;
const COMMAND_CHARS = 2000;
const INPUT_CHARS = 600;

const NAME: Record<HistoryKind, string> = { claude: "Claude", codex: "Codex" };

type Json = Record<string, any>;

function cut(text: string, max: number, lineNo?: number): string {
  if (text.length <= max) return text;
  const where = lineNo ? `全文在原始记录第 ${lineNo} 行` : "后面省略了";
  return `${text.slice(0, max)}\n……（太长，只留了开头 ${max} 字；${where}）`;
}

function when(ts: unknown, withYear = false): string {
  const d = new Date(typeof ts === "string" ? ts : NaN);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  const day = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}-${day}` : day;
}

// Text out of the shapes tool results and messages come in.
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((c: Json) => (typeof c === "string" ? c : c?.type === "image" || c?.type === "input_image" ? "[图片]" : (c?.text ?? "")))
    .filter(Boolean)
    .join("\n");
}

function describe(input: unknown): string {
  const i = (input ?? {}) as Json;
  const command = Array.isArray(i.cmd) ? i.cmd.join(" ") : (i.command ?? i.cmd);
  if (typeof command === "string") {
    const note = typeof i.description === "string" ? `\n（${i.description}）` : "";
    return cut(command, COMMAND_CHARS) + note;
  }
  return cut(typeof input === "string" ? input : JSON.stringify(input), INPUT_CHARS);
}

// Instructions the client puts in as if the person said them.
const NOT_SAID = /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<permissions|<INSTRUCTIONS>|<external_)/;

// Reads one transcript, a line at a time, into plain words.
class Transcript {
  private parts: string[] = [];
  private cwd: string | null = null;
  private first = "";
  private last = "";

  constructor(
    private kind: HistoryKind,
    private raw: string,
    // A compressed original cannot be opened at a line.
    private lineRefs = true,
  ) {}

  private say(ts: unknown, who: string, body: string): void {
    const text = body.trim();
    if (!text) return;
    const at = when(ts);
    if (at) {
      this.first ||= when(ts, true);
      this.last = when(ts, true);
    }
    this.parts.push(`${at ? `[${at}] ` : ""}${who}：${text}`);
  }

  add(lineText: string, lineNo: number): void {
    let d: Json;
    try {
      d = JSON.parse(lineText);
    } catch {
      return;
    }
    if (!d || typeof d !== "object") return;
    if (this.kind === "claude") this.addClaude(d, lineNo);
    else this.addCodex(d, lineNo);
  }

  private addClaude(d: Json, lineNo: number): void {
    if (d.type !== "user" && d.type !== "assistant") return;
    if (typeof d.cwd === "string") this.cwd ??= d.cwd;
    if (d.isMeta) return;
    const content = d.message?.content;
    if (d.type === "user") {
      const who = d.isCompactSummary ? "（之前对话的摘要）" : "主人";
      if (typeof content === "string") {
        this.say(d.timestamp, who, content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""));
        return;
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === "tool_result") {
          this.say(d.timestamp, c.is_error ? "结果（出错）" : "结果", cut(flatten(c.content), RESULT_CHARS, this.lineRefs ? lineNo : undefined));
        } else if (c?.type === "text") {
          this.say(d.timestamp, who, String(c.text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""));
        }
      }
      return;
    }
    for (const c of Array.isArray(content) ? content : []) {
      if (c?.type === "text") this.say(d.timestamp, "Claude", String(c.text));
      else if (c?.type === "tool_use") this.say(d.timestamp, `Claude 用 ${c.name}`, describe(c.input));
    }
  }

  private addCodex(d: Json, lineNo: number): void {
    // Newer Codex wraps each item in `payload`; older versions wrote items bare.
    const p: Json = d.payload && typeof d.payload === "object" ? d.payload : d;
    const ts = d.timestamp ?? p.timestamp;
    if (d.type === "session_meta" || d.type === "turn_context") {
      if (typeof p.cwd === "string") this.cwd ??= p.cwd;
      return;
    }
    if (d.type === "event_msg" || d.type === "compacted") return;
    switch (p.type) {
      case "message": {
        const text = flatten(p.content);
        if (p.role === "user" && !NOT_SAID.test(text.trimStart())) this.say(ts, "主人", text);
        if (p.role === "assistant") this.say(ts, "Codex", text);
        return;
      }
      case "function_call": {
        let args: unknown = p.arguments;
        try {
          args = JSON.parse(p.arguments);
        } catch {
          // shown as it was written
        }
        this.say(ts, `Codex 用 ${p.name}`, describe(args));
        return;
      }
      case "custom_tool_call":
      case "local_shell_call":
        this.say(ts, `Codex 用 ${p.name ?? "shell"}`, describe(p.input ?? p.action));
        return;
      case "function_call_output":
      case "custom_tool_call_output": {
        const out = typeof p.output === "object" && p.output && !Array.isArray(p.output) ? (p.output.content ?? p.output) : p.output;
        this.say(ts, "结果", cut(flatten(out), RESULT_CHARS, this.lineRefs ? lineNo : undefined));
        return;
      }
    }
  }

  // Null when the transcript is from a folder left out.
  text(leaveOut: string[]): string | null {
    if (this.cwd && leaveOut.includes(this.cwd)) return null;
    const head = [
      `项目：${this.cwd ?? "未知"}`,
      ...(this.first ? [`时间：${this.first} 到 ${this.last}`] : []),
      `原始记录：${this.raw}`,
      `${NAME[this.kind]} 的对话，主人是这台电脑的主人。`,
    ];
    return [head.join("\n"), ...this.parts].join("\n\n") + "\n";
  }
}

// The plain copy of one transcript, or null when it is left out.
export function digestLines(kind: HistoryKind, lines: Iterable<string>, raw: string, leaveOut: string[] = []): string | null {
  const t = new Transcript(kind, raw);
  let n = 0;
  for (const l of lines) t.add(l, ++n);
  return t.text(leaveOut);
}

// Codex compresses older sessions with zstd, which Node reads from 22.15 on;
// before that they are skipped, as the background AI could not read them anyway.
const unzstd = (zlib as { createZstdDecompress?: () => Transform }).createZstdDecompress;
const TRANSCRIPT = unzstd ? /\.jsonl(\.zst)?$/ : /\.jsonl$/;

async function digestFile(kind: HistoryKind, raw: string, leaveOut: string[]): Promise<string | null> {
  const compressed = raw.endsWith(".zst");
  const t = new Transcript(kind, raw, !compressed);
  const input = compressed ? createReadStream(raw).pipe(unzstd!()) : createReadStream(raw);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  for await (const l of lines) t.add(l, ++n);
  return t.text(leaveOut);
}

function walk(root: string, name: RegExp): string[] {
  try {
    return (readdirSync(root, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
      .filter((e) => e.isFile() && name.test(e.name))
      .map((e) => join(e.parentPath, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// Keeps `dir` a plain copy of every transcript under `source`: a transcript
// is read again only when it changed, and a copy goes when its transcript
// does. `leaveOut`: working folders whose conversations are not copied.
export class HistoryDigest {
  private running: Promise<void> | null = null;

  constructor(
    readonly kind: HistoryKind,
    readonly source: string,
    readonly dir: string,
    private leaveOut: string[] = [],
  ) {}

  // One run at a time; asking during a run waits for it.
  refresh(): Promise<void> {
    this.running ??= this.sync().finally(() => (this.running = null));
    return this.running;
  }

  private async sync(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const keep = new Set<string>();
    for (const raw of walk(this.source, TRANSCRIPT)) {
      const copy = join(this.dir, relative(this.source, raw)).replace(TRANSCRIPT, ".md");
      let src;
      try {
        src = statSync(raw);
      } catch {
        continue; // removed while looking
      }
      let done = false;
      try {
        done = Math.abs(statSync(copy).mtimeMs - src.mtimeMs) < 1;
      } catch {
        // no copy yet
      }
      if (done) {
        keep.add(copy);
        continue;
      }
      const text = await digestFile(this.kind, raw, this.leaveOut).catch(() => null);
      if (text === null) continue;
      mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
      writeFileSync(copy, text, { mode: 0o600 });
      // The copy carries its transcript's time, to tell next time whether it changed.
      utimesSync(copy, src.atime, src.mtime);
      keep.add(copy);
    }
    for (const copy of walk(this.dir, /\.md$/)) if (!keep.has(copy)) rmSync(copy, { force: true });
  }
}

const digests = new Map<string, HistoryDigest>();

// The plain copy of this computer's Claude Code or Codex history, shared by
// everything that reads or refreshes it. The background AI's own folders are
// left out: what it said there was said to others and is in Achat already.
export function historyFor(kind: HistoryKind): HistoryDigest {
  const source = kind === "claude" ? claudeProjectsDir() : codexSessionsDir();
  const dir = join(achatHome(), "history", kind);
  const key = `${kind}\n${source}\n${dir}`;
  let h = digests.get(key);
  if (!h) {
    h = new HistoryDigest(kind, source, dir, [dir, source]);
    digests.set(key, h);
  }
  return h;
}
