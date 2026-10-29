import type { AgentClient, AgentConfig } from "./config.js";
import { signRequest, type DeviceKey } from "./device.js";
import type { RelayEvent, Scope, ThreadDetail, ThreadStatus, ThreadSummary } from "./types.js";

export class RelayClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Contact {
  id: string;
  name: string;
  agents: AgentConfig[];
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
  ) {}

  private headers(method: string, path: string, body: string): Record<string, string> {
    if (typeof this.auth === "string") return { "x-achat-token": this.auth };
    if ("bearer" in this.auth) return { authorization: `Bearer ${this.auth.bearer}` };
    const url = new URL(this.baseUrl + path);
    return signRequest(this.auth, method, url.pathname + url.search, body);
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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

  createInvite(): Promise<{ url: string; expiresAt: string }> {
    return this.call("POST", "/api/invites", {});
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

  listThreads(filter: { agent?: string; to?: string; status?: ThreadStatus; surfaced?: boolean } = {}): Promise<ThreadSummary[]> {
    const q = new URLSearchParams();
    if (filter.agent) q.set("agent", filter.agent);
    if (filter.to) q.set("to", filter.to);
    if (filter.status) q.set("status", filter.status);
    if (filter.surfaced) q.set("surfaced", "1");
    return this.call("GET", `/api/threads?${q}`);
  }

  getThread(id: string): Promise<ThreadDetail> {
    return this.call("GET", `/api/threads/${encodeURIComponent(id)}`);
  }

  createRequest(input: { from: string; to: string; topic: string; message: string }): Promise<ThreadDetail> {
    return this.call("POST", "/api/threads", input);
  }

  approve(id: string, scope: Partial<Scope> = {}): Promise<ThreadDetail> {
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

  fail(id: string, reason: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/fail`, { reason });
  }

  end(id: string, note: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/end`, { note });
  }

  postMessage(
    id: string,
    input: { from: string; body: string; costUsd?: number; redactions?: number; sessionId?: string },
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
