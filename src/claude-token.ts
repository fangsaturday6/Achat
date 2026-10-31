import { spawnSync } from "node:child_process";
import { secretStore } from "./device.js";

// Reads a line without echoing it, so a pasted credential does not stay on screen.
function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let text = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (text += d)).on("end", () => resolve(text.split("\n")[0] ?? ""));
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
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("已取消"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
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
  console.log("第 1 步：在浏览器里登录，拿到一个长期有效的凭证。\n");
  const run = spawnSync(process.env.ACHAT_CLAUDE_BIN ?? "claude", ["setup-token"], { stdio: "inherit" });
  if (run.error) throw new Error("这台电脑上找不到 claude 命令");
  if (run.status !== 0) throw new Error("claude setup-token 没有完成，凭证没有保存");
  const token = (await readHidden("\n第 2 步：把上面显示的凭证粘贴到这里（不会显示出来），按回车：")).trim();
  if (token.length < 20 || /\s/.test(token)) throw new Error("凭证看起来不完整，没有保存。再运行一次 achat claude-token");
  store.save(token);
  return "已保存。Achat 在后台回答时用这个凭证；到期后再运行一次 achat claude-token。";
}
