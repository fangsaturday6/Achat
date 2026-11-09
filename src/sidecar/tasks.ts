import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { achatHome } from "../config.js";
import { onPath } from "../which.js";

// 动手: the receiving person's Claude Code does the work in a conversation of
// its own, which the person can watch and step into. These records say which
// conversation works on a thread and in which folder (written by the
// sidecar), and how far that conversation has been handed the thread
// (written by Achat's MCP server inside it, when it passes on what the asker
// said). Both run on this computer, each writing its own file.

export interface TaskRecord {
  sessionId: string;
  dir: string;
}

export class TaskBook {
  constructor(private dir = join(achatHome(), "tasks")) {}

  private file(threadId: string, ext: string): string {
    return join(this.dir, `${threadId.replace(/[^\w-]/g, "_")}.${ext}`);
  }

  get(threadId: string): TaskRecord | null {
    try {
      const rec = JSON.parse(readFileSync(this.file(threadId, "json"), "utf8")) as Partial<TaskRecord>;
      return typeof rec.sessionId === "string" && typeof rec.dir === "string" ? { sessionId: rec.sessionId, dir: rec.dir } : null;
    } catch {
      return null;
    }
  }

  set(threadId: string, rec: TaskRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(threadId, "json"), JSON.stringify(rec));
  }

  // The last message of the thread the conversation has been given.
  seen(threadId: string): number {
    try {
      return Number(readFileSync(this.file(threadId, "seen"), "utf8")) || 0;
    } catch {
      return 0;
    }
  }

  markSeen(threadId: string, seq: number): void {
    if (seq <= this.seen(threadId)) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(threadId, "seen"), String(seq));
  }
}

// For Achat's MCP server inside the conversation.
export function markTaskSeen(threadId: string, seq: number): void {
  try {
    new TaskBook().markSeen(threadId, seq);
  } catch {
    // The sidecar then hands the message over again, which is harmless.
  }
}

export interface TaskStart {
  threadId: string;
  topic: string;
  prompt: string;
  systemPrompt: string;
  // A conversation that worked on this thread before: the new one carries on
  // from it, in its folder.
  from?: TaskRecord;
}

// Opens a Claude Code conversation for a task; resolves once it is started.
export interface TaskOpener {
  open(start: TaskStart): Promise<TaskRecord>;
}

// A folder of its own under ~/Achat, named after the topic.
export function taskDir(topic: string, threadId: string, root = join(homedir(), "Achat")): string {
  const name = topic.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || threadId;
  const dir = join(root, name);
  return existsSync(dir) ? join(root, `${name} ${threadId}`) : dir;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandPath(command: string): string {
  try {
    return execFileSync("which", [command], { encoding: "utf8" }).trim() || command;
  } catch {
    return command;
  }
}

// The arguments for `claude --bg`: edits inside the task's folder go ahead, a
// command or anything outside it asks the person first. A background session
// picks its own id, and needs no folder trust question answered first.
export function claudeTaskArgs(start: TaskStart): string[] {
  return [
    "--bg",
    ...(start.from ? ["--resume", start.from.sessionId, "--fork-session"] : []),
    "-n",
    `Achat · ${start.topic}`,
    "--permission-mode",
    "acceptEdits",
    "--append-system-prompt",
    start.systemPrompt,
    start.prompt,
  ];
}

// "backgrounded · 5af4910f · Achat · 字幕脚本" → "5af4910f".
export function backgroundId(output: string): string | null {
  return output.match(/backgrounded\s+·\s+([0-9a-f]{6,})\b/)?.[1] ?? null;
}

// Starts the conversation as a Claude Code background session, then shows it
// in a terminal window on the person's screen (`claude attach`), where they
// can watch, answer its questions and step in: on macOS Terminal runs a
// .command file, on Linux desktops x-terminal-emulator. Without a screen it
// keeps running in the background, where `claude agents` lists it.
export class ClaudeTaskOpener implements TaskOpener {
  constructor(
    private command = process.env.ACHAT_CLAUDE_BIN ?? "claude",
    private scripts = join(achatHome(), "tasks"),
    // Where the tasks' folders go.
    private root = join(homedir(), "Achat"),
  ) {}

  async open(start: TaskStart): Promise<TaskRecord> {
    const dir = start.from?.dir ?? taskDir(start.topic, start.threadId, this.root);
    mkdirSync(dir, { recursive: true });
    const claude = commandPath(this.command);
    const output = await capture(claude, claudeTaskArgs(start), dir);
    const id = backgroundId(output);
    if (!id) throw new Error(`打不开动手的对话：${output.trim().split("\n").at(-1) || "claude --bg 没有给出会话"}`);
    const sessionId = await fullSessionId(claude, id, dir);

    const os = platform();
    const desktop = os === "darwin" || (os === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("x-terminal-emulator"));
    if (desktop) {
      mkdirSync(this.scripts, { recursive: true, mode: 0o700 });
      const script = join(this.scripts, `${start.threadId.replace(/[^\w-]/g, "_")}-${id}.command`);
      writeFileSync(script, ["#!/bin/bash", `cd ${shellQuote(dir)} || exit 1`, `exec ${[claude, "attach", id].map(shellQuote).join(" ")}`, ""].join("\n"));
      chmodSync(script, 0o700);
      // The work goes on in the background even if no window opens.
      await (os === "darwin" ? capture("open", [script], dir) : capture("x-terminal-emulator", ["-e", script], dir, false)).catch(() => "");
    }
    return { sessionId, dir };
  }
}

// The whole id, which a later conversation resumes from; the short one if
// the list does not have it.
async function fullSessionId(claude: string, id: string, cwd: string): Promise<string> {
  try {
    const list = JSON.parse(await capture(claude, ["agents", "--json"], cwd)) as { id?: string; sessionId?: string }[];
    return list.find((a) => a.id === id)?.sessionId ?? id;
  } catch {
    return id;
  }
}

// Output and errors of a command. `wait` false: a terminal emulator stays
// open with the conversation, so only its start is checked.
function capture(command: string, args: string[], cwd: string, wait = true): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, timeout: 60_000, env: { ...process.env, ACHAT_HEADLESS: undefined } }, (err, stdout, stderr) => {
      if (!wait) return;
      if (err) reject(new Error(`打不开动手的对话：${String(stderr).trim() || err.message}`));
      else resolve(`${stdout}\n${stderr}`);
    });
    child.on("error", (err) => reject(new Error(`打不开动手的对话：${err.message}`)));
    if (!wait) {
      child.unref();
      setTimeout(() => resolve(""), 500);
    }
  });
}
