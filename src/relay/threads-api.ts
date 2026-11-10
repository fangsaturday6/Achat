import type { IncomingMessage, ServerResponse } from "node:http";
import { FILES_BODY_LIMIT, SHOWN_TYPES, type NewFile } from "../attachments.js";
import type { AgentConfig } from "../config.js";
import type { Thread, ThreadMode, ThreadStatus } from "../types.js";
import { optNum, readJson, send, str } from "./http.js";
import { RelayError, type RelayService } from "./service.js";

const STATUSES = new Set(["pending", "active", "declined", "closed", "stopped", "expired"]);

// Who is calling and what they may do. The local relay has one caller that
// may do everything; in the cloud a caller is a logged-in person or one of
// their computers, limited to their own account's threads.
export interface Viewer {
  // Whose read marks these are: the account, or the person on this computer.
  reader: string;
  // Agents whose threads the caller can list; null means every thread.
  visible: string[] | null;
  sees(agent: string): boolean;
  // Agents the caller speaks for: sending requests, posting messages, answering.
  actsAs(agent: string): boolean;
  // Whether the caller can approve or decline requests to agents it sees.
  approves: boolean;
  // The caller's own seat when the caller is the person on the web page:
  // they start conversations from it, and write in their AIs' threads as
  // themselves. Null for computers and AIs.
  person: string | null;
  // The AIs the caller can contact, named from its point of view.
  agents(): AgentConfig[];
  // Throws if `from` may not contact `to`; returns true when the request needs
  // no approval.
  reach(from: string, to: string): boolean;
}

function readable(viewer: Viewer, t: Thread): boolean {
  return viewer.sees(t.from) || viewer.sees(t.to);
}

// Checked by the service, which says what the allowed values are.
function modeOf(body: Record<string, unknown>): ThreadMode | undefined {
  return body.mode === undefined || body.mode === null ? undefined : (body.mode as ThreadMode);
}

// Starting a conversation and saying something in one may carry files.
export function takesFiles(method: string, pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean).slice(1);
  return method === "POST" && parts[0] === "threads" && (parts.length === 1 || (parts.length === 3 && parts[2] === "messages"));
}

// Files as sent: a name, maybe a type, and the bytes in base64.
function filesOf(body: Record<string, unknown>): NewFile[] {
  const raw = body.files;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RelayError(400, "files 需要是文件的列表");
  return raw.map((f: unknown) => {
    const file = f as Record<string, unknown> | null;
    if (!file || typeof file.name !== "string" || typeof file.data !== "string") throw new RelayError(400, "每个文件需要 name 和 data");
    if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(file.data)) throw new RelayError(400, "文件内容需要是 base64");
    return { name: file.name, type: typeof file.type === "string" ? file.type : "", data: Buffer.from(file.data, "base64") };
  });
}

// Handles /api/agents, /api/events, /api/threads/* and /api/files/*;
// returns false for other paths.
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

  // A file is for whoever can read its conversation. Only pictures show in
  // the page; anything else is downloaded, so it cannot run as a page there.
  if (method === "GET" && parts[0] === "files" && parts.length === 2) {
    const file = service.file(parts[1]);
    if (!file || !readable(viewer, service.getThread(file.threadId))) throw new RelayError(404, "找不到这个文件");
    const shown = SHOWN_TYPES.has(file.type);
    res.writeHead(200, {
      "content-type": shown ? file.type : "application/octet-stream",
      "content-length": String(file.data.length),
      "content-disposition": `${shown ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(file.data);
    return true;
  }

  if (parts[0] !== "threads") return false;

  if (parts.length === 1 && method === "GET") {
    const status = url.searchParams.get("status");
    if (status && !STATUSES.has(status)) throw new RelayError(400, "未知的状态");
    const threads = service.listThreads({
      agents: viewer.visible ?? undefined,
      agent: url.searchParams.get("agent") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      status: (status as ThreadStatus | null) ?? undefined,
      surfaced: url.searchParams.get("surfaced") === "1",
      unseen: url.searchParams.get("unseen") ?? undefined,
    });
    send(
      res,
      200,
      threads.map((t) => ({ ...t, unread: service.unread(t, viewer.reader, (a) => viewer.sees(a)) })),
    );
    return true;
  }

  if (parts.length === 1 && method === "POST") {
    const body = await readJson(req, FILES_BODY_LIMIT);
    const from = str(body, "from");
    const to = str(body, "to");
    if (!viewer.actsAs(from) && from !== viewer.person) throw new RelayError(403, "只能以这台电脑上的 AI 的身份发请求");
    const autoApprove = viewer.reach(from, to);
    send(
      res,
      201,
      service.createRequest(
        { from, to, topic: str(body, "topic"), message: str(body, "message"), mode: modeOf(body), byPerson: from === viewer.person, files: filesOf(body) },
        { autoApprove },
      ),
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

  const body = await readJson(req, takesFiles(method, url.pathname) ? FILES_BODY_LIMIT : undefined);
  const forbid = (message: string): never => {
    throw new RelayError(403, message);
  };
  switch (action) {
    case "approve":
      if (!viewer.approves || !viewer.sees(thread.to)) forbid("只有接收方的主人可以批准");
      send(res, 200, service.approve(id, { maxRounds: optNum(body, "maxRounds"), budgetUsd: optNum(body, "budgetUsd"), mode: modeOf(body) }));
      return true;
    case "read":
      if (!viewer.approves) forbid("只有人可以标记已读");
      service.markRead(viewer.reader, id);
      send(res, 200, { ok: true });
      return true;
    case "seen": {
      if (!viewer.actsAs(thread.from)) forbid("只有发起方的 AI 可以标记看到了哪里");
      const seq = optNum(body, "seq");
      if (seq === undefined) throw new RelayError(400, "缺少 seq");
      service.markSeen(id, seq);
      send(res, 200, { ok: true });
      return true;
    }
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
    case "note":
      if (!viewer.actsAs(thread.to)) forbid("只有接收方可以留言");
      send(res, 200, service.note(id, str(body, "body")));
      return true;
    case "end":
      if (!viewer.actsAs(thread.to)) forbid("只有接收方可以结束");
      send(res, 200, service.end(id, str(body, "note")));
      return true;
    case "more":
      if (!viewer.actsAs(thread.to)) forbid("只有接收方可以申请接着聊");
      send(res, 200, service.askMore(id, str(body, "note")));
      return true;
    case "messages": {
      const from = str(body, "from");
      // The person writes in a thread of their own AIs as themselves.
      const byPerson = viewer.person !== null && (from === viewer.person || (body.byPerson === true && viewer.sees(from)));
      if (!viewer.actsAs(from) && !byPerson) forbid("只能以这台电脑上的 AI 的身份发消息");
      send(
        res,
        201,
        service.postMessage(id, {
          from,
          body: str(body, "body"),
          costUsd: optNum(body, "costUsd"),
          redactions: optNum(body, "redactions"),
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
          mode: modeOf(body),
          byPerson,
          files: filesOf(body),
        }),
      );
      return true;
    }
    default:
      return false;
  }
}
