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

  setup [--dry-run] [--no-autostart]
                                    为这台电脑上的 Claude Code 和 Codex 配好 Achat，并设为开机自启
  start [--wait]                    启动消息中转服务、接待进程和查看网页；--wait 在端口被占用时等它空出来
  autostart on|off                  打开或关闭开机自启
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
      const { ClaudeRunner, CodexRunner } = await import("./sidecar/runners.js");
      const { desktopNotify } = await import("./sidecar/notify.js");
      const open = () => startRelay({ config: cfg, dbPath: dbPath(), webDir: join(packageRoot, "web") });
      let relay: Awaited<ReturnType<typeof open>>;
      for (let waiting = false; ; waiting = true) {
        try {
          relay = await open();
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
          if (!args.includes("--wait")) {
            console.error(`Achat 已经在运行：${relayUrl(cfg)}`);
            process.exit(1);
          }
          // The background service waits here while a terminal copy holds the port.
          if (!waiting) console.log(`端口 ${cfg.port} 被占用，等它空出来再启动……`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      const runners = Object.fromEntries(
        cfg.agents.map((a) => [a.id, a.client === "claude" ? new ClaudeRunner() : new CodexRunner()]),
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
      const cli = join(packageRoot, "dist", "cli.js");
      const dryRun = args.includes("--dry-run");
      const autostart = !args.includes("--no-autostart");
      const result = setup(cli, { dryRun, autostart });
      console.log(result.lines.join("\n"));
      if (result.autostarted) {
        const { takeOver } = await import("./running.js");
        console.log("\n" + (await takeOver(client, cli, cfg.port, result.autostarted.log)));
      }
      return;
    }
    case "autostart": {
      const { disableAutostart, enableAutostart } = await import("./autostart.js");
      const cli = join(packageRoot, "dist", "cli.js");
      if (args[0] === "on") {
        const { text, log } = enableAutostart(cli);
        console.log(text);
        if (log) {
          const { takeOver } = await import("./running.js");
          console.log(await takeOver(client, cli, cfg.port, log));
        }
      } else if (args[0] === "off") console.log(disableAutostart(cli));
      else throw new Error("用法：achat autostart on|off");
      return;
    }
    case "status": {
      const { checkRunning } = await import("./running.js");
      const running = await checkRunning(client, join(packageRoot, "dist", "cli.js"));
      if (running.state === "stale") {
        console.log("正在运行的 Achat 是更新前启动的，还在用旧代码。运行 setup 换成新版。\n");
      }
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
  const refused = (err as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
  console.error(refused ? "Achat 没有在运行。运行 achat start，或者 achat autostart on 设为开机自启。" : err.message);
  process.exit(1);
});
