import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { AgentClient, AgentConfig, RemoteClient } from "../config.js";
import { checkSignature, deviceIdFor, pairingCode, SIGNATURE_WINDOW_MS } from "../device.js";
import { parseJson, readBody, send, serveStatic, str } from "../relay/http.js";
import { RelayError, RelayService, type RelaySettings } from "../relay/service.js";
import { Store } from "../relay/store.js";
import { threadsApi, type Viewer } from "../relay/threads-api.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RelayClient } from "../client.js";
import { createMcpServer } from "../mcp/server.js";
import { AccountStore, CLIENT_LABEL, hashSecret, type Account, type AgentRecord, type Device, type Invite } from "./accounts.js";
import { acceptedEmail, inviteEmail, loginCodeEmail, requestEmail } from "./emails.js";
import type { Mailer } from "./mailer.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CODE_TTL = 10 * MINUTE;
const CODE_RESEND_AFTER = MINUTE;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL = 30 * DAY;
const LINK_TTL = 10 * MINUTE;
const INVITE_TTL = 7 * DAY;
const COOKIE = "achat_session";
const CLIENTS = new Set<AgentClient>(["claude", "codex"]);
// Collections whose second path segment is an id.
const WITH_ID = new Set(["device-links", "invites", "devices", "contacts", "connect", "agents"]);
const REMOTE_CLIENTS = new Set<RemoteClient>(["doubao", "workbuddy", "other"]);
// Request emails one sender can cause per receiver per day.
const REQUEST_EMAILS_PER_DAY = 3;
// How long the remote MCP tools wait for a reply; clients of remote servers
// tend to give up on calls much sooner than local ones.
const REMOTE_WAIT_SECONDS = 50;

export const CLOUD_DEFAULTS: RelaySettings = {
  defaults: { maxRounds: 5, budgetUsd: 5 },
  limits: { surfacedPerContactPerDay: 5, sentPerDay: 20 },
};

export interface CloudOptions {
  dbPath: string;
  webDir: string;
  // The Achat package root; people's computers download it from here (see
  // deploy/client-install.sh). Defaults to the folder above webDir.
  appDir?: string;
  // Where people reach the service, e.g. https://achat.example.com; used in
  // links and to decide whether cookies need HTTPS.
  publicUrl: string;
  mailer: Mailer;
  port?: number;
  host?: string;
  settings?: RelaySettings;
  // Behind a reverse proxy, take the client address from X-Forwarded-For.
  trustProxy?: boolean;
  now?: () => Date;
}

export interface RunningCloud {
  url: string;
  port: number;
  service: RelayService;
  accounts: AccountStore;
  close(): Promise<void>;
}

// Who is calling: a person on the web, one of their computers (signed
// requests), or an AI that connects by address (its credential).
type Principal =
  | { kind: "web"; account: Account; token: string }
  | { kind: "device"; account: Account; device: Device }
  | { kind: "agent"; account: Account; agent: AgentRecord };

// Counts events per key in a sliding window, in memory.
class Limiter {
  private hits = new Map<string, number[]>();

  allow(key: string, limit: number, windowMs: number, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

function cookies(req: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RelayError(400, "邮箱格式不对");
  return email;
}

// The Achat service on the internet: accounts, computers, invites, and the
// same thread routes as the local relay, limited to each account's threads.
export async function startCloud(opts: CloudOptions): Promise<RunningCloud> {
  const now = opts.now ?? (() => new Date());
  const store = new Store(opts.dbPath);
  const accounts = new AccountStore(store.db, now);
  const service = new RelayService(store, opts.settings ?? CLOUD_DEFAULTS, {
    get: (id) => {
      const agent = accounts.agent(id);
      return agent ? accounts.agentConfig(agent) : undefined;
    },
  }, now);
  const publicUrl = opts.publicUrl.replace(/\/+$/, "");
  const secure = publicUrl.startsWith("https://");
  const limiter = new Limiter();
  const seenSignatures = new Map<string, number>();
  const startedAt = Date.now();

  const ms = (): number => now().getTime();

  function clientIp(req: IncomingMessage): string {
    const forwarded = opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return forwarded || req.socket.remoteAddress || "unknown";
  }

  function limit(key: string, count: number, windowMs: number): void {
    if (!limiter.allow(key, count, windowMs, ms())) throw new RelayError(429, "操作太频繁，过一会儿再试");
  }

  function sessionCookie(token: string, maxAgeSeconds: number): string {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
  }

  // A signature is accepted once, so a captured request cannot be sent again.
  function firstUse(signature: string): boolean {
    const t = ms();
    if (seenSignatures.size > 10_000) {
      for (const [key, expires] of seenSignatures) if (expires < t) seenSignatures.delete(key);
    }
    if (seenSignatures.has(signature)) return false;
    seenSignatures.set(signature, t + 2 * SIGNATURE_WINDOW_MS);
    return true;
  }

  function verifySigned(req: IncomingMessage, url: URL, raw: Buffer, publicKey: string): void {
    const signature = req.headers["x-achat-signature"] as string | undefined;
    const problem = checkSignature(
      publicKey,
      { time: req.headers["x-achat-time"] as string | undefined, signature },
      req.method ?? "GET",
      url.pathname + url.search,
      raw.toString("utf8"),
      ms(),
    );
    if (problem) throw new RelayError(401, problem);
    if (!firstUse(signature!)) throw new RelayError(401, "这个请求已经用过了");
  }

  // The AI an "Authorization: Bearer" credential belongs to.
  function bearerAgent(req: IncomingMessage): AgentRecord | null | undefined {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
    return accounts.agentByToken(header.slice(7).trim());
  }

  async function authenticate(req: IncomingMessage, url: URL, raw: Buffer): Promise<Principal | null> {
    const bearer = bearerAgent(req);
    if (bearer === null) throw new RelayError(401, "这个 AI 的连接凭证无效或已作废。到 Achat 网页的“我”里重新连接");
    if (bearer) return { kind: "agent", account: accounts.account(bearer.accountId)!, agent: bearer };
    const deviceId = req.headers["x-achat-device"];
    if (typeof deviceId === "string") {
      const device = accounts.device(deviceId);
      if (!device || device.revokedAt) {
        throw new RelayError(401, "这台电脑不在任何 Achat 账号下，运行 achat link 重新添加");
      }
      verifySigned(req, url, raw, device.publicKey);
      if (!device.lastSeenAt || ms() - Date.parse(device.lastSeenAt) > MINUTE) accounts.touchDevice(device.id);
      const account = accounts.account(device.accountId)!;
      return { kind: "device", account, device };
    }
    const token = cookies(req).get(COOKIE);
    const account = token ? accounts.sessionAccount(token) : null;
    if (!account || !token) return null;
    // Cookie requests that change something must carry a header that a page
    // on another site cannot add without a CORS preflight, which is never granted.
    if (req.method !== "GET" && req.headers["x-achat-web"] !== "1") throw new RelayError(403, "缺少 x-achat-web 请求头");
    return { kind: "web", account, token };
  }

  function contactsOf(accountId: string): { id: string; name: string; agents: AgentConfig[] }[] {
    return accounts.contacts(accountId).map((c) => ({
      id: c.id,
      name: accounts.displayName(c),
      email: c.email,
      agents: accounts.activeAgents(c.id).map((a) => accounts.agentConfig(a, accountId)),
    }));
  }

  function viewerFor(p: Principal): Viewer {
    const accountId = p.account.id;
    return {
      visible: accounts.agentIds(accountId),
      sees: (agent) => accounts.agent(agent)?.accountId === accountId,
      actsAs: (agent) => {
        if (p.kind === "agent") return agent === p.agent.id;
        if (p.kind !== "device") return false;
        const a = accounts.agent(agent);
        return !!a && a.active && a.deviceId === p.device.id;
      },
      // A credential pasted into another app cannot approve; the person does,
      // on the web or in a dialog on their computer.
      approves: p.kind !== "agent",
      agents: () => [
        ...accounts.activeAgents(accountId).map((a) => accounts.agentConfig(a, accountId)),
        ...contactsOf(accountId).flatMap((c) => c.agents),
      ],
      reach: (_from, to) => {
        const target = accounts.agent(to);
        if (!target || !target.active) throw new RelayError(404, "找不到这个 AI，可能对方已经移除了它");
        if (!target.canReceive) {
          throw new RelayError(409, `${accounts.agentConfig(target, accountId).name}还不能接收请求，只有 Claude Code 和 Codex 能在后台回答`);
        }
        if (target.accountId === accountId) return true;
        if (!accounts.isContact(accountId, target.accountId)) {
          throw new RelayError(403, "你们还不是朋友。先用 create_invite 加对方为朋友");
        }
        return false;
      },
    };
  }

  function requireWeb(p: Principal | null): Extract<Principal, { kind: "web" }> {
    if (!p) throw new RelayError(401, "请先登录");
    if (p.kind !== "web") throw new RelayError(403, "这一步要在网页上由人来操作");
    return p;
  }

  function requireAny(p: Principal | null): Principal {
    if (!p) throw new RelayError(401, "请先登录");
    return p;
  }

  async function sendCode(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const email = normalizeEmail(str(body, "email"));
    limit(`code-ip:${clientIp(req)}`, 20, HOUR);
    const last = accounts.loginCode(email);
    if (last && ms() - last.sentAt < CODE_RESEND_AFTER) throw new RelayError(429, "验证码刚发过，一分钟后再试");
    limit(`code-email:${email}`, 6, HOUR);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    accounts.saveLoginCode(email, hashSecret(`${email}:${code}`), ms() + CODE_TTL, ms());
    try {
      await opts.mailer.send(loginCodeEmail(email, code, publicUrl));
    } catch (err) {
      console.error("[achat cloud]", err);
      accounts.deleteLoginCode(email);
      throw new RelayError(502, "验证码邮件没有发出去，稍后再试");
    }
    send(res, 200, { sent: true });
  }

  function verifyCode(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
    const email = normalizeEmail(str(body, "email"));
    const code = str(body, "code").replace(/\s/g, "");
    limit(`verify-ip:${clientIp(req)}`, 30, HOUR);
    const saved = accounts.loginCode(email);
    if (!saved || saved.expiresAt < ms() || saved.attempts >= CODE_MAX_ATTEMPTS) {
      throw new RelayError(400, "验证码已失效，重新获取一个");
    }
    if (saved.codeHash !== hashSecret(`${email}:${code}`)) {
      accounts.countLoginAttempt(email);
      throw new RelayError(400, "验证码不对");
    }
    accounts.deleteLoginCode(email);
    const account = accounts.accountByEmail(email) ?? accounts.createAccount(email);
    const token = accounts.createSession(account.id, SESSION_TTL);
    send(res, 200, { account: publicAccount(account, true), needsName: !account.name }, {
      "set-cookie": sessionCookie(token, SESSION_TTL / 1000),
    });
  }

  function publicAccount(account: Account, withEmail: boolean): Record<string, string> {
    return {
      id: account.id,
      name: accounts.displayName(account),
      ...(withEmail ? { email: account.email } : {}),
    };
  }

  function createDeviceLink(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): void {
    limit(`link-ip:${clientIp(req)}`, 10, HOUR);
    const body = parseJson(raw);
    const publicKey = str(body, "publicKey");
    const name = str(body, "name").trim().slice(0, 60) || "电脑";
    const clients = Array.isArray(body.clients) ? body.clients.filter((c): c is AgentClient => CLIENTS.has(c)) : [];
    if (!clients.length) throw new RelayError(400, "这台电脑上没有可以登记的 AI");
    const deviceId = deviceIdFor(publicKey);
    if (req.headers["x-achat-device"] !== deviceId) throw new RelayError(400, "签名和公钥不一致");
    verifySigned(req, url, raw, publicKey);
    // A credential made on the web by the logged-in person stands in for the
    // confirmation page.
    const enroll = typeof body.enroll === "string" ? accounts.enrollToken(body.enroll) : undefined;
    if (enroll === null) throw new RelayError(400, "这条连接命令已经用过或过期了，回到 Achat 网页重新生成");
    const link = accounts.createDeviceLink({ deviceId, name, publicKey, clients, expiresAt: ms() + LINK_TTL });
    let account: string | undefined;
    if (enroll) {
      approveLink(enroll.accountId, link.id);
      accounts.useEnrollToken(enroll.id, deviceId);
      account = accounts.displayName(accounts.account(enroll.accountId)!);
    }
    send(res, 201, {
      id: link.id,
      url: `${publicUrl}/link/${link.id}`,
      code: pairingCode(deviceId),
      expiresAt: new Date(link.expiresAt).toISOString(),
      status: enroll ? "approved" : "pending",
      ...(account ? { account } : {}),
    });
  }

  function linkStatus(accountId: string, linkId: string): Record<string, unknown> {
    const link = accounts.deviceLink(linkId);
    if (!link) throw new RelayError(404, "找不到这个链接");
    const existing = accounts.device(link.deviceId);
    const status = link.approvedBy ? "approved" : link.expiresAt < ms() ? "expired" : "pending";
    return {
      name: link.name,
      code: pairingCode(link.deviceId),
      clients: link.clients,
      status,
      // Already on this account, e.g. added back after being removed.
      again: existing?.accountId === accountId,
      otherAccount: !!existing && existing.accountId !== accountId,
    };
  }

  // `name` renames the computer as it is added.
  function approveLink(accountId: string, linkId: string, name?: string): Record<string, unknown> {
    const link = accounts.deviceLink(linkId);
    if (!link) throw new RelayError(404, "找不到这个链接");
    if (link.approvedBy) throw new RelayError(409, "这台电脑已经添加过了");
    if (link.expiresAt < ms()) throw new RelayError(410, "链接已经过期，在电脑上重新运行 achat link");
    const existing = accounts.device(link.deviceId);
    if (existing && existing.accountId !== accountId) {
      throw new RelayError(409, "这台电脑的钥匙登记在另一个账号下。先在那台电脑上运行 achat unlink，再重新添加");
    }
    const device = accounts.approveDeviceLink({ ...link, name: name?.trim().slice(0, 60) || link.name }, accountId);
    return { device: { id: device.id, name: device.name } };
  }

  // Gives the person what to paste into the AI they picked: for Claude Code and
  // Codex a sentence with a one-time install command, for the others an
  // address and a credential.
  function connect(account: Account, body: Record<string, unknown>): Record<string, unknown> {
    const client = str(body, "client");
    if (CLIENTS.has(client as AgentClient)) {
      limit(`connect:${account.id}`, 30, HOUR);
      const { id, token, expiresAt } = accounts.createEnrollToken(account.id, LINK_TTL);
      const command = `curl -fsSL ${publicUrl}/install.sh | bash -s -- ${token}`;
      return {
        id,
        kind: "install",
        client,
        command,
        sentence: `帮我连上 Achat：运行 ${command}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    }
    if (!REMOTE_CLIENTS.has(client as RemoteClient)) throw new RelayError(400, "不认识的 AI");
    const label = client === "other" ? (typeof body.label === "string" ? body.label.trim().slice(0, 20) : "") || null : null;
    const { agent, token } = accounts.connectRemoteAgent(account.id, client as RemoteClient, label);
    return {
      id: agent.id,
      kind: "mcp",
      client,
      name: accounts.agentConfig(agent, account.id).name,
      url: `${publicUrl}/mcp`,
      token,
      header: `Authorization: Bearer ${token}`,
    };
  }

  function connectStatus(accountId: string, id: string): Record<string, unknown> {
    if (id.startsWith("e_")) {
      const enroll = accounts.enrollStatus(id, accountId);
      if (!enroll) throw new RelayError(404, "找不到这次连接");
      if (enroll.deviceId) {
        const device = accounts.device(enroll.deviceId);
        const ais = accounts
          .activeAgents(accountId)
          .filter((a) => a.deviceId === enroll.deviceId)
          .map((a) => CLIENT_LABEL[a.client]);
        return { status: "connected", device: device?.name ?? "", ais };
      }
      return { status: enroll.expiresAt < ms() ? "expired" : "waiting" };
    }
    const agent = accounts.agent(id);
    if (!agent || agent.accountId !== accountId || !agent.active) throw new RelayError(404, "找不到这次连接");
    return { status: agent.lastUsedAt ? "connected" : "waiting", name: accounts.agentConfig(agent, accountId).name };
  }

  // What the 我 page and the first-use checklist show.
  function myself(account: Account): Record<string, unknown> {
    const ais = accounts.activeAgents(account.id);
    const devices = accounts.devices(account.id);
    const threads = service.listThreads({ agents: accounts.agentIds(account.id) });
    return {
      account: publicAccount(account, true),
      needsName: !account.name,
      emailNotify: account.emailNotify,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        ais: ais.filter((a) => a.deviceId === d.id).map((a) => CLIENT_LABEL[a.client]),
      })),
      remoteAis: ais
        .filter((a) => !a.deviceId)
        .map((a) => ({ id: a.id, name: accounts.agentConfig(a, account.id).name, client: a.client, lastUsedAt: a.lastUsedAt })),
      // Friend requests waiting for this person; the badge on 通讯录.
      newFriends: newFriends(account).filter((f) => f.direction === "in" && f.status === "pending").length,
      checklist: {
        connected: ais.length > 0,
        invited: accounts.contacts(account.id).length > 0,
        collaborated: threads.some((t) => t.roundsUsed > 0),
      },
    };
  }

  function invitePreview(code: string): Record<string, unknown> {
    const invite = accounts.invite(code);
    if (!invite) throw new RelayError(404, "找不到这个邀请");
    const from = accounts.account(invite.accountId)!;
    const status = invite.usedBy ? "used" : invite.expiresAt < ms() ? "expired" : "valid";
    return { from: { id: from.id, name: accounts.displayName(from) }, status };
  }

  function inviteStatus(invite: Invite): "pending" | "accepted" | "expired" {
    return invite.usedBy ? "accepted" : invite.expiresAt < ms() ? "expired" : "pending";
  }

  // 新的朋友: requests to this person and the invites they sent, newest
  // first, with requests still waiting on them at the top. Unused links are
  // left out; they turn up here once someone accepts.
  function newFriends(account: Account): Record<string, unknown>[] {
    const seen = new Set<string>();
    const incoming = accounts
      .invitesTo(account.id, account.email)
      .filter((i) => i.accountId !== account.id)
      .flatMap((i) => {
        const status = inviteStatus(i);
        if (status === "expired" || seen.has(i.accountId)) return [];
        if (status === "accepted" && i.usedBy !== account.id) return [];
        if (status === "pending" && accounts.isContact(account.id, i.accountId)) return [];
        seen.add(i.accountId);
        const from = accounts.account(i.accountId)!;
        return [{ id: i.id, direction: "in", name: accounts.displayName(from), email: from.email, status, at: i.createdAt }];
      });
    const outgoing = accounts.invitesFrom(account.id).map((i) => {
      const status = inviteStatus(i);
      const friend = i.usedBy ? accounts.account(i.usedBy) : null;
      return {
        id: i.id,
        direction: "out",
        name: friend ? accounts.displayName(friend) : i.email!,
        email: friend?.email ?? i.email,
        status,
        at: i.createdAt,
      };
    });
    const waiting = (f: { direction: string; status: string }) => f.direction === "in" && f.status === "pending";
    return [...incoming, ...outgoing].sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || b.at.localeCompare(a.at));
  }

  // Invites someone by email. A person already on Achat sees it under 新的朋友;
  // someone new gets an email asking them to join. Each email is invited at
  // most once a day; sending again renews the same invite.
  async function inviteByEmail(account: Account, value: string): Promise<Record<string, unknown>> {
    const email = normalizeEmail(value);
    if (email === account.email) throw new RelayError(400, "不能添加自己");
    const target = accounts.accountByEmail(email);
    if (target && accounts.isContact(account.id, target.id)) {
      throw new RelayError(409, `${accounts.displayName(target)}已经是你的朋友了`);
    }
    // They asked first: accepting their request beats asking back.
    const theirs = target && accounts.openInvite(target.id, account.email);
    if (theirs && theirs.expiresAt > ms()) {
      return { status: "accepted", contact: await accept(theirs, account) };
    }
    const open = accounts.openInvite(account.id, email);
    if (open?.emailedAt && ms() - open.emailedAt < DAY) throw new RelayError(429, `今天已经邀请过 ${email} 了`);
    limit(`invite:${account.id}`, 20, DAY);
    const { invite, code } = open ? accounts.renewInvite(open.id, INVITE_TTL) : accounts.createInvite(account.id, INVITE_TTL, email);
    if (!target || target.emailNotify) {
      try {
        await opts.mailer.send(
          inviteEmail(email, { fromName: accounts.displayName(account), link: `${publicUrl}/invite/${code}`, joined: !!target }),
        );
      } catch (err) {
        console.error("[achat cloud]", err);
        if (!open) accounts.deleteInvite(invite.id);
        throw new RelayError(502, "邀请邮件没有发出去，稍后再试");
      }
    }
    accounts.markInviteEmailed(invite.id);
    return { status: "pending", id: invite.id, email, joined: !!target };
  }

  // Accepts an invite by its link code, or by id from 新的朋友, which only
  // works for the email it was sent to.
  async function acceptInvite(account: Account, key: string): Promise<Record<string, unknown>> {
    const byId = accounts.inviteById(key);
    const invite = byId && byId.email === account.email ? byId : accounts.invite(key);
    if (!invite) throw new RelayError(404, "找不到这个邀请");
    if (invite.accountId === account.id) throw new RelayError(400, "这是你自己发出的邀请");
    if (invite.usedBy) throw new RelayError(409, "这个邀请已经被用过了，请对方重新发一个");
    if (invite.expiresAt < ms()) throw new RelayError(410, "这个邀请已经过期，请对方重新发一个");
    return { contact: await accept(invite, account) };
  }

  async function accept(invite: Invite, account: Account): Promise<{ id: string; name: string }> {
    accounts.acceptInvite(invite, account);
    const inviter = accounts.account(invite.accountId)!;
    if (inviter.emailNotify) {
      opts.mailer
        .send(acceptedEmail(inviter.email, { name: accounts.displayName(account), link: `${publicUrl}/#/contacts/${account.id}` }))
        .catch((err) => console.error("[achat cloud] 接受邀请的邮件没有发出去", err));
    }
    return { id: inviter.id, name: accounts.displayName(inviter) };
  }

  // An invite this account sent by email and nobody has used yet.
  function ownOpenInvite(account: Account, id: string): Invite & { email: string } {
    const invite = accounts.inviteById(id);
    if (!invite || invite.accountId !== account.id || !invite.email) throw new RelayError(404, "找不到这个邀请");
    if (invite.usedBy) throw new RelayError(409, "对方已经接受了");
    return invite as Invite & { email: string };
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const raw = await readBody(req);
    const shape = parts.map((part, i) => (i === 1 && WITH_ID.has(parts[0]) ? ":id" : part));
    const route = `${method} /${shape.join("/")}`;

    // Routes that work without logging in.
    switch (route) {
      case "GET /health":
        return send(res, 200, { pid: process.pid, startedAt, mode: "cloud" });
      case "POST /auth/code":
        return sendCode(req, res, parseJson(raw));
      case "POST /auth/verify":
        return verifyCode(req, res, parseJson(raw));
      case "POST /device-links":
        return createDeviceLink(req, res, url, raw);
      case "GET /invites/:id":
        return send(res, 200, invitePreview(parts[1]));
    }

    const p = await authenticate(req, url, raw);
    switch (route) {
      case "POST /auth/logout": {
        const web = requireWeb(p);
        accounts.deleteSession(web.token);
        return send(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
      }
      case "GET /me": {
        const me = requireAny(p);
        if (me.kind === "device") {
          return send(res, 200, {
            account: publicAccount(me.account, false),
            device: { id: me.device.id, name: me.device.name },
          });
        }
        if (me.kind === "agent") {
          return send(res, 200, {
            account: publicAccount(me.account, false),
            agent: accounts.agentConfig(me.agent, me.account.id),
          });
        }
        return send(res, 200, myself(me.account));
      }
      case "POST /me": {
        const web = requireWeb(p);
        const body = parseJson(raw);
        if (typeof body.emailNotify === "boolean") accounts.setEmailNotify(web.account.id, body.emailNotify);
        if (body.name !== undefined) {
          const name = str(body, "name").trim();
          if (!name || name.length > 20) throw new RelayError(400, "名字需要在 1 到 20 个字之间");
          accounts.rename(web.account.id, name);
        }
        return send(res, 200, myself(accounts.account(web.account.id)!));
      }
      case "POST /connect":
        return send(res, 201, connect(requireWeb(p).account, parseJson(raw)));
      case "GET /connect/:id":
        return send(res, 200, connectStatus(requireWeb(p).account.id, parts[1]));
      case "DELETE /agents/:id": {
        const web = requireWeb(p);
        const agent = accounts.agent(parts[1]);
        if (!agent || agent.accountId !== web.account.id) throw new RelayError(404, "找不到这个 AI");
        if (agent.deviceId) throw new RelayError(400, "这个 AI 跟着电脑走，移除那台电脑即可");
        accounts.revokeAgent(agent.id);
        return send(res, 200, { ok: true });
      }
      case "GET /device-links/:id":
        return send(res, 200, linkStatus(requireWeb(p).account.id, parts[1]));
      case "POST /device-links/:id/approve": {
        const body = parseJson(raw);
        const name = typeof body.name === "string" ? body.name : undefined;
        return send(res, 200, approveLink(requireWeb(p).account.id, parts[1], name));
      }
      case "DELETE /devices/:id": {
        const me = requireAny(p);
        const device = accounts.device(parts[1]);
        const allowed =
          me.kind === "web" ? device?.accountId === me.account.id : me.kind === "device" && device?.id === me.device.id;
        if (!device || !allowed) throw new RelayError(404, "找不到这台电脑");
        accounts.revokeDevice(device.id);
        return send(res, 200, { ok: true });
      }
      case "GET /invites":
        return send(res, 200, newFriends(requireAny(p).account));
      case "POST /invites": {
        const me = requireAny(p);
        const body = parseJson(raw);
        if (body.email !== undefined) return send(res, 201, await inviteByEmail(me.account, str(body, "email")));
        limit(`invite:${me.account.id}`, 20, DAY);
        const { invite, code } = accounts.createInvite(me.account.id, INVITE_TTL);
        return send(res, 201, { url: `${publicUrl}/invite/${code}`, expiresAt: new Date(invite.expiresAt).toISOString() });
      }
      case "POST /invites/:id/accept":
        return send(res, 200, await acceptInvite(requireWeb(p).account, parts[1]));
      case "POST /invites/:id/resend": {
        const web = requireWeb(p);
        return send(res, 200, await inviteByEmail(web.account, ownOpenInvite(web.account, parts[1]).email));
      }
      case "DELETE /invites/:id": {
        const web = requireWeb(p);
        accounts.deleteInvite(ownOpenInvite(web.account, parts[1]).id);
        return send(res, 200, { ok: true });
      }
      case "GET /contacts":
        return send(res, 200, contactsOf(requireAny(p).account.id));
      case "DELETE /contacts/:id": {
        const web = requireWeb(p);
        accounts.removeContact(web.account.id, parts[1]);
        return send(res, 200, { ok: true });
      }
    }

    if (await threadsApi(req, res, url, service, viewerFor(requireAny(p)))) return;
    throw new RelayError(404, "没有这个接口");
  }

  const appDir = opts.appDir ?? dirname(opts.webDir);

  async function sendInstallScript(res: ServerResponse): Promise<void> {
    const script = await readFile(join(appDir, "deploy", "client-install.sh"), "utf8");
    res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" });
    res.end(script.replaceAll("__ACHAT_URL__", publicUrl));
  }

  // The built app without node_modules; the installer runs npm ci there.
  function sendApp(res: ServerResponse): void {
    const tar = spawn("tar", ["-czf", "-", "-C", appDir, "package.json", "package-lock.json", "dist", "web"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failed = "";
    tar.stderr.on("data", (d) => (failed += d));
    res.writeHead(200, { "content-type": "application/gzip", "cache-control": "no-store" });
    tar.stdout.pipe(res);
    tar.on("close", (code) => {
      if (code !== 0) {
        console.error("[achat cloud] 打包失败", failed.trim());
        res.destroy();
      }
    });
  }

  // Emails the receiver when someone else's AI asks one of theirs, at most a
  // few times a day per sender, unless they turned it off.
  async function emailRequest(threadId: string): Promise<void> {
    const thread = service.getThread(threadId);
    const to = accounts.agent(thread.to);
    const from = accounts.agent(thread.from);
    if (!to || !from || to.accountId === from.accountId) return;
    const receiver = accounts.account(to.accountId)!;
    if (!receiver.emailNotify) return;
    if (accounts.countRequestEmails(receiver.id, from.accountId, ms() - DAY) >= REQUEST_EMAILS_PER_DAY) return;
    accounts.logRequestEmail(receiver.id, from.accountId);
    const question = thread.messages.find((m) => m.kind === "request")?.body ?? "";
    await opts.mailer.send(
      requestEmail(receiver.email, {
        fromName: accounts.agentConfig(from, receiver.id).name,
        toName: accounts.agentConfig(to, receiver.id).name.replace(/^我的/, "你的"),
        topic: thread.topic,
        question,
        link: `${publicUrl}/#/t/${thread.id}`,
        settingsLink: `${publicUrl}/#/me`,
      }),
    );
  }

  service.onEvent((e) => {
    if (e.type !== "thread.created" || e.status !== "pending" || e.quiet) return;
    emailRequest(e.threadId).catch((err) => console.error("[achat cloud] 提醒邮件没有发出去", err));
  });

  let selfUrl = "";

  function mcpServerFor(agent: AgentRecord, token: string) {
    return createMcpServer({
      connection: () => ({
        client: new RelayClient(selfUrl, { bearer: token }),
        agentId: agent.id,
        webUrl: publicUrl,
        mode: "cloud",
      }),
      review: false,
      waitSeconds: REMOTE_WAIT_SECONDS,
    });
  }

  // Event streams of AIs on the older HTTP+SSE transport, by session.
  const sseSessions = new Map<string, { transport: SSEServerTransport; agentId: string }>();

  // The MCP endpoint for AIs that connect by address. Each call is handled on
  // its own (no MCP session); the tools act through this service's own API
  // with the caller's credential, so every rule above applies to them too.
  // Apps whose "HTTP" means the older HTTP+SSE transport open an event stream
  // with GET at the same address and post to /mcp/messages; that works too.
  async function mcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const agent = bearerAgent(req);
    if (!agent) {
      return send(res, 401, { error: "缺少或无效的 Achat 连接凭证" }, { "www-authenticate": "Bearer" });
    }
    const token = String(req.headers.authorization).slice(7).trim();
    if (url.pathname === "/mcp/messages") {
      const session = sseSessions.get(url.searchParams.get("sessionId") ?? "");
      if (!session || session.agentId !== agent.id) return send(res, 404, { error: "连接已断开，请重新连接" });
      return await session.transport.handlePostMessage(req, res, parseJson(await readBody(req)));
    }
    // Clients of the current transport only GET after initializing, and then
    // send their protocol version; this service has no stream for them.
    if (req.method === "GET" && !req.headers["mcp-protocol-version"]) {
      const transport = new SSEServerTransport("/mcp/messages", res);
      const server = mcpServerFor(agent, token);
      sseSessions.set(transport.sessionId, { transport, agentId: agent.id });
      // Comments keep proxies from closing a quiet stream.
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      res.on("close", () => {
        clearInterval(ping);
        sseSessions.delete(transport.sessionId);
        void server.close();
      });
      return await server.connect(transport);
    }
    if (req.method !== "POST") {
      return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
    const body = parseJson(await readBody(req));
    const server = mcpServerFor(agent, token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", publicUrl);
      if (url.pathname === "/mcp" || url.pathname === "/mcp/messages") return await mcp(req, res, url);
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      if (url.pathname === "/install.sh") return await sendInstallScript(res);
      if (url.pathname === "/download/achat.tgz") return sendApp(res);
      // Pages of the single-page app; the empty token tells it to use the login cookie.
      const page = /^\/(link|invite)\/[^/]+$/.test(url.pathname) ? "/" : url.pathname;
      return await serveStatic(res, opts.webDir, page, (html) => html.replace("__ACHAT_TOKEN__", ""));
    } catch (err) {
      if (err instanceof RelayError) return send(res, err.status, { error: err.message });
      console.error("[achat cloud]", err);
      if (!res.headersSent) send(res, 500, { error: "服务内部错误" });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 8080, opts.host ?? "127.0.0.1", () => resolve());
    });
  } catch (err) {
    store.close();
    throw err;
  }
  const port = (server.address() as AddressInfo).port;
  const host = opts.host ?? "127.0.0.1";
  selfUrl = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    service,
    accounts,
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
