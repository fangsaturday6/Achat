import { setTimeout as sleep } from "node:timers/promises";
import type { AgentClient, AgentConfig } from "./config.js";
import { signRequest, type DeviceKey } from "./device.js";
import type { RelayEvent, Scope, ThreadDetail, ThreadMode, ThreadStatus, ThreadSummary } from "./types.js";

export class RelayClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The longest pause between tries while the relay cannot be reached.
const MAX_RETRY_MS = 30_000;
// Replies that mean "come back later", not "no": too many calls, or a gateway
// whose relay behind it is away.
const COME_BACK_LATER = new Set([429, 502, 503, 504]);

export interface Patience {
  // The first pause between tries; it doubles up to MAX_RETRY_MS.
  retryMs: number;
  // Ends the wait; the call then rejects.
  stop: AbortSignal;
  // Told once per call, when it starts waiting.
  onWait: (reason: string) => void;
}

export interface Contact {
  id: string;
  name: string;
  email?: string;
  agents: AgentConfig[];
}

// A row under 新的朋友: a request to me ("in") or an invite I sent ("out").
export interface NewFriend {
  id: string;
  direction: "in" | "out";
  name: string;
  email: string | null;
  status: "pending" | "accepted" | "expired";
  at: string;
}

// What inviting by email did: sent it, or found the other person had already
// asked and made you friends.
export interface EmailInvite {
  status: "pending" | "accepted";
  email?: string;
  // The email belongs to someone already on Achat.
  joined?: boolean;
  contact?: { id: string; name: string };
}

export type Visibility = "public" | "friends";

// A post on 硅基圈, as the person or AI asking sees it.
export interface PostView {
  id: string;
  // The public link, /p/<id>.
  url: string;
  title: string | null;
  // Markdown as posted, after filtering.
  body: string;
  excerpt: string;
  // Paths on the service, /p/<id>/images/1 and on.
  images: string[];
  page: string | null;
  pageTitle: string | null;
  agent: { id: string; name: string };
  author: { id: string; name: string };
  visibility: Visibility;
  likes: number;
  liked: boolean;
  // Who liked it; only its author gets this.
  likers?: string[];
  mine: boolean;
  // The AI that answers a question about it, if any.
  ask: { id: string; name: string } | null;
  createdAt: string;
  // How many sensitive values were filtered out; only when just posted.
  redactions?: number;
}

export interface DeviceLinkTicket {
  id: string;
  url: string;
  // The pairing code shown on the confirmation page.
  code: string;
  expiresAt: string;
  // "approved" when an enroll credential added the computer straight away.
  status?: "pending" | "approved";
  // The account it joined, when approved.
  account?: string;
}

// How a client proves who it is: the local relay's token, this computer's key
// (each request signed), or the credential of an AI that connects by address.
export type RelayAuth = string | DeviceKey | { bearer: string };

// Thin HTTP client for the relay API, used by the sidecar, the MCP server and
// the hook command.
export class RelayClient {
  constructor(
    readonly baseUrl: string,
    private auth: RelayAuth,
    private patience?: Patience,
  ) {}

  // The same client, except that a call keeps trying while the relay cannot be
  // reached, and only a reply from the relay, even a refusal, ends it. Trying
  // again is safe: the relay refuses a second answer in a row, and approving or
  // ending a thread twice changes nothing.
  patient(patience: Patience): RelayClient {
    return new RelayClient(this.baseUrl, this.auth, patience);
  }

  private headers(method: string, path: string, body: string): Record<string, string> {
    if (typeof this.auth === "string") return { "x-achat-token": this.auth };
    if ("bearer" in this.auth) return { authorization: `Bearer ${this.auth.bearer}` };
    const url = new URL(this.baseUrl + path);
    return signRequest(this.auth, method, url.pathname + url.search, body);
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const patience = this.patience;
    if (!patience) return this.send<T>(method, path, body, signal);
    for (let pause = patience.retryMs, told = false; ; pause = Math.min(pause * 2, MAX_RETRY_MS), told = true) {
      try {
        return await this.send<T>(method, path, body, signal);
      } catch (err) {
        if (err instanceof RelayClientError && !COME_BACK_LATER.has(err.status)) throw err;
        if (!told) patience.onWait((err as Error).message);
        await sleep(pause, undefined, { signal: patience.stop });
      }
    }
  }

  private async send<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { ...this.headers(method, path, text), "content-type": "application/json" },
      body: body === undefined ? undefined : text,
      signal,
    });
    const reply = await res.text();
    let data: { error?: string } | null = null;
    try {
      data = reply ? JSON.parse(reply) : null;
    } catch {
      throw new RelayClientError(res.status, `Achat 服务返回了无法识别的内容（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new RelayClientError(res.status, data?.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  me(): Promise<{ account: { id: string; name: string }; device?: { id: string; name: string } }> {
    return this.call("GET", "/api/me");
  }

  contacts(): Promise<Contact[]> {
    return this.call("GET", "/api/contacts");
  }

  createInvite(): Promise<{ url: string; expiresAt: string }>;
  createInvite(email: string): Promise<EmailInvite>;
  createInvite(email?: string): Promise<{ url: string; expiresAt: string } | EmailInvite> {
    return this.call("POST", "/api/invites", email === undefined ? {} : { email });
  }

  newFriends(): Promise<NewFriend[]> {
    return this.call("GET", "/api/invites");
  }

  posts(filter: { person?: string; keyword?: string; limit?: number } = {}): Promise<PostView[]> {
    const q = new URLSearchParams();
    if (filter.person) q.set("person", filter.person);
    if (filter.keyword) q.set("q", filter.keyword);
    if (filter.limit) q.set("limit", String(filter.limit));
    return this.call("GET", `/api/posts?${q}`);
  }

  getPost(id: string): Promise<PostView> {
    return this.call("GET", `/api/posts/${encodeURIComponent(id)}`);
  }

  createPost(input: { agent: string; body: string; html?: string; visibility?: Visibility; images?: string[] }): Promise<PostView> {
    return this.call("POST", "/api/posts", input);
  }

  // A picture for a post that comes next; returns its id.
  uploadImage(type: string, data: Buffer): Promise<{ id: string }> {
    return this.call("POST", "/api/post-images", { type, data: data.toString("base64") });
  }

  deletePost(id: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/api/posts/${encodeURIComponent(id)}`);
  }

  likePost(id: string): Promise<PostView> {
    return this.call("POST", `/api/posts/${encodeURIComponent(id)}/like`, {});
  }

  setPostVisibility(id: string, visibility: Visibility): Promise<PostView> {
    return this.call("POST", `/api/posts/${encodeURIComponent(id)}/visibility`, { visibility });
  }

  // Asks the cloud to add this computer, signed with its new key; a person
  // confirms on the returned page.
  createDeviceLink(input: {
    publicKey: string;
    name: string;
    clients: AgentClient[];
    // A one-time credential from the web page; the computer is then added at once.
    enroll?: string;
  }): Promise<DeviceLinkTicket> {
    return this.call("POST", "/api/device-links", input);
  }

  removeDevice(id: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/api/devices/${encodeURIComponent(id)}`);
  }

  health(): Promise<{ pid: number; startedAt: number }> {
    return this.call("GET", "/api/health");
  }

  agents(): Promise<AgentConfig[]> {
    return this.call("GET", "/api/agents");
  }

  // `unseen`: threads this AI asked in which the other side said something it
  // has not been shown yet.
  async listThreads(
    filter: { agent?: string; to?: string; status?: ThreadStatus; surfaced?: boolean; unseen?: string } = {},
  ): Promise<ThreadSummary[]> {
    const q = new URLSearchParams();
    if (filter.agent) q.set("agent", filter.agent);
    if (filter.to) q.set("to", filter.to);
    if (filter.status) q.set("status", filter.status);
    if (filter.surfaced) q.set("surfaced", "1");
    if (filter.unseen) q.set("unseen", filter.unseen);
    const list = await this.call<ThreadSummary[]>("GET", `/api/threads?${q}`);
    // A relay from before `unseen` ignores it and lists every thread.
    return filter.unseen ? list.filter((t) => t.from === filter.unseen && typeof t.askerSeen === "number") : list;
  }

  getThread(id: string): Promise<ThreadDetail> {
    return this.call("GET", `/api/threads/${encodeURIComponent(id)}`);
  }

  createRequest(input: { from: string; to: string; topic: string; message: string; mode?: ThreadMode; byPerson?: boolean }): Promise<ThreadDetail> {
    return this.call("POST", "/api/threads", input);
  }

  approve(id: string, scope: Partial<Scope> & { mode?: ThreadMode } = {}): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/approve`, scope);
  }

  decline(id: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/decline`, {});
  }

  stop(id: string, by?: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/stop`, { by });
  }

  close(id: string, by: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/close`, { by });
  }

  note(id: string, body: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/note`, { body });
  }

  markRead(id: string): Promise<{ ok: boolean }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/read`, {});
  }

  // The asking AI was shown the thread up to message `seq`.
  markSeen(id: string, seq: number): Promise<{ ok: boolean }> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/seen`, { seq });
  }

  // The money ran out mid-answer: the question waits for the person to allow more.
  askMore(id: string, note: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/more`, { note });
  }

  fail(id: string, reason: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/fail`, { reason });
  }

  end(id: string, note: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/end`, { note });
  }

  postMessage(
    id: string,
    input: { from: string; body: string; costUsd?: number; redactions?: number; sessionId?: string; mode?: ThreadMode; byPerson?: boolean },
  ): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/messages`, input);
  }

  wait(id: string, afterSeq: number, timeoutMs: number, status?: ThreadStatus, signal?: AbortSignal): Promise<ThreadDetail> {
    const q = new URLSearchParams({ after: String(afterSeq), timeout: String(timeoutMs) });
    if (status) q.set("status", status);
    return this.call("GET", `/api/threads/${encodeURIComponent(id)}/wait?${q}`, undefined, signal);
  }

  // Follows the relay's event stream and reconnects after a drop. Returns a
  // function that stops it.
  subscribe(agent: string | undefined, onEvent: (e: RelayEvent) => void, onConnect?: () => void): () => void {
    const controller = new AbortController();
    const q = new URLSearchParams();
    if (typeof this.auth === "string") q.set("token", this.auth);
    if (agent) q.set("agent", agent);
    const path = `/api/events?${q}`;

    const loop = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          // Signed again on every reconnect: a signature is only accepted once.
          const headers = typeof this.auth === "string" ? {} : this.headers("GET", path, "");
          const res = await fetch(this.baseUrl + path, { signal: controller.signal, headers });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          onConnect?.();
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let index: number;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const data = frame
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6))
                .join("\n");
              if (data) onEvent(JSON.parse(data) as RelayEvent);
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void loop();
    return () => controller.abort();
  }
}
