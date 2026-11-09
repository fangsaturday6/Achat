import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LOCAL_PERSON, type AchatConfig, type AgentConfig } from "../config.js";
import { send, serveStatic } from "./http.js";
import { RelayError, RelayService, SWEEP_EVERY_MS } from "./service.js";
import { Store } from "./store.js";
import { threadsApi, type Viewer } from "./threads-api.js";

export interface RelayOptions {
  config: AchatConfig;
  dbPath: string;
  webDir: string;
  port?: number;
  now?: () => Date;
}

export interface RunningRelay {
  url: string;
  port: number;
  service: RelayService;
  close(): Promise<void>;
}

// The relay for one computer (experiment 0): the AIs listed in config.json,
// one token for everything, reachable only from this machine.
export async function startRelay(opts: RelayOptions): Promise<RunningRelay> {
  const store = new Store(opts.dbPath);
  // The AIs in config.json, and the person at this computer on the web page.
  const agents = new Map<string, AgentConfig>([...opts.config.agents, LOCAL_PERSON].map((a) => [a.id, a]));
  const service = new RelayService(store, opts.config, agents, opts.now);
  const token = opts.config.token;
  const startedAt = Date.now();
  let port = opts.port ?? opts.config.port;

  const everything: Viewer = {
    reader: "local",
    visible: null,
    sees: () => true,
    actsAs: () => true,
    approves: true,
    person: LOCAL_PERSON.id,
    agents: () => [...opts.config.agents, LOCAL_PERSON],
    // The person asking their own AIs needs no approval; the AIs asking each
    // other here still do, as in experiment 0.
    reach: (from) => from === LOCAL_PERSON.id,
  };

  // Only answer requests addressed to this machine by name, so a web page on
  // another site cannot reach the relay through DNS rebinding.
  const allowedHost = (host: string | undefined): boolean => {
    if (!host) return false;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  const server: Server = createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) return send(res, 403, { error: "只接受本机地址的访问" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
        return await serveStatic(res, opts.webDir, url.pathname, (html) => html.replace("__ACHAT_TOKEN__", token));
      }
      // A custom header forces a CORS preflight, which this server never
      // grants, so other web pages cannot call the API. EventSource cannot
      // set headers, so the event stream takes the token in the query.
      const given =
        req.headers["x-achat-token"] ??
        (url.pathname === "/api/events" ? url.searchParams.get("token") : undefined);
      if (given !== token) return send(res, 401, { error: "缺少或错误的 token" });
      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { pid: process.pid, startedAt, mode: "local" });
      }
      if (await threadsApi(req, res, url, service, everything)) return;
      throw new RelayError(404, "没有这个接口");
    } catch (err) {
      if (err instanceof RelayError) return send(res, err.status, { error: err.message });
      console.error("[achat relay]", err);
      if (!res.headersSent) send(res, 500, { error: "服务内部错误" });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    store.close();
    throw err;
  }
  port = (server.address() as AddressInfo).port;
  // Brings up requests waiting for hours and gives up ones waiting for days.
  const sweeping = setInterval(() => service.sweep(), SWEEP_EVERY_MS);
  sweeping.unref();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    service,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeping);
        server.closeAllConnections();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}
