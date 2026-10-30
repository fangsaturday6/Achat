#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "./client.js";
import { loadConfig, relayUrl } from "./config.js";

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
  start [--wait]                    启动 Achat；--wait 在端口被占用时等它空出来
  autostart on|off                  打开或关闭开机自启
  status                            列出最近的协作
  doctor                            检查请求能不能提醒到你：后台服务、账号、Claude Code 和 Codex 的提醒
  link [地址] [--no-wait] [--token 凭证]
                                    把这台电脑加入你的 Achat 账号；带上网页给的凭证时直接加入
  unlink                            让这台电脑退出 Achat 账号，并删除本机钥匙
  invite [email]                    加朋友：填邮箱发邀请，不填就生成邀请链接
  serve                             运行云端的 Achat 服务（部署在服务器上，见 deploy/）
  mcp                               以 MCP 服务运行（由 AI 客户端调用，ACHAT_AGENT 指定身份）
  hook user-prompt --agent <id>     Claude Code 和 Codex 的待批准提醒 hook
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "serve") {
    const { serve } = await import("./cloud/serve.js");
    await serve(packageRoot);
    return;
  }
  const cfg = loadConfig();
  // The local relay, or in account mode the small local server that answers
  // health checks for the background service.
  const local = new RelayClient(relayUrl(cfg), cfg.token);
  const { connect } = await import("./connection.js");

  switch (command) {
    case "start": {
      const { runDaemon } = await import("./daemon.js");
      await runDaemon({ webDir: join(packageRoot, "web"), wait: args.includes("--wait") });
      return;
    }
    case "mcp": {
      const localId = process.env.ACHAT_AGENT ?? flag(args, "--agent");
      if (!localId || !cfg.agents.some((a) => a.id === localId)) {
        console.error(`ACHAT_AGENT 需要是这些之一：${cfg.agents.map((a) => a.id).join(", ")}`);
        process.exit(1);
      }
      const { createMcpServer } = await import("./mcp/server.js");
      const { startLink } = await import("./link.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = createMcpServer({
        connection: () => {
          const conn = connect(loadConfig());
          return { client: conn.client, agentId: conn.agentId(localId), webUrl: conn.webUrl, mode: conn.mode };
        },
        link: (url) => startLink(url),
      });
      await server.connect(new StdioServerTransport());
      return;
    }
    case "doctor": {
      const { doctor } = await import("./doctor.js");
      console.log((await doctor(join(packageRoot, "dist", "cli.js"))).join("\n"));
      return;
    }
    case "hook": {
      if (args[0] !== "user-prompt") throw new Error("未知的 hook");
      const localId = flag(args, "--agent");
      if (!localId) throw new Error("缺少 --agent");
      await readStdin();
      const { userPromptHook } = await import("./hook.js");
      const conn = connect(cfg);
      const out = await userPromptHook(conn.client, conn.agentId(localId));
      if (out) process.stdout.write(out);
      return;
    }
    case "link": {
      if (cfg.cloud?.linked) {
        console.log(`这台电脑已经加入了 Achat 账号（${cfg.cloud.url}）。要换账号，先运行 achat unlink。`);
        return;
      }
      const { checkLink, startLink } = await import("./link.js");
      const enroll = flag(args, "--token");
      const ticket = await startLink(
        args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--token"),
        undefined,
        enroll,
      );
      if (ticket.status === "approved") {
        console.log(`✓ 这台电脑已加入 ${ticket.account} 的 Achat 账号。后台的 Achat 会自动切换，不用重启。`);
        return;
      }
      console.log(`在浏览器打开这个链接，用邮箱登录后确认添加这台电脑（10 分钟内有效）：\n\n  ${ticket.url}\n`);
      console.log(`确认前核对：页面上的配对码应该是 ${ticket.code}\n`);
      if (args.includes("--no-wait")) {
        console.log("确认后，后台的 Achat 会自动切换到账号模式，不用重启。");
        return;
      }
      const deadline = Date.parse(ticket.expiresAt);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const name = await checkLink();
        if (name) {
          console.log(`✓ 这台电脑已加入 ${name} 的 Achat 账号。后台的 Achat 会自动切换，不用重启。`);
          return;
        }
      }
      throw new Error("链接已过期，重新运行 achat link");
    }
    case "unlink": {
      const { unlink } = await import("./link.js");
      console.log(await unlink());
      return;
    }
    case "invite": {
      const conn = connect(cfg);
      if (conn.mode !== "cloud") throw new Error("这台电脑还没加入 Achat 账号。先运行 achat link");
      const email = args.find((a) => a.includes("@"));
      if (email) {
        const sent = await conn.client.createInvite(email);
        console.log(sent.status === "accepted" ? `已经和${sent.contact!.name}成为朋友。` : `已邀请 ${sent.email}，等对方接受。`);
        return;
      }
      const invite = await conn.client.createInvite();
      console.log(`邀请链接（7 天内有效，只能用一次）：\n\n  ${invite.url}\n\n把它发给要连上的人。`);
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
        console.log("\n" + (await takeOver(local, cli, cfg.port, result.autostarted.log)));
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
          console.log(await takeOver(local, cli, cfg.port, log));
        }
      } else if (args[0] === "off") console.log(disableAutostart(cli));
      else throw new Error("用法：achat autostart on|off");
      return;
    }
    case "status": {
      const { checkRunning } = await import("./running.js");
      const running = await checkRunning(local, join(packageRoot, "dist", "cli.js"));
      if (running.state === "stale") {
        console.log("正在运行的 Achat 是更新前启动的，还在用旧代码。运行 setup 换成新版。\n");
      }
      const conn = connect(cfg);
      if (conn.mode === "cloud") console.log(`账号模式：${conn.webUrl}\n`);
      else if (cfg.cloud) console.log(`正在等你在网页上确认添加这台电脑（${cfg.cloud.url}）\n`);
      const threads = await conn.client.listThreads();
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
