import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { secretStore } from "./device.js";
import { onPath } from "./which.js";

// Reads a line without echoing it, so a pasted credential does not stay on screen.
// A paste arrives in one piece; line breaks inside it come from the terminal
// wrapping the long credential, so only an Enter pressed on its own submits.
function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let text = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (text += d)).on("end", () => resolve(findToken(text) ?? text.trim().split(/\r?\n/)[0]!));
    });
  }
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      chunk = chunk.replace(/\x1b\[20[01]~/g, ""); // bracketed-paste markers
      if (chunk === "\r" || chunk === "\n" || chunk === "\r\n") return done();
      for (const ch of chunk) {
        if (ch === "\u0003") return done(new Error("已取消"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (!/\s/.test(ch)) value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// Finds the credential in what `claude setup-token` printed. A narrow terminal
// wraps it over several lines: lines right after it made only of credential
// characters are joined on; a blank line or other text ends it.
export function findToken(screen: string): string | null {
  const text = screen
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "")
    .replace(/\r/g, "");
  const start = text.lastIndexOf("sk-ant-");
  if (start < 0) return null;
  const [first = "", ...rest] = text.slice(start).split("\n");
  let token = /^[A-Za-z0-9_-]+/.exec(first)![0];
  if (token.length === first.trimEnd().length) {
    for (const line of rest) {
      if (!/^[A-Za-z0-9_-]+$/.test(line.trim())) break;
      token += line.trim();
    }
  }
  return token;
}

// Runs `claude setup-token` in a pseudo-terminal 500 columns wide, so the
// credential comes out on one line, and returns what it printed. Without the
// `script` command (Windows) it runs plainly and nothing is read back.
function runSetupToken(bin: string): { status: number | null; screen: string | null } {
  if (!onPath("script")) {
    return { status: spawnSync(bin, ["setup-token"], { stdio: "inherit" }).status, screen: null };
  }
  const dir = mkdtempSync(join(tmpdir(), "achat-token-"));
  const file = join(dir, "screen");
  const inner = `stty cols 500 2>/dev/null; exec '${bin.replaceAll("'", `'\\''`)}' setup-token`;
  const args = platform() === "linux" ? ["-q", "-e", "-c", inner, file] : ["-q", file, "sh", "-c", inner];
  try {
    // `script` refuses a pipe as its input; without a terminal nobody types anyway.
    const run = spawnSync("script", args, { stdio: [process.stdin.isTTY ? "inherit" : "ignore", "inherit", "inherit"] });
    let screen: string | null = null;
    try {
      screen = readFileSync(file, "utf8");
    } catch {}
    return { status: run.status, screen };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Asks Anthropic whether the credential works, the way Claude Code uses it.
// Only a 401 says it does not (for example when half of it was pasted); when
// Anthropic cannot be reached, nobody knows.
async function checkToken(token: string): Promise<boolean | null> {
  const base = process.env.ACHAT_ANTHROPIC_URL ?? "https://api.anthropic.com";
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.status !== 401;
  } catch {
    return null;
  }
}

// `achat claude-token`: gets a long-lived Claude credential with
// `claude setup-token` and keeps it in the keychain (a private file elsewhere).
// Background answers use it, so they keep working when the Claude Code login
// runs out between uses.
export async function claudeTokenCommand(args: string[]): Promise<string> {
  const store = secretStore("claude-token");
  if (args.includes("--remove")) {
    store.remove();
    return "已删除。后台回答改用 Claude Code 自己的登录。";
  }
  let token: string | null = null;
  // --paste: the credential came from running `claude setup-token` by hand,
  // for example with a proxy set in that terminal.
  if (!args.includes("--paste")) {
    const bin = process.env.ACHAT_CLAUDE_BIN ?? "claude";
    if (!onPath(bin)) throw new Error("这台电脑上找不到 claude 命令");
    console.log("在浏览器里登录 Claude，点“授权”。凭证会自动保存，不用复制。\n");
    const run = runSetupToken(bin);
    if (run.status !== 0) throw new Error("claude setup-token 没有完成，凭证没有保存");
    token = run.screen === null ? null : findToken(run.screen);
    // The credential is on screen; it is kept now, so clear it away.
    if (token && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }
  token ??= await readHidden("\n把 claude setup-token 显示的凭证粘贴到这里（不会显示出来），按回车：");
  if (!/^sk-ant-[A-Za-z0-9_-]{40,}$/.test(token)) {
    throw new Error("凭证看起来不完整，没有保存。再运行一次 achat claude-token");
  }
  const works = await checkToken(token);
  if (works === false) throw new Error("Anthropic 不认这个凭证（可能只复制了一半），没有保存。再运行一次 achat claude-token");
  store.save(token);
  return works
    ? "已保存。Achat 在后台回答时用这个凭证；到期后再运行一次 achat claude-token。"
    : "已保存，但这会儿连不上 Anthropic，没能确认凭证可用。到期后再运行一次 achat claude-token。";
}
