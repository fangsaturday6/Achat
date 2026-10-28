import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient, RelayClientError } from "../src/client.js";
import type { Mailer } from "../src/cloud/mailer.js";
import { startCloud, type RunningCloud } from "../src/cloud/server.js";
import { defaultConfig, type AchatConfig, type AgentClient } from "../src/config.js";
import { ensureDeviceKey, FileKeyStore, type DeviceKey } from "../src/device.js";
import { startRelay, type RunningRelay } from "../src/relay/server.js";
import type { AgentRunner, RunInput, RunOutput } from "../src/sidecar/runners.js";

export const CLAUDE = "claude@local";
export const CODEX = "codex@local";

export async function startTestRelay(overrides: Partial<AchatConfig> = {}): Promise<{
  relay: RunningRelay;
  client: RelayClient;
  config: AchatConfig;
}> {
  const dir = mkdtempSync(join(tmpdir(), "achat-test-"));
  const config = { ...defaultConfig(), ...overrides };
  const relay = await startRelay({
    config,
    dbPath: join(dir, "achat.db"),
    webDir: join(import.meta.dirname, "..", "web"),
    port: 0,
  });
  return { relay, client: new RelayClient(relay.url, config.token), config };
}

export class ScriptedRunner implements AgentRunner {
  calls: RunInput[] = [];
  constructor(private replies: (string | Error)[]) {}

  async run(input: RunInput): Promise<RunOutput> {
    this.calls.push(input);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("没有准备好的回复");
    if (next instanceof Error) throw next;
    return { text: next, sessionId: input.sessionId ?? "session-1", costUsd: 0.05 };
  }
}

export async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --- cloud

export class MemoryMailer implements Mailer {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string): Promise<void> {
    this.sent.push({ to, subject, text });
  }
  lastCode(to: string): string {
    const mail = this.sent.filter((m) => m.to === to).at(-1);
    return mail?.subject.match(/(\d{6})/)?.[1] ?? "";
  }
}

export async function startTestCloud(): Promise<{ cloud: RunningCloud; mailer: MemoryMailer }> {
  const dir = mkdtempSync(join(tmpdir(), "achat-cloud-"));
  const mailer = new MemoryMailer();
  const cloud = await startCloud({
    dbPath: join(dir, "achat.db"),
    webDir: join(import.meta.dirname, "..", "web"),
    publicUrl: "https://achat.test",
    mailer,
    port: 0,
  });
  return { cloud, mailer };
}

// A person in a browser: keeps the session cookie and sends the header the
// cloud expects from its own web page.
export class Browser {
  cookie = "";
  constructor(private base: string) {}

  async call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-achat-web": "1",
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new RelayClientError(res.status, data?.error ?? `HTTP ${res.status}`);
    return data as T;
  }
}

export async function logIn(cloud: RunningCloud, mailer: MemoryMailer, email: string, name: string): Promise<Browser> {
  const browser = new Browser(cloud.url);
  await browser.call("POST", "/api/auth/code", { email });
  await browser.call("POST", "/api/auth/verify", { email, code: mailer.lastCode(email) });
  await browser.call("POST", "/api/me", { name });
  return browser;
}

// A computer with its own key, added to the browser's account.
export async function addComputer(
  cloud: RunningCloud,
  browser: Browser,
  name: string,
  clients: AgentClient[],
): Promise<{ client: RelayClient; key: DeviceKey; agent: (c: AgentClient) => string }> {
  const key = ensureDeviceKey(new FileKeyStore(join(mkdtempSync(join(tmpdir(), "achat-key-")), "device.key")));
  const client = new RelayClient(cloud.url, key);
  const ticket = await client.createDeviceLink({ publicKey: key.publicKey, name, clients });
  const id = new URL(ticket.url).pathname.split("/").at(-1)!;
  await browser.call("POST", `/api/device-links/${id}/approve`, {});
  return { client, key, agent: (c) => `${key.deviceId}/${c}` };
}
