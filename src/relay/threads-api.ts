import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentConfig } from "../config.js";
import type { Thread, ThreadStatus } from "../types.js";
import { optNum, readJson, send, str } from "./http.js";
import { RelayError, type RelayService } from "./service.js";

const STATUSES = new Set(["pending", "active", "declined", "closed", "stopped"]);

// Who is calling and what they may do. The local relay has one caller that
// may do everything; in the cloud a caller is a logged-in person or one of
// their computers, limited to their own account's threads.
export interface Viewer {
  // Agents whose threads the caller can list; null means every thread.
  visible: string[] | null;
  sees(agent: string): boolean;
  // Agents the caller speaks for: sending requests, posting messages, answering.
  actsAs(agent: string): boolean;
  // Whether the caller can approve or decline requests to agents it sees.
  approves: boolean;
  // The AIs the caller can contact, named from its point of view.
  agents(): AgentConfig[];
  // Throws if `from` may not contact `to`; returns true when the request needs
  // no approval.
  reach(from: string, to: string): boolean;
}

function readable(viewer: Viewer, t: Thread): boolean {
  return viewer.sees(t.from) || viewer.sees(t.to);
}

// Handles /api/agents, /api/events and /api/threads/*; returns false for
// other paths.
export async function threadsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: RelayService,
  viewer: Viewer,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"

  if (method === "GET" && parts[0] === "agents" && parts.length === 1) {
    send(res, 200, viewer.agents());
    return true;
  }

  if (method === "GET" && parts[0] === "events" && parts.length === 1) {
    const agent = url.searchParams.get("agent");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const off = service.onEvent((e) => {
      if (!viewer.sees(e.from) && !viewer.sees(e.to)) return;
      if (agent && e.from !== agent && e.to !== agent) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    // The response closes with the connection; the request may already have
    // closed once its (empty) body was read.
    res.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
    return true;
  }

  if (parts[0] !== "threads") return false;

  if (parts.length === 1 && method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !STATUSES.has(status)) throw new RelayError(400, "未知的状态");
    send(
      res,
      200,
      service.listThreads({
        agents: viewer.visible ?? undefined,
        agent: url.searchParams.get("agent") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        status: (status as ThreadStatus | null) ?? undefined,
        surfaced: url.searchParams.get("surfaced") === "1",
      }),
    );
    return true;
  }

  if (parts.length === 1 && method === "POST") {
    const body = await readJson(req);
    const from = str(body, "from");
    const to = str(body, "to");
    if (!viewer.actsAs(from)) throw new RelayError(403, "只能以这台电脑上的 AI 的身份发请求");
    const autoApprove = viewer.reach(from, to);
    send(
      res,
      201,
      service.createRequest({ from, to, topic: str(body, "topic"), message: str(body, "message") }, { autoApprove }),
    );
    return true;
  }

  if (parts.length < 2 || parts.length > 3) return false;
  const id = parts[1];
  const action = parts[2];
  // A thread the caller cannot see looks the same as one that does not exist.
  const thread = service.getThread(id);
  if (!readable(viewer, thread)) throw new RelayError(404, "找不到这次协作");

  if (method === "GET" && !action) {
    send(res, 200, thread);
    return true;
  }
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
    send(res, 200, detail);
    return true;
  }
  if (method !== "POST") return false;

  const body = await readJson(req);
  const forbid = (message: string): never => {
    throw new RelayError(403, message);
  };
  switch (action) {
    case "approve":
      if (!viewer.approves || !viewer.sees(thread.to)) forbid("只有接收方的主人可以批准");
      send(res, 200, service.approve(id, { maxRounds: optNum(body, "maxRounds"), budgetUsd: optNum(body, "budgetUsd") }));
      return true;
    case "decline":
      if (!viewer.approves || !viewer.sees(thread.to)) forbid("只有接收方的主人可以拒绝");
      send(res, 200, service.decline(id));
      return true;
    case "stop":
      send(res, 200, service.stop(id, typeof body.by === "string" && viewer.sees(body.by) ? body.by : null));
      return true;
    case "close": {
      const by = str(body, "by");
      if (!viewer.actsAs(by)) forbid("不是这次协作的参与方");
      send(res, 200, service.close(id, by));
      return true;
    }
    case "fail":
      if (!viewer.actsAs(thread.to)) forbid("只有接收方可以报告出错");
      send(res, 200, service.fail(id, str(body, "reason")));
      return true;
    case "end":
      if (!viewer.actsAs(thread.to)) forbid("只有接收方可以结束");
      send(res, 200, service.end(id, str(body, "note")));
      return true;
    case "messages": {
      const from = str(body, "from");
      if (!viewer.actsAs(from)) forbid("只能以这台电脑上的 AI 的身份发消息");
      send(
        res,
        201,
        service.postMessage(id, {
          from,
          body: str(body, "body"),
          costUsd: optNum(body, "costUsd"),
          redactions: optNum(body, "redactions"),
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        }),
      );
      return true;
    }
    default:
      return false;
  }
}
