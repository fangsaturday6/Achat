import type { IncomingMessage, ServerResponse } from "node:http";
import { FILES_BODY_LIMIT } from "../attachments.js";
import { isEffort } from "../models.js";
import type { GroupTarget } from "../types.js";
import type { Caller, GroupService } from "./groups.js";
import { optNum, readJson, send, str } from "./http.js";
import { RelayError } from "./service.js";
import { filesOf, takesFiles, type Viewer } from "./threads-api.js";

function callerOf(viewer: Viewer): Caller {
  return { account: viewer.reader, person: viewer.person, actsAs: (a) => viewer.actsAs(a), approves: viewer.approves };
}

// Someone to bring in, as sent: {"agent": an AI's id} or {"account": a person's id}.
function targetsOf(body: Record<string, unknown>): GroupTarget[] {
  const raw = body.members ?? [];
  if (!Array.isArray(raw)) throw new RelayError(400, "members 需要是列表");
  return raw.map((t: unknown) => {
    const o = t as Record<string, unknown> | null;
    if (o && typeof o.agent === "string") return { agent: o.agent };
    if (o && typeof o.account === "string") return { account: o.account };
    throw new RelayError(400, '每个成员需要 {"agent": AI 的 id} 或 {"account": 人的 id}');
  });
}

function mentionsOf(body: Record<string, unknown>): string[] {
  const raw = body.mentions ?? [];
  if (!Array.isArray(raw) || raw.some((m) => typeof m !== "string")) throw new RelayError(400, "mentions 需要是 AI 的 id 列表，@所有人填 all");
  return raw as string[];
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RelayError(400, `字段 ${key} 需要是文字`);
  return value;
}

function num(body: Record<string, unknown>, key: string): number {
  const value = optNum(body, key);
  if (value === undefined) throw new RelayError(400, `缺少字段：${key}`);
  return value;
}

// Handles /api/groups/*; returns false for other paths. Groups need an
// account, so only the cloud serves these.
export async function groupsApi(req: IncomingMessage, res: ServerResponse, url: URL, groups: GroupService, viewer: Viewer): Promise<boolean> {
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  if (parts[0] !== "groups") return false;
  const caller = callerOf(viewer);
  const ok = (status: number, body: unknown): true => {
    send(res, status, body);
    return true;
  };

  if (parts.length === 1) {
    if (method === "GET") return ok(200, groups.list(caller, viewer.visible ?? []));
    if (method !== "POST") return false;
    const body = await readJson(req, FILES_BODY_LIMIT);
    return ok(
      201,
      groups.createGroup(caller, { from: str(body, "from"), name: optStr(body, "name"), members: targetsOf(body), message: optStr(body, "message"), files: filesOf(body) }),
    );
  }
  if (parts.length === 2 && parts[1] === "work" && method === "GET") {
    const agents = (url.searchParams.get("agents") ?? "").split(",").filter(Boolean);
    return ok(200, groups.work(caller, agents));
  }
  if (parts.length === 2 && parts[1] === "unseen" && method === "GET") {
    return ok(200, { groups: groups.unseen(caller, url.searchParams.get("agent") ?? "") });
  }

  const id = parts[1];
  const action = parts[2];
  if (method === "GET") {
    if (parts.length === 2) return ok(200, groups.detail(caller, id));
    if (action === "wait") {
      // A group the caller cannot see is not waited on.
      groups.detail(caller, id);
      const timeout = Number(url.searchParams.get("timeout") ?? 25_000);
      await groups.waitFor(id, Number.isFinite(timeout) ? timeout : 25_000);
      return ok(200, groups.detail(caller, id));
    }
    if (action === "work") return ok(200, groups.workFor(caller, id, url.searchParams.get("agent") ?? "", url.searchParams.get("fresh") === "1"));
    return false;
  }
  if (method !== "POST") return false;
  const body = await readJson(req, takesFiles(method, url.pathname) ? FILES_BODY_LIMIT : undefined);

  if (action === "invites" && parts.length === 5) {
    if (parts[4] === "accept") {
      const agents = Array.isArray(body.agents) ? body.agents.filter((a): a is string => typeof a === "string") : undefined;
      return ok(200, groups.acceptInvite(caller, id, parts[3], { agents, quota: optNum(body, "quota") }));
    }
    if (parts[4] === "decline") return ok(200, groups.declineInvite(caller, id, parts[3]));
    return false;
  }
  // 动手: only the computer of the AI asked calls these, the last two once its person answered the dialog.
  if (action === "acts" && parts.length === 5) {
    if (parts[4] === "approve") return ok(200, groups.approveAct(caller, id, parts[3]));
    if (parts[4] === "decline") return ok(200, groups.declineAct(caller, id, parts[3]));
    return false;
  }
  if (parts.length !== 3) return false;
  switch (action) {
    case "messages": {
      const effort = optStr(body, "effort");
      return ok(
        201,
        groups.postMessage(caller, id, {
          from: str(body, "from"),
          body: typeof body.body === "string" ? body.body : "",
          mentions: mentionsOf(body),
          files: filesOf(body),
          replyTo: optNum(body, "replyTo"),
          epoch: optNum(body, "epoch"),
          sessionId: optStr(body, "sessionId"),
          readTo: optNum(body, "readTo"),
          costUsd: optNum(body, "costUsd"),
          redactions: optNum(body, "redactions"),
          model: optStr(body, "model"),
          effort: isEffort(effort) ? effort : undefined,
        }),
      );
    }
    case "acts":
      return ok(200, groups.requestAct(caller, id, { doer: str(body, "doer"), seq: num(body, "seq") }));
    case "invites":
      return ok(200, groups.invite(caller, id, { from: str(body, "from"), members: targetsOf(body) }));
    case "pass":
      return ok(
        200,
        groups.pass(caller, id, {
          agent: str(body, "agent"),
          seq: num(body, "seq"),
          epoch: optNum(body, "epoch"),
          reason: optStr(body, "reason"),
          sessionId: optStr(body, "sessionId"),
          readTo: optNum(body, "readTo"),
        }),
      );
    case "fail":
      return ok(200, groups.fail(caller, id, { agent: str(body, "agent"), seq: num(body, "seq"), reason: str(body, "reason") }));
    case "hold":
      return ok(200, groups.hold(caller, id, { agent: str(body, "agent"), seq: num(body, "seq"), reason: str(body, "reason") }));
    case "stop":
      return ok(200, groups.stop(caller, id, optStr(body, "by")));
    case "continue":
      return ok(200, groups.resume(caller, id, optStr(body, "by")));
    case "quota":
      return ok(200, groups.setQuota(caller, id, { agent: str(body, "agent"), perDay: num(body, "perDay") }));
    case "extra":
      return ok(200, groups.addToday(caller, id, { agent: str(body, "agent") }));
    case "leave":
      return ok(200, groups.leave(caller, id, str(body, "agent")));
    case "remove":
      return ok(200, groups.remove(caller, id, str(body, "agent")));
    case "dissolve":
      return ok(200, groups.dissolve(caller, id));
    case "rename":
      return ok(200, groups.rename(caller, id, str(body, "name")));
    case "read":
      groups.markRead(caller, id);
      return ok(200, { ok: true });
    case "seen":
      return ok(200, groups.markSeen(caller, id, { agent: str(body, "agent"), seq: num(body, "seq") }));
  }
  return false;
}
