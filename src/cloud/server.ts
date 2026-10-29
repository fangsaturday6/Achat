import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { AgentClient, AgentConfig } from "../config.js";
import { checkSignature, deviceIdFor, pairingCode, SIGNATURE_WINDOW_MS } from "../device.js";
import { parseJson, readBody, send, serveStatic, str } from "../relay/http.js";
import { RelayError, RelayService, type RelaySettings } from "../relay/service.js";
import { Store } from "../relay/store.js";
import { threadsApi, type Viewer } from "../relay/threads-api.js";
import { AccountStore, hashSecret, type Account, type Device } from "./accounts.js";
import { loginCodeEmail } from "./emails.js";
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
const WITH_ID = new Set(["device-links", "invites", "devices", "contacts"]);

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

type Principal = { kind: "web"; account: Account; token: string } | { kind: "device"; account: Account; device: Device };

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

  async function authenticate(req: IncomingMessage, url: URL, raw: Buffer): Promise<Principal | null> {
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
      agents: accounts.activeAgents(c.id).map((a) => accounts.agentConfig(a, accountId)),
    }));
  }

  function viewerFor(p: Principal): Viewer {
    const accountId = p.account.id;
    return {
      visible: accounts.agentIds(accountId),
      sees: (agent) => accounts.agent(agent)?.accountId === accountId,
      actsAs: (agent) => {
        if (p.kind !== "device") return false;
        const a = accounts.agent(agent);
        return !!a && a.active && a.deviceId === p.device.id;
      },
      approves: true,
      agents: () => [
        ...accounts.activeAgents(accountId).map((a) => accounts.agentConfig(a, accountId)),
        ...contactsOf(accountId).flatMap((c) => c.agents),
      ],
      reach: (_from, to) => {
        const target = accounts.agent(to);
        if (!target || !target.active) throw new RelayError(404, "找不到这个 AI，可能对方已经移除了那台电脑");
        if (target.accountId === accountId) return true;
        if (!accounts.isContact(accountId, target.accountId)) {
          throw new RelayError(403, "你们还不是联系人。先发一个邀请链接给对方");
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
    const link = accounts.createDeviceLink({ deviceId, name, publicKey, clients, expiresAt: ms() + LINK_TTL });
    send(res, 201, {
      id: link.id,
      url: `${publicUrl}/link/${link.id}`,
      code: pairingCode(deviceId),
      expiresAt: new Date(link.expiresAt).toISOString(),
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

  function approveLink(accountId: string, linkId: string): Record<string, unknown> {
    const link = accounts.deviceLink(linkId);
    if (!link) throw new RelayError(404, "找不到这个链接");
    if (link.approvedBy) throw new RelayError(409, "这台电脑已经添加过了");
    if (link.expiresAt < ms()) throw new RelayError(410, "链接已经过期，在电脑上重新运行 achat link");
    const existing = accounts.device(link.deviceId);
    if (existing && existing.accountId !== accountId) {
      throw new RelayError(409, "这台电脑的钥匙登记在另一个账号下。先在那台电脑上运行 achat unlink，再重新添加");
    }
    const device = accounts.approveDeviceLink(link, accountId);
    return { device: { id: device.id, name: device.name } };
  }

  function invitePreview(code: string): Record<string, unknown> {
    const invite = accounts.invite(code);
    if (!invite) throw new RelayError(404, "找不到这个邀请");
    const from = accounts.account(invite.accountId)!;
    const status = invite.usedBy ? "used" : invite.expiresAt < ms() ? "expired" : "valid";
    return { from: { id: from.id, name: accounts.displayName(from) }, status };
  }

  function acceptInvite(accountId: string, code: string): Record<string, unknown> {
    const invite = accounts.invite(code);
    if (!invite) throw new RelayError(404, "找不到这个邀请");
    if (invite.usedBy) throw new RelayError(409, "这个邀请已经被用过了，请对方重新发一个");
    if (invite.expiresAt < ms()) throw new RelayError(410, "这个邀请已经过期，请对方重新发一个");
    if (invite.accountId === accountId) throw new RelayError(400, "这是你自己发出的邀请");
    accounts.acceptInvite(code, accountId, invite.accountId);
    const from = accounts.account(invite.accountId)!;
    return { contact: { id: from.id, name: accounts.displayName(from) } };
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
        return send(res, 200, {
          account: publicAccount(me.account, true),
          needsName: !me.account.name,
          devices: accounts.devices(me.account.id).map((d) => ({
            id: d.id,
            name: d.name,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt,
          })),
        });
      }
      case "POST /me": {
        const web = requireWeb(p);
        const name = str(parseJson(raw), "name").trim();
        if (!name || name.length > 20) throw new RelayError(400, "名字需要在 1 到 20 个字之间");
        return send(res, 200, { account: publicAccount(accounts.rename(web.account.id, name), true) });
      }
      case "GET /device-links/:id":
        return send(res, 200, linkStatus(requireWeb(p).account.id, parts[1]));
      case "POST /device-links/:id/approve":
        return send(res, 200, approveLink(requireWeb(p).account.id, parts[1]));
      case "DELETE /devices/:id": {
        const me = requireAny(p);
        const device = accounts.device(parts[1]);
        const allowed = me.kind === "web" ? device?.accountId === me.account.id : device?.id === me.device.id;
        if (!device || !allowed) throw new RelayError(404, "找不到这台电脑");
        accounts.revokeDevice(device.id);
        return send(res, 200, { ok: true });
      }
      case "POST /invites": {
        const me = requireAny(p);
        limit(`invite:${me.account.id}`, 20, DAY);
        const { code, expiresAt } = accounts.createInvite(me.account.id, INVITE_TTL);
        return send(res, 201, { url: `${publicUrl}/invite/${code}`, expiresAt: new Date(expiresAt).toISOString() });
      }
      case "POST /invites/:id/accept":
        return send(res, 200, acceptInvite(requireWeb(p).account.id, parts[1]));
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

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", publicUrl);
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
