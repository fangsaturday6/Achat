import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { achatHome } from "../config.js";
import { isEffort, type Effort } from "../models.js";
import { claudeCommand, codexCommand, onPath } from "../which.js";
import { claudeModelArgs, codexModelArgs } from "./runners.js";

// 动手: the receiving person's Claude Code or Codex does the work in a
// conversation of its own, which the person can watch and step into. These records say which
// conversation works on a thread and in which folder (written by the
// sidecar), and how far that conversation has been handed the thread
// (written by Achat's MCP server inside it, when it passes on what the asker
// said). Both run on this computer, each writing its own file.

export interface TaskRecord {
  sessionId: string;
  dir: string;
  // What it works with: the model as people call it, and the 推理档位. Kept
  // with what it hands back.
  model?: string;
  effort?: Effort;
}

export class TaskBook {
  constructor(private dir = join(achatHome(), "tasks")) {}

  private file(threadId: string, ext: string): string {
    return join(this.dir, `${threadId.replace(/[^\w-]/g, "_")}.${ext}`);
  }

  get(threadId: string): TaskRecord | null {
    try {
      const rec = JSON.parse(readFileSync(this.file(threadId, "json"), "utf8")) as Partial<TaskRecord>;
      if (typeof rec.sessionId !== "string" || typeof rec.dir !== "string") return null;
      return {
        sessionId: rec.sessionId,
        dir: rec.dir,
        ...(typeof rec.model === "string" ? { model: rec.model } : {}),
        ...(isEffort(rec.effort) ? { effort: rec.effort } : {}),
      };
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

  // Which 动手 works in `dir`, written before its conversation starts.
  // Achat's MCP server and hook in it run in that folder (Claude Code's
  // background sessions and `codex exec` alike), so from their first call
  // they know which 动手 they are in (at). Not an environment variable:
  // `claude --bg` sessions all take the one of whoever started its daemon.
  claim(key: string, dir: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(key, "dir"), JSON.stringify({ key, dir }));
  }

  // The 动手 whose conversation works in `dir`: its key (a thread's id, or
  // actKey), the latest claimed if a folder was used again; null for any
  // other folder, such as the person's own sessions.
  at(dir: string): string | null {
    const here = realPath(dir);
    let found: { key: string; at: number } | null = null;
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".dir"));
    } catch {
      return null;
    }
    for (const name of names) {
      try {
        const file = join(this.dir, name);
        const c = JSON.parse(readFileSync(file, "utf8")) as { key?: unknown; dir?: unknown };
        if (typeof c.key !== "string" || typeof c.dir !== "string" || realPath(c.dir) !== here) continue;
        const at = statSync(file).mtimeMs;
        if (!found || at >= found.at) found = { key: c.key, at };
      } catch {
        // Half written or gone: not this one.
      }
    }
    return found?.key ?? null;
  }
}

function realPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

// One conversation does what one asker asks of one AI in a group, across
// its acts, in one folder: what the TaskBook keeps it by.
export function actKey(groupId: string, asker: string, doer: string): string {
  return `${groupId}~${asker}~${doer}`;
}

// What a 动手 conversation works for, from its TaskBook key: a thread, or
// one asker's acts of one AI in a group (actKey; ids never have "~").
export type TaskFor = { thread: string } | { group: string; asker: string; doer: string };

export function taskFor(key: string): TaskFor {
  const [group, asker, doer] = key.split("~");
  return doer === undefined ? { thread: key } : { group, asker, doer };
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
  // Folders outside its own it may read without asking, such as where the
  // thread's files are kept.
  readDirs?: string[];
  // Between one person's own AIs: Codex's commands may then go online.
  own?: boolean;
  // 动手 asked for in a group (by an act's id): it hands the work back to
  // the group, not to a thread.
  inGroup?: boolean;
  // The model and 推理档位 to work with: the id the CLI takes, and the name
  // people read, kept in the record.
  model?: string;
  label?: string;
  effort?: Effort;
  // Told the folder it works in before the conversation starts, so what is
  // in there knows which 动手 it is (TaskBook.claim).
  claim?: (dir: string) => void;
  // Told once the conversation has stopped, where that can be known: `codex
  // exec` ends, a Claude Code background session does not say.
  onExit?: () => void;
}

// What a task's record keeps of what it works with.
export function workingWith(start: TaskStart): Pick<TaskRecord, "model" | "effort"> {
  return { ...(start.label ? { model: start.label } : {}), ...(start.effort ? { effort: start.effort } : {}) };
}

// Opens a Claude Code or Codex conversation for a task; resolves once it is started.
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
    ...(start.readDirs?.length ? ["--add-dir", ...start.readDirs] : []),
    "--permission-mode",
    "acceptEdits",
    ...claudeModelArgs(start),
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
    private command = claudeCommand(),
    private scripts = join(achatHome(), "tasks"),
    // Where the tasks' folders go.
    private root = join(homedir(), "Achat"),
  ) {}

  async open(start: TaskStart): Promise<TaskRecord> {
    const dir = start.from?.dir ?? taskDir(start.topic, start.threadId, this.root);
    mkdirSync(dir, { recursive: true });
    start.claim?.(dir);
    const claude = commandPath(this.command);
    const output = await capture(claude, claudeTaskArgs(start), dir);
    const id = backgroundId(output);
    if (!id) throw new Error(`打不开动手的对话：${output.trim().split("\n").at(-1) || "claude --bg 没有给出会话"}`);
    const sessionId = await fullSessionId(claude, id, dir);
    await showWindow(this.scripts, `${safe(start.threadId)}-${id}`, dir, [`exec ${[claude, "attach", id].map(shellQuote).join(" ")}`]);
    return { sessionId, dir, ...workingWith(start) };
  }
}

// The arguments for `codex exec`, which reads the prompt from stdin. It runs
// with the person's own Codex settings: their model, image generation, and
// Achat, which it hands the work back with. Nobody is there to approve a
// command, so it writes only inside its folder, and its commands go online
// only between one person's own AIs. Nor is anybody there to approve an MCP
// call, which Codex asks for of Achat's tools, so those it hands the work
// back with go ahead: a thread's for a thread, a group's for a group. Asking
// anyone else, or speaking anywhere else, does not. A later conversation
// resumes the earlier one.
const CODEX_HAND_BACK = { thread: ["send_message", "check_thread"], group: ["send_group_message", "check_group"] };

export function codexTaskArgs(start: TaskStart): string[] {
  const common = [
    "--skip-git-repo-check",
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    `sandbox_workspace_write.network_access=${start.own === true}`,
    ...codexModelArgs(start),
    ...CODEX_HAND_BACK[start.inGroup ? "group" : "thread"].flatMap((tool) => ["-c", `mcp_servers.achat.tools.${tool}.approval_mode="approve"`]),
  ];
  return start.from
    ? ["exec", "resume", ...common, start.from.sessionId, "-"]
    : ["exec", ...common, "-c", `developer_instructions=${JSON.stringify(start.systemPrompt)}`, "-"];
}

// "session id: 01a1e4e6-9149-…" in the header `codex exec` prints first.
export function codexSessionId(output: string): string | null {
  return output.match(/^session id:\s*([0-9a-f][0-9a-f-]{7,})\s*$/im)?.[1] ?? null;
}

// What `codex exec` prints once it is under way, and when it gave up.
const CODEX_WORKING = /^(codex|exec|thinking|tool|mcp:.*ready)\b/m;
const CODEX_FAILED = /^ERROR:\s*(.+)$/m;

// Runs `codex exec` in the background with its output in a log next to the
// task records, and shows the log in a terminal window. Closing the window
// does not stop the work; `codex resume` in the folder steps into it.
export class CodexTaskOpener implements TaskOpener {
  constructor(
    private command = codexCommand(),
    private scripts = join(achatHome(), "tasks"),
    private root = join(homedir(), "Achat"),
    // False in tests: no terminal window.
    private window = true,
    // How long it may take to get under way.
    private startMs = 90_000,
  ) {}

  async open(start: TaskStart): Promise<TaskRecord> {
    const dir = start.from?.dir ?? taskDir(start.topic, start.threadId, this.root);
    mkdirSync(dir, { recursive: true });
    start.claim?.(dir);
    mkdirSync(this.scripts, { recursive: true, mode: 0o700 });
    const name = `${safe(start.threadId)}-codex-${Date.now()}`;
    const log = join(this.scripts, `${name}.log`);
    const out = openSync(log, "a", 0o600);
    const codex = commandPath(this.command);
    const child = spawn(codex, codexTaskArgs(start), { cwd: dir, detached: true, stdio: ["pipe", out, out], env: { ...process.env, ACHAT_HEADLESS: undefined } });
    closeSync(out);
    let problem = "";
    let ended = false;
    child.on("error", (err: NodeJS.ErrnoException) => {
      problem = err.code === "ENOENT" ? `这台电脑上找不到 ${this.command} 命令` : err.message;
    });
    const exited = new Promise<void>((resolve) =>
      child.on("exit", (code) => {
        ended = true;
        if (code) problem ||= `codex 退出了（${code}）`;
        resolve();
      }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(start.prompt);
    child.unref();

    // Under way once it starts working; a run that ends first, or says ERROR, did not start.
    const until = Date.now() + this.startMs;
    let sessionId: string | null = null;
    for (;;) {
      const output = readText(log);
      sessionId ??= codexSessionId(output);
      const failed = output.match(CODEX_FAILED)?.[1];
      if (failed || problem) throw new Error(`打不开动手的对话：${failed?.trim() || problem}`);
      if (sessionId && (CODEX_WORKING.test(output.slice(output.indexOf(sessionId))) || ended || Date.now() > until)) break;
      if (Date.now() > until) throw new Error("打不开动手的对话：codex 没有开始");
      await sleep(300);
    }
    if (this.window) {
      const hint = `关掉窗口不影响干活。要插话：在这个文件夹里运行 codex resume ${sessionId}`;
      await showWindow(this.scripts, name, dir, [`echo ${shellQuote(hint)}`, `exec tail -n +1 -f ${shellQuote(log)}`]);
    }
    if (start.onExit) void exited.then(start.onExit);
    return { sessionId, dir, ...workingWith(start) };
  }
}

function safe(threadId: string): string {
  return threadId.replace(/[^\w-]/g, "_");
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Shows the work in a terminal window on the person's screen: on macOS
// Terminal runs a .command file, on Linux desktops x-terminal-emulator.
// Without a screen nothing opens, and the work goes on in the background.
async function showWindow(scripts: string, name: string, dir: string, lines: string[]): Promise<void> {
  const os = platform();
  const desktop = os === "darwin" || (os === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("x-terminal-emulator"));
  if (!desktop) return;
  mkdirSync(scripts, { recursive: true, mode: 0o700 });
  const script = join(scripts, `${name}.command`);
  writeFileSync(script, ["#!/bin/bash", `cd ${shellQuote(dir)} || exit 1`, ...lines, ""].join("\n"));
  chmodSync(script, 0o700);
  await (os === "darwin" ? capture("open", [script], dir) : capture("x-terminal-emulator", ["-e", script], dir, false)).catch(() => "");
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
