import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// AIs that Achat runs on a person's computer, which can answer in the background.
export type AgentClient = "claude" | "codex";
// AIs that connect to the cloud with an address and a credential; they can
// ask others but not answer.
export type RemoteClient = "doubao" | "workbuddy" | "other";
export type AiClient = AgentClient | RemoteClient;

export interface AgentConfig {
  id: string;
  name: string;
  client: AiClient;
  // False for AIs that cannot answer requests; absent means they can.
  canReceive?: boolean;
}

// An AI listed in this computer's config.json.
export interface LocalAgent extends AgentConfig {
  client: AgentClient;
}

export interface AchatConfig {
  port: number;
  token: string;
  agents: LocalAgent[];
  defaults: { maxRounds: number; budgetUsd: number };
  limits: {
    // Requests from one contact beyond this count in 24 hours stay on the web
    // page and are not surfaced in the receiver's AI session.
    surfacedPerContactPerDay: number;
    // A sender beyond this count in 24 hours must pass a check first.
    sentPerDay: number;
  };
  // Set once this computer asks to join an Achat account. Until the person
  // confirms on the web, `linked` is false and the local relay keeps working.
  cloud?: { url: string; linked: boolean };
}

// The Achat service people sign up on; `achat link <url>` can name another.
export const DEFAULT_CLOUD_URL = process.env.ACHAT_CLOUD_URL ?? "";

// Experiment 0: one person, their own Claude Code and Codex on one computer,
// identities written in config instead of registration.
export const DEFAULT_AGENTS: LocalAgent[] = [
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

// Changes what config.json stores, leaving the rest as it is. `undefined`
// removes a field.
export function updateConfig(patch: Partial<AchatConfig>): AchatConfig {
  loadConfig();
  const stored = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete stored[key];
    else stored[key] = value;
  }
  save(stored as Partial<AchatConfig>);
  return loadConfig();
}

export function relayUrl(cfg: AchatConfig): string {
  return process.env.ACHAT_RELAY_URL ?? `http://127.0.0.1:${cfg.port}`;
}
