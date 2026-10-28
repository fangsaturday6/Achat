import type { AgentConfig } from "./config.js";
import type { RelayEvent, Scope, ThreadDetail, ThreadStatus, ThreadSummary } from "./types.js";

export class RelayClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Thin HTTP client for the relay API, used by the sidecar, the MCP server and
// the hook command.
export class RelayClient {
  constructor(
    readonly baseUrl: string,
    private token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { "x-achat-token": this.token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new RelayClientError(res.status, data?.error ?? `HTTP ${res.status}`);
    return data as T;
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
    const q = new URLSearchParams({ token: this.token });
    if (agent) q.set("agent", agent);
    const url = `${this.baseUrl}/api/events?${q}`;

    const loop = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(url, { signal: controller.signal });
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
