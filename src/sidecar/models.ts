import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLabel, isEffort, EFFORTS, type Effort, type ModelChoice, type ModelOffer } from "../models.js";
import { claudeCommand } from "../which.js";

// What Claude Code and Codex on this computer can use, and what they are set
// to use, as the person sees it when they open them. Achat passes the model
// and 推理档位 to every run, so 问答 and 动手 use the same default.

const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// Aliases Claude Code takes for the latest model of each kind; which model
// that is depends on the Claude Code, so each is named after what it starts on.
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The model Claude Code starts on, by default or for `model` (an alias such
// as "opus"): what `claude -p` says when it starts, before it asks anything,
// so finding out costs nothing. It runs on the person's own login, as Claude
// Code does when they open it, not on the credential from `achat
// claude-token`, which starts on another model.
export function claudeStartsOn(command: string, model?: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ACHAT_HEADLESS: "1" };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const args = [
      ...["-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
      ...["--max-budget-usd", "0.01", "--system-prompt", ".", ...(model ? ["--model", model] : [])],
    ];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    let done = false;
    let buffer = "";
    const finish = (model: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(model);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdout!.on("data", (d) => {
      buffer += d;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const e = JSON.parse(line) as { type?: string; subtype?: string; model?: unknown };
          if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") finish(e.model);
        } catch {
          // not an event
        }
      }
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(".");
  });
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

// Claude Code's models and default, found all at once. Its 推理档位 is the
// effortLevel the person set in Claude Code, or else 中.
export async function claudeOffer(command = claudeCommand(), configDir = claudeConfigDir()): Promise<ModelOffer | null> {
  const settings = readJson(join(configDir, "settings.json"));
  const set = typeof settings?.model === "string" ? settings.model : null;
  const [started, ...aliases] = await Promise.all([claudeStartsOn(command), ...CLAUDE_ALIASES.map((a) => claudeStartsOn(command, a))]);
  const model = started ?? set;
  if (!model) return null;
  const effort = isEffort(settings?.effortLevel) && CLAUDE_EFFORTS.includes(settings.effortLevel) ? settings.effortLevel : "medium";
  const models = CLAUDE_ALIASES.map((id, i) => ({ id, label: claudeLabel(aliases[i] ?? id), efforts: CLAUDE_EFFORTS }));
  return { models, default: { id: model, label: claudeLabel(model), efforts: CLAUDE_EFFORTS, effort } };
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

// A top-level string setting in config.toml, before its first [section].
function tomlString(toml: string, key: string): string | null {
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(line);
    if (m) return m[1] ?? m[2];
  }
  return null;
}

interface CachedModel {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

function effortsOf(m: CachedModel): Effort[] {
  const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
  const named = levels.map((l: unknown) => (typeof l === "string" ? l : (l as { effort?: unknown } | null)?.effort));
  return EFFORTS.filter((e) => named.includes(e));
}

// Codex's models, from the list it keeps of what this login can use, and the
// model and 推理档位 set in config.toml. The background 问答 does not read
// config.toml (no MCP servers or hooks there), so Achat passes them itself.
export function codexOffer(home = codexHome()): ModelOffer | null {
  let toml = "";
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    // no settings
  }
  const cache = readJson(join(home, "models_cache.json"));
  const listed = (Array.isArray(cache?.models) ? cache.models : []) as CachedModel[];
  const cached = listed.filter((m) => typeof m.slug === "string");
  const models: ModelChoice[] = cached
    .filter((m) => m.visibility === undefined || m.visibility === "list")
    .map((m) => ({ id: m.slug as string, label: typeof m.display_name === "string" ? m.display_name : (m.slug as string), efforts: effortsOf(m) }));
  const id = tomlString(toml, "model") ?? models[0]?.id;
  if (!id) return null;
  const own = cached.find((m) => m.slug === id);
  const def = models.find((m) => m.id === id) ?? { id, label: own && typeof own.display_name === "string" ? own.display_name : id, efforts: own ? effortsOf(own) : [] };
  const set = tomlString(toml, "model_reasoning_effort");
  const effort = isEffort(set) ? set : isEffort(own?.default_reasoning_level) ? own.default_reasoning_level : "medium";
  return { models, default: { ...def, effort } };
}
