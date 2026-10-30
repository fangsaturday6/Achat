import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "./client.js";
import { loadConfig, relayUrl } from "./config.js";
import { connect } from "./connection.js";
import { checkRunning } from "./running.js";

// The command an Achat reminder hook runs, from a hooks file, if any.
function reminderHook(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as { hooks?: Record<string, { hooks: { command: string }[] }[]> };
    const entry = (settings.hooks?.UserPromptSubmit ?? []).flatMap((e) => e.hooks).find((h) => h.command.includes("hook user-prompt --agent"));
    return entry?.command ?? null;
  } catch {
    return null;
  }
}

// The cli.js a hook command runs, so a hook left over from a deleted folder shows up.
function cliOf(command: string): string | null {
  return command.match(/"([^"]+cli\.js)"/)?.[1] ?? null;
}

// Checks, in order, everything a request needs to reach the person on this
// computer, and says what to do about the first thing that is missing.
export async function doctor(cliPath: string): Promise<string[]> {
  const lines: string[] = [];
  const ok = (good: boolean, text: string) => lines.push(`${good ? "✓" : "✗"} ${text}`);
  const cfg = loadConfig();
  const home = homedir();

  const running = await checkRunning(new RelayClient(relayUrl(cfg), cfg.token), cliPath);
  ok(running.state === "current", { current: "后台服务在运行", stale: "后台运行的是旧版本：运行 achat setup 重启", down: "后台服务没有运行：运行 achat setup" }[running.state]);

  const conn = connect(cfg);
  if (conn.mode === "cloud") {
    try {
      const me = await conn.client.me();
      ok(true, `已加入 ${me.account.name} 的账号（${conn.webUrl}）`);
    } catch (err) {
      ok(false, `连不上 ${conn.webUrl}：${(err as Error).message}`);
    }
  } else {
    lines.push("• 这台电脑还没加入 Achat 账号，只能和自己的 AI 互相问");
  }

  for (const [name, client, path] of [
    ["Claude Code", "claude", join(home, ".claude", "settings.json")],
    ["Codex", "codex", join(home, ".codex", "hooks.json")],
  ] as const) {
    const agent = cfg.agents.find((a) => a.client === client);
    if (!agent || !existsSync(join(home, client === "claude" ? ".claude" : ".codex"))) continue;
    const hook = reminderHook(path);
    const cli = hook && cliOf(hook);
    if (!hook) ok(false, `${name}：没有待批准提醒，运行 achat setup`);
    else if (cli && !existsSync(cli)) ok(false, `${name}：提醒指向已经不存在的 ${cli}，运行 achat setup`);
    else ok(true, `${name}：有待批准提醒（你在 ${name} 里发下一条消息时弹出）`);
    if (client === "codex") {
      const toml = existsSync(join(home, ".codex", "config.toml")) ? readFileSync(join(home, ".codex", "config.toml"), "utf8") : "";
      if (!/^\s*\[features\][^[]*^\s*hooks\s*=\s*true/ms.test(toml)) ok(false, "Codex：没有打开 hooks 功能，运行 achat setup");
    }
    try {
      const pending = await conn.client.listThreads({ to: conn.agentId(agent.id), status: "pending" });
      if (pending.length) lines.push(`• ${name}有 ${pending.length} 个请求等你批准：${conn.webUrl}`);
    } catch {
      // reported above
    }
  }

  if (process.platform === "darwin") {
    let notifier = false;
    try {
      execFileSync("which", ["terminal-notifier"], { stdio: "ignore" });
      notifier = true;
    } catch {
      // macOS's own notifications
    }
    lines.push(
      notifier
        ? "• 新请求用 terminal-notifier 发系统通知"
        : "• 新请求用 macOS 脚本通知；看不到的话，在“系统设置 → 通知”里允许“脚本编辑器”",
    );
  }
  return lines;
}
