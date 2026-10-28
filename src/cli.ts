#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "./client.js";
import { dbPath, loadConfig, relayUrl } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<void> {
  if (process.stdin.isTTY) return;
  for await (const _ of process.stdin) {
    // Claude Code sends the hook input on stdin; it is not needed here.
  }
}

const HELP = `用法：achat <命令>

  setup [--dry-run]                 为这台电脑上的 Claude Code 和 Codex 配好 Achat
  start                             启动消息中转服务、接待进程和查看网页
  status                            列出最近的协作
  mcp                               以 MCP 服务运行（由 AI 客户端调用，ACHAT_AGENT 指定身份）
  hook user-prompt --agent <id>     Claude Code 的待批准提醒 hook
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  const client = new RelayClient(relayUrl(cfg), cfg.token);

  switch (command) {
    case "start": {
      const { startRelay } = await import("./relay/server.js");
      const { Sidecar } = await import("./sidecar/sidecar.js");
      const { ClaudeRunner } = await import("./sidecar/runners.js");
      const { desktopNotify } = await import("./sidecar/notify.js");
      const relay = await startRelay({ config: cfg, dbPath: dbPath(), webDir: join(packageRoot, "web") });
      const runners = Object.fromEntries(
        cfg.agents.filter((a) => a.client === "claude").map((a) => [a.id, new ClaudeRunner()]),
      );
      const sidecar = new Sidecar({
        client: new RelayClient(relay.url, cfg.token),
        agents: cfg.agents,
        runners,
        notify: desktopNotify,
        webUrl: relay.url,
      });
      sidecar.start();
      console.log(`Achat 已启动：${relay.url}`);
      console.log(`接收方：${cfg.agents.filter((a) => runners[a.id]).map((a) => a.name).join("、") || "无"}`);
      const shutdown = async (): Promise<void> => {
        sidecar.stop();
        await relay.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "mcp": {
      const agentId = process.env.ACHAT_AGENT ?? flag(args, "--agent");
      if (!agentId || !cfg.agents.some((a) => a.id === agentId)) {
        console.error(`ACHAT_AGENT 需要是这些之一：${cfg.agents.map((a) => a.id).join(", ")}`);
        process.exit(1);
      }
      const { createMcpServer } = await import("./mcp/server.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = createMcpServer({ client, agentId, webUrl: relayUrl(cfg) });
      await server.connect(new StdioServerTransport());
      return;
    }
    case "hook": {
      if (args[0] !== "user-prompt") throw new Error("未知的 hook");
      const agentId = flag(args, "--agent");
      if (!agentId) throw new Error("缺少 --agent");
      await readStdin();
      const { userPromptHook } = await import("./hook.js");
      const out = await userPromptHook(client, agentId);
      if (out) process.stdout.write(out);
      return;
    }
    case "setup": {
      const { setup } = await import("./setup.js");
      const result = setup(join(packageRoot, "dist", "cli.js"), args.includes("--dry-run"));
      console.log(result.lines.join("\n"));
      return;
    }
    case "status": {
      const threads = await client.listThreads();
      const { STATUS_LABELS } = await import("./types.js");
      if (!threads.length) console.log("还没有协作。");
      for (const t of threads) {
        console.log(`${t.id}  ${STATUS_LABELS[t.status]}  ${t.from} → ${t.to}  ${t.topic}  ${t.roundsUsed}/${t.scope.maxRounds} 轮  $${t.costUsd.toFixed(2)}`);
      }
      return;
    }
    default:
      process.stdout.write(HELP);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
