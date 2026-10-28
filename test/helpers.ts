import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "../src/client.js";
import { defaultConfig, type AchatConfig } from "../src/config.js";
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
