import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, relayUrl } from "./config.js";

const SKILL = `---
name: achat
description: 通过 Achat 和其他 AI 直接沟通，包括主人自己的其他 AI 和联系人的 AI。当主人说“问问我的 Claude/Codex……”“问问某人的 AI……”，或者提示有 Achat 待批准请求时使用。
---

# Achat

- 发起：调用 send_request（to、topic、message）。message 要写清楚想要什么。对方的主人要先批准，可能要等一会儿。
- 收到回复后，先把对方的回复完整转给主人：步骤、提示词、命令、路径照原文给出，不要压缩成摘要；你的理解放在后面另外说。
- 按主人的目标决定是否追问（send_message）；问完调用 close_thread。
- 提示有待批准请求时：调用 review_pending，让主人在弹出的对话框里决定。你看不到请求内容，不要猜。
- 不要把密钥、令牌、密码等敏感信息写进消息。
- 工具报告 Achat 服务没有运行时，提醒主人在终端运行 \`achat start\`。
`;

function onPath(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function writeFile(path: string, content: string, dryRun: boolean): void {
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

interface ClaudeSettings {
  hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
  [key: string]: unknown;
}

export interface SetupResult {
  lines: string[];
}

// Configures every supported AI client on this computer to use Achat:
// the MCP tools, the pending-request reminder and the Achat skill.
export function setup(cliPath: string, dryRun = false): SetupResult {
  const lines: string[] = [];
  const cfg = loadConfig();
  const node = process.execPath;
  const home = homedir();
  const found: string[] = [];

  const claudeAgent = cfg.agents.find((a) => a.client === "claude");
  if (claudeAgent && (onPath("claude") || existsSync(join(home, ".claude")))) {
    found.push("Claude Code");
    if (!dryRun && onPath("claude")) {
      try {
        execFileSync("claude", ["mcp", "remove", "achat", "--scope", "user"], { stdio: "ignore" });
      } catch {
        // not registered yet
      }
      execFileSync(
        "claude",
        ["mcp", "add", "achat", "--scope", "user", "--env", `ACHAT_AGENT=${claudeAgent.id}`, "--", node, cliPath, "mcp"],
        { stdio: "ignore" },
      );
    }
    lines.push("✓ Claude Code：已添加 MCP 工具 achat");

    const settingsPath = join(home, ".claude", "settings.json");
    const settings: ClaudeSettings = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettings)
      : {};
    settings.hooks ??= {};
    const command = `"${node}" "${cliPath}" hook user-prompt --agent ${claudeAgent.id}`;
    const others = (settings.hooks.UserPromptSubmit ?? []).filter(
      (entry) => !entry.hooks.some((h) => h.command.includes("hook user-prompt") && h.command.includes(cliPath)),
    );
    settings.hooks.UserPromptSubmit = [...others, { hooks: [{ type: "command", command, timeout: 10 }] }];
    writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", dryRun);
    lines.push("✓ Claude Code：已添加待批准提醒 hook");

    writeFile(join(home, ".claude", "skills", "achat", "SKILL.md"), SKILL, dryRun);
    lines.push("✓ Claude Code：已添加 Achat skill");
  }

  const codexAgent = cfg.agents.find((a) => a.client === "codex");
  if (codexAgent && (onPath("codex") || existsSync(join(home, ".codex")))) {
    found.push("Codex");
    const tomlPath = join(home, ".codex", "config.toml");
    const current = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
    if (current.includes("[mcp_servers.achat]")) {
      lines.push(`• Codex：${tomlPath} 里已经有 achat，没有改动`);
    } else {
      const block = [
        "",
        "[mcp_servers.achat]",
        `command = ${JSON.stringify(node)}`,
        `args = [${JSON.stringify(cliPath)}, "mcp"]`,
        "tool_timeout_sec = 600",
        "",
        "[mcp_servers.achat.env]",
        `ACHAT_AGENT = ${JSON.stringify(codexAgent.id)}`,
        "",
      ].join("\n");
      writeFile(tomlPath, current.replace(/\s*$/, "\n") + block, dryRun);
      lines.push("✓ Codex：已添加 MCP 工具 achat");
    }
    writeFile(join(home, ".agents", "skills", "achat", "SKILL.md"), SKILL, dryRun);
    lines.push("✓ Codex：已添加 Achat skill");
  }

  if (!found.length) {
    lines.push("没有在这台电脑上找到 Claude Code 或 Codex。");
    return { lines };
  }
  lines.push(
    "",
    `装好了：${found.join("、")}。`,
    "接下来在终端运行 `achat start` 启动 Achat（关掉终端就会停止）。",
    found.includes("Codex") ? "Codex 需要重新开一次会话才能用。" : "",
    `查看和批准：${relayUrl(cfg)}`,
    "",
    "可以试试，在 Codex 里说：",
    "  “问问我的 Claude，上次的视频是怎么做的”",
    "  “我要和某人连上”（实验 0 还不支持，实验 1 加入）",
  );
  if (dryRun) lines.unshift("（演练模式，没有写入任何文件）");
  return { lines: lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")) };
}
