import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { RelayClient } from "./client.js";
import { dbPath, loadConfig, type AchatConfig } from "./config.js";
import { connect, type Connection } from "./connection.js";
import { agentIdFor } from "./device.js";
import { checkLink } from "./link.js";
import { startRelay } from "./relay/server.js";
import { desktopAlert, desktopAsk, type Asker } from "./sidecar/dialog.js";
import { desktopNotify } from "./sidecar/notify.js";
import { ClaudeRunner, CodexRunner, type AgentRunner } from "./sidecar/runners.js";
import { ClaudeTaskOpener, type TaskOpener } from "./sidecar/tasks.js";
import { Sidecar } from "./sidecar/sidecar.js";
import { appDir, isInstalledCopy, setupWith, stageUpdate, switchTo, type Staged } from "./update.js";

const UPDATE_EVERY_MS = 30 * 60 * 1000;
// An update waits until nothing has been answered or asked for this long.
const QUIET_MS = 30_000;

interface Running {
  mode: Connection["mode"];
  stop(): Promise<void>;
}

// Counts answers being written and questions on screen, so that switching to
// a new version never cuts one off.
export class Activity {
  private active = 0;
  private last: number;

  constructor(private now: () => number = Date.now) {
    this.last = now();
  }

  private begin(): void {
    this.active++;
  }

  private end(): void {
    this.active--;
    this.last = this.now();
  }

  quietFor(ms: number): boolean {
    return this.active === 0 && this.now() - this.last >= ms;
  }

  runner(runner: AgentRunner): AgentRunner {
    return {
      run: async (input) => {
        this.begin();
        try {
          return await runner.run(input);
        } finally {
          this.end();
        }
      },
    };
  }

  asker(ask: Asker): Asker {
    return (prompt) => {
      const asking = ask(prompt);
      if (!asking) return null;
      this.begin();
      const end = (): void => this.end();
      asking.answer.then(end, end);
      return asking;
    };
  }
}

const activity = new Activity();
const ask = activity.asker(desktopAsk);

function runnerFor(client: AchatConfig["agents"][number]["client"]): AgentRunner {
  return activity.runner(client === "claude" ? new ClaudeRunner() : new CodexRunner());
}

// Only Claude Code opens a conversation of its own to 动手, so far.
function doersFor(cfg: AchatConfig, idOf: (a: AchatConfig["agents"][number]) => string): Record<string, TaskOpener> {
  return Object.fromEntries(cfg.agents.filter((a) => a.client === "claude").map((a) => [idOf(a), new ClaudeTaskOpener()]));
}

// Binds the local port, waiting for it while another copy holds it if asked.
async function listen<T>(open: () => Promise<T>, port: number, wait: boolean): Promise<T> {
  for (let waiting = false; ; waiting = true) {
    try {
      return await open();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if (!wait) throw new Error(`Achat 已经在运行：http://127.0.0.1:${port}`);
      // The background service waits here while a terminal copy holds the port.
      if (!waiting) console.log(`端口 ${port} 被占用，等它空出来再启动……`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// In account mode the local port only answers health checks and sends the
// browser on to the cloud page, so old bookmarks and `achat status` keep working.
function startPointer(cfg: AchatConfig, cloudUrl: string): Promise<Server> {
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${cfg.port}` && host !== `localhost:${cfg.port}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === "/api/health" && req.headers["x-achat-token"] === cfg.token) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pid: process.pid, startedAt, mode: "cloud" }));
      return;
    }
    if (req.url?.startsWith("/api/")) {
      res.writeHead(410, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `这台电脑已经加入 Achat 账号，请求要发到 ${cloudUrl}` }));
      return;
    }
    res.writeHead(302, { location: cloudUrl + "/" }).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => resolve(server));
  });
}

async function startLocal(cfg: AchatConfig, webDir: string, wait: boolean): Promise<Running> {
  const relay = await listen(() => startRelay({ config: cfg, dbPath: dbPath(), webDir }), cfg.port, wait);
  const runners = Object.fromEntries(cfg.agents.map((a) => [a.id, runnerFor(a.client)]));
  const sidecar = new Sidecar({
    client: new RelayClient(relay.url, cfg.token),
    agents: cfg.agents,
    runners,
    doers: doersFor(cfg, (a) => a.id),
    ask,
    alert: desktopAlert,
    notify: desktopNotify,
    webUrl: relay.url,
  });
  sidecar.start();
  console.log(`Achat 已启动：${relay.url}`);
  console.log(`接收方：${cfg.agents.map((a) => a.name).join("、")}`);
  return {
    mode: "local",
    stop: async () => {
      sidecar.stop();
      await relay.close();
    },
  };
}

async function startCloudMode(cfg: AchatConfig, conn: Connection, wait: boolean): Promise<Running> {
  const pointer = await listen(() => startPointer(cfg, conn.webUrl), cfg.port, wait);
  const deviceId = conn.deviceId!;
  const runners = Object.fromEntries(cfg.agents.map((a) => [agentIdFor(deviceId, a.client), runnerFor(a.client)]));
  const doers = doersFor(cfg, (a) => agentIdFor(deviceId, a.client));
  const sidecar = new Sidecar({ client: conn.client, agents: [], runners, doers, ask, alert: desktopAlert, notify: desktopNotify, webUrl: conn.webUrl });
  sidecar.start();
  console.log(`Achat 已启动（账号模式）：${conn.webUrl}`);
  return {
    mode: "cloud",
    stop: async () => {
      sidecar.stop();
      pointer.closeAllConnections();
      await new Promise((r) => pointer.close(r));
    },
  };
}

// `achat start`: runs the local relay, or, once this computer has joined an
// account, the sidecar against the cloud. It notices when a pending link is
// confirmed or the computer leaves its account, and switches over.
export async function runDaemon(opts: { webDir: string; wait: boolean }): Promise<void> {
  const begin = (cfg: AchatConfig): Promise<Running> => {
    const conn = connect(cfg);
    return conn.mode === "cloud" ? startCloudMode(cfg, conn, opts.wait) : startLocal(cfg, opts.webDir, opts.wait);
  };
  let running = await begin(loadConfig());
  let busy = false;

  // A copy installed from the service and run as the background service
  // (`start --wait`, which launchd or systemd starts again when it exits)
  // keeps itself up to date.
  let staged: Staged | null = null;
  let looking = false;
  const look = async (): Promise<void> => {
    const url = loadConfig().cloud?.url;
    if (!url || staged || looking) return;
    looking = true;
    try {
      staged = await stageUpdate({ url });
      if (staged) console.log(`新版 ${staged.release.version} 已经装好，手上的事做完就换上`);
    } catch (err) {
      console.error(`[achat] 检查更新：${(err as Error).message}`);
    } finally {
      looking = false;
    }
  };
  if (opts.wait && isInstalledCopy(dirname(opts.webDir))) {
    setTimeout(look, 60_000);
    setInterval(look, UPDATE_EVERY_MS);
  }
  // Switches to the staged copy and exits, so the service starts the new one.
  const restartOn = async (next: Staged): Promise<void> => {
    staged = null;
    switchTo(next);
    console.log(`已换成新版 ${next.release.version}，重新启动`);
    await setupWith(appDir(), false).catch((err) => console.error(`[achat] 更新 AI 的配置：${(err as Error).message}`));
    await running.stop();
    // Non-zero, so that systemd's Restart=on-failure starts it again too.
    process.exit(75);
  };

  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (staged && activity.quietFor(QUIET_MS)) await restartOn(staged);
      let cfg = loadConfig();
      if (cfg.cloud && !cfg.cloud.linked) {
        const name = await checkLink().catch(() => null);
        if (name) {
          console.log(`这台电脑已加入 ${name} 的 Achat 账号`);
          cfg = loadConfig();
        }
      }
      if (connect(cfg).mode !== running.mode) {
        await running.stop();
        running = await begin(cfg);
      }
    } catch (err) {
      console.error(`[achat] ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, 3000);

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
