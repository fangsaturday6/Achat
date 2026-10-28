import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { AchatConfig } from "../config.js";
import type { ThreadStatus } from "../types.js";
import { RelayError, RelayService } from "./service.js";
import { Store } from "./store.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const STATUSES = new Set(["pending", "active", "declined", "closed", "stopped"]);

export interface RelayOptions {
  config: AchatConfig;
  dbPath: string;
  webDir: string;
  port?: number;
}

export interface RunningRelay {
  url: string;
  port: number;
  service: RelayService;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new RelayError(413, "请求太大");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RelayError(400, "请求内容不是合法的 JSON 对象");
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new RelayError(400, `缺少字段：${key}`);
  return value;
}

function optNum(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RelayError(400, `字段 ${key} 需要是数字`);
  return value;
}

export async function startRelay(opts: RelayOptions): Promise<RunningRelay> {
  const store = new Store(opts.dbPath);
  const service = new RelayService(store, opts.config);
  const token = opts.config.token;
  let port = opts.port ?? opts.config.port;

  // Only answer requests addressed to this machine by name, so a web page on
  // another site cannot reach the relay through DNS rebinding.
  const allowedHost = (host: string | undefined): boolean => {
    if (!host) return false;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = normalize(join(opts.webDir, rel));
    if (!file.startsWith(normalize(opts.webDir))) return send(res, 404, { error: "not found" });
    try {
      let content: Buffer | string = await readFile(file);
      if (rel === "index.html") content = content.toString("utf8").replace("__ACHAT_TOKEN__", token);
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
      });
      res.end(content);
    } catch {
      send(res, 404, { error: "not found" });
    }
  }

  function events(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const agent = url.searchParams.get("agent");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const off = service.onEvent((e) => {
      if (agent && e.from !== agent && e.to !== agent) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"

    if (method === "GET" && parts[0] === "events") return events(req, res, url);
    if (method === "GET" && parts[0] === "agents") return send(res, 200, service.listAgents());

    if (parts[0] === "threads" && parts.length === 1) {
      if (method === "GET") {
        const status = url.searchParams.get("status");
        if (status && !STATUSES.has(status)) throw new RelayError(400, "未知的状态");
        return send(
          res,
          200,
          service.listThreads({
            agent: url.searchParams.get("agent") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
            status: (status as ThreadStatus | null) ?? undefined,
            surfaced: url.searchParams.get("surfaced") === "1",
          }),
        );
      }
      if (method === "POST") {
        const body = await readJson(req);
        return send(
          res,
          201,
          service.createRequest({
            from: str(body, "from"),
            to: str(body, "to"),
            topic: str(body, "topic"),
            message: str(body, "message"),
          }),
        );
      }
    }

    if (parts[0] === "threads" && parts[1]) {
      const id = parts[1];
      const action = parts[2];
      if (method === "GET" && !action) return send(res, 200, service.getThread(id));
      if (method === "GET" && action === "wait") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const timeout = Number(url.searchParams.get("timeout") ?? 25_000);
        const status = url.searchParams.get("status");
        const detail = await service.waitFor(
          id,
          Number.isFinite(after) ? after : 0,
          Number.isFinite(timeout) ? timeout : 25_000,
          status && STATUSES.has(status) ? (status as ThreadStatus) : undefined,
        );
        return send(res, 200, detail);
      }
      if (method === "POST") {
        const body = await readJson(req);
        switch (action) {
          case "approve":
            return send(
              res,
              200,
              service.approve(id, { maxRounds: optNum(body, "maxRounds"), budgetUsd: optNum(body, "budgetUsd") }),
            );
          case "decline":
            return send(res, 200, service.decline(id));
          case "stop":
            return send(res, 200, service.stop(id, typeof body.by === "string" ? body.by : null));
          case "close":
            return send(res, 200, service.close(id, str(body, "by")));
          case "fail":
            return send(res, 200, service.fail(id, str(body, "reason")));
          case "end":
            return send(res, 200, service.end(id, str(body, "note")));
          case "messages":
            return send(
              res,
              201,
              service.postMessage(id, {
                from: str(body, "from"),
                body: str(body, "body"),
                costUsd: optNum(body, "costUsd"),
                redactions: optNum(body, "redactions"),
                sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
              }),
            );
        }
      }
    }
    throw new RelayError(404, "没有这个接口");
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) return send(res, 403, { error: "只接受本机地址的访问" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
        return await serveStatic(res, url.pathname);
      }
      // A custom header forces a CORS preflight, which this server never
      // grants, so other web pages cannot call the API. EventSource cannot
      // set headers, so the event stream takes the token in the query.
      const given =
        req.headers["x-achat-token"] ??
        (url.pathname === "/api/events" ? url.searchParams.get("token") : undefined);
      if (given !== token) return send(res, 401, { error: "缺少或错误的 token" });
      await api(req, res, url);
    } catch (err) {
      if (err instanceof RelayError) return send(res, err.status, { error: err.message });
      console.error("[achat relay]", err);
      if (!res.headersSent) send(res, 500, { error: "服务内部错误" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    service,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}
