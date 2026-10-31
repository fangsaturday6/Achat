import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { secretStore } from "../device.js";

export interface RunInput {
  prompt: string;
  systemPrompt: string;
  // The headless session to continue; absent for the first round.
  sessionId?: string;
  budgetUsd: number;
}

export interface RunOutput {
  text: string;
  sessionId: string;
  costUsd: number;
}

// Answers a request on behalf of the receiving person, in a background
// session that has read-only access to that person's local history.
export interface AgentRunner {
  run(input: RunInput): Promise<RunOutput>;
}

// The run hit the dollar cap it was given, so no answer was produced.
export class BudgetExceededError extends Error {}

// The CLI is not logged in, or its login ran out. The person fixes it on this
// computer; until then the thread waits instead of failing.
export class LoginExpiredError extends Error {
  constructor(
    readonly client: "claude" | "codex",
    reason: string,
  ) {
    super(reason);
  }
}

const LOGIN_TROUBLE = /not logged in|\/login|log ?in again|oauth|access token|refresh token|failed to authenticate|authentication_error|invalid (api key|bearer token)|unauthori[sz]ed|\b401\b/i;

// The long-lived credential from `achat claude-token`, if the person made one.
export function claudeToken(): string | null {
  return secretStore("claude-token").load();
}

export function claudeProjectsDir(): string {
  return process.env.ACHAT_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// Runs a client CLI with the prompt on stdin. ACHAT_HEADLESS keeps the Achat
// hook quiet inside background runs.
function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; input: string; timeoutMs: number; name: string; env?: Record<string, string> },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, ACHAT_HEADLESS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("回答超时"));
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          err.code === "ENOENT" ? `这台电脑上找不到 ${opts.name} 命令` : `无法启动 ${opts.name}：${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "";
}

interface ClaudeJsonResult {
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  subtype?: string;
}

// Runs `claude -p` with only Read, Grep and Glob, no MCP servers and a dollar
// cap. dontAsk denies anything that is not pre-approved instead of prompting.
export class ClaudeRunner implements AgentRunner {
  constructor(
    private command = process.env.ACHAT_CLAUDE_BIN ?? "claude",
    private timeoutMs = 10 * 60 * 1000,
  ) {}

  async run(input: RunInput): Promise<RunOutput> {
    const dir = claudeProjectsDir();
    const sessionId = input.sessionId ?? randomUUID();
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep,Glob",
      "--strict-mcp-config",
      "--add-dir",
      dir,
      "--max-budget-usd",
      Math.max(0.01, input.budgetUsd).toFixed(2),
      "--append-system-prompt",
      input.systemPrompt,
      ...(input.sessionId ? ["--resume", input.sessionId] : ["--session-id", sessionId]),
    ];
    // A long-lived credential, if set up, so answers do not stop when the
    // Claude Code login runs out between uses.
    const token = claudeToken();
    const { stdout, stderr, code } = await runProcess(this.command, args, {
      cwd: dir,
      input: input.prompt,
      timeoutMs: this.timeoutMs,
      name: "claude",
      env: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : undefined,
    });

    let parsed: ClaudeJsonResult | null = null;
    try {
      parsed = JSON.parse(stdout.trim()) as ClaudeJsonResult;
    } catch {
      // fall through to the error below
    }
    if (!parsed || parsed.is_error || code !== 0 || !parsed.result) {
      const reason = parsed?.result || parsed?.subtype || lastLine(stderr) || `退出码 ${code}`;
      if (/max_budget/i.test(`${parsed?.subtype ?? ""} ${reason}`)) throw new BudgetExceededError(reason);
      if (LOGIN_TROUBLE.test(reason)) throw new LoginExpiredError("claude", reason);
      throw new Error(reason);
    }
    return { text: parsed.result, sessionId: parsed.session_id ?? sessionId, costUsd: parsed.total_cost_usd ?? 0 };
  }
}

export function codexSessionsDir(): string {
  return process.env.ACHAT_CODEX_SESSIONS ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "item.completed"; item: { type: string; text?: string } }
  | { type: "turn.completed" }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: string };

// Runs `codex exec` in the read-only sandbox, without the person's config.toml
// so no MCP servers (Achat included), hooks or profiles load, and with web
// search and sub-agents off. Codex reports tokens, not dollars, and on a
// ChatGPT plan a run has no per-call price, so the cost is recorded as 0 and
// only the round limit applies.
export class CodexRunner implements AgentRunner {
  constructor(
    private command = process.env.ACHAT_CODEX_BIN ?? "codex",
    private timeoutMs = 10 * 60 * 1000,
  ) {}

  async run(input: RunInput): Promise<RunOutput> {
    const dir = codexSessionsDir();
    mkdirSync(dir, { recursive: true });
    const common = [
      "--json",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'web_search="disabled"',
      "-c",
      "features.multi_agent=false",
    ];
    const args = input.sessionId
      ? ["exec", "resume", ...common, input.sessionId, "-"]
      : ["exec", ...common, "-c", `developer_instructions=${JSON.stringify(input.systemPrompt)}`, "-"];
    const { stdout, stderr, code } = await runProcess(this.command, args, {
      cwd: dir,
      input: input.prompt,
      timeoutMs: this.timeoutMs,
      name: "codex",
    });

    let sessionId = input.sessionId;
    let text = "";
    let completed = false;
    let failure = "";
    for (const line of stdout.split("\n")) {
      let e: CodexEvent;
      try {
        e = JSON.parse(line) as CodexEvent;
      } catch {
        continue;
      }
      if (e.type === "thread.started" && "thread_id" in e) sessionId = e.thread_id;
      else if (e.type === "item.completed" && "item" in e && e.item.type === "agent_message") text = e.item.text ?? "";
      else if (e.type === "turn.completed") completed = true;
      else if (e.type === "turn.failed" && "error" in e) failure = e.error?.message ?? "";
    }
    if (!completed || !text || !sessionId) {
      const reason = failure || lastLine(stderr) || `退出码 ${code}`;
      if (LOGIN_TROUBLE.test(reason) || /codex login/i.test(reason)) throw new LoginExpiredError("codex", reason);
      if (/unexpected argument|unrecognized/i.test(reason)) {
        throw new Error("这台电脑上的 codex 版本太旧。在终端运行 npm install -g @openai/codex 更新后再试");
      }
      throw new Error(reason);
    }
    return { text, sessionId, costUsd: 0 };
  }
}
