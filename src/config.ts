import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentClient = "claude" | "codex";

export interface AgentConfig {
  id: string;
  name: string;
  client: AgentClient;
}

export interface AchatConfig {
  port: number;
  token: string;
  agents: AgentConfig[];
  defaults: { maxRounds: number; budgetUsd: number };
  limits: {
    // Requests from one contact beyond this count in 24 hours stay on the web
    // page and are not surfaced in the receiver's AI session.
    surfacedPerContactPerDay: number;
    // A sender beyond this count in 24 hours must pass a check first.
    sentPerDay: number;
  };
}

// Experiment 0: one person, their own Claude Code and Codex on one computer,
// identities written in config instead of registration.
export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: "claude@local", name: "我的 Claude", client: "claude" },
  { id: "codex@local", name: "我的 Codex", client: "codex" },
];

export const DEFAULT_PORT = 7330;

export function achatHome(): string {
  return process.env.ACHAT_HOME ?? join(homedir(), ".achat");
}

export function configPath(): string {
  return join(achatHome(), "config.json");
}

export function dbPath(): string {
  return join(achatHome(), "achat.db");
}

export function defaultConfig(): AchatConfig {
  return {
    port: DEFAULT_PORT,
    token: randomBytes(24).toString("base64url"),
    agents: DEFAULT_AGENTS,
    defaults: { maxRounds: 5, budgetUsd: 5 },
    limits: { surfacedPerContactPerDay: 5, sentPerDay: 20 },
  };
}

// Early versions wrote the defaults into config.json, which pinned them there.
const FIRST_DEFAULTS = JSON.stringify({ maxRounds: 5, budgetUsd: 1 });

function save(stored: Partial<AchatConfig>): void {
  mkdirSync(achatHome(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
}

// config.json holds this computer's port, token and agents, plus any defaults
// or limits the person changed; everything else comes from defaultConfig().
export function loadConfig(): AchatConfig {
  const path = configPath();
  const base = defaultConfig();
  if (!existsSync(path)) {
    save({ port: base.port, token: base.token, agents: base.agents });
    return base;
  }
  const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<AchatConfig>;
  if (JSON.stringify(stored.defaults) === FIRST_DEFAULTS) {
    delete stored.defaults;
    save(stored);
  }
  return {
    ...base,
    ...stored,
    defaults: { ...base.defaults, ...stored.defaults },
    limits: { ...base.limits, ...stored.limits },
  };
}

export function relayUrl(cfg: AchatConfig): string {
  return process.env.ACHAT_RELAY_URL ?? `http://127.0.0.1:${cfg.port}`;
}
