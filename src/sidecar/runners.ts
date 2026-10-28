import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function claudeProjectsDir(): string {
  return process.env.ACHAT_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
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

  run(input: RunInput): Promise<RunOutput> {
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

    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: dir,
        // The hook command sees this and stays quiet inside headless runs.
        env: { ...process.env, ACHAT_HEADLESS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("回答超时"));
      }, this.timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`无法启动 claude：${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let parsed: ClaudeJsonResult | null = null;
        try {
          parsed = JSON.parse(stdout.trim()) as ClaudeJsonResult;
        } catch {
          // fall through to the error below
        }
        if (!parsed || parsed.is_error || code !== 0 || !parsed.result) {
          const reason = parsed?.result || parsed?.subtype || stderr.trim().split("\n").at(-1) || `退出码 ${code}`;
          reject(new Error(reason));
          return;
        }
        resolve({
          text: parsed.result,
          sessionId: parsed.session_id ?? sessionId,
          costUsd: parsed.total_cost_usd ?? 0,
        });
      });
      child.stdin.end(input.prompt);
    });
  }
}
