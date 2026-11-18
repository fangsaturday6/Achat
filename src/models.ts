// Which model an AI answers and works with, and how hard it thinks (推理档位).
// The computer it runs on says what it can use; the person picks a default
// for each AI and, for one conversation, something else. The relay keeps both
// and works out what a conversation runs on, so the web page, the MCP tools
// and the computer all see the same thing.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

// From least to most thinking. Claude has the first five, some Codex models all six.
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极限",
};

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as string[]).includes(value);
}

// One model an AI can use: the name its CLI takes, the name people read, and
// the 推理档位 it takes.
export interface ModelChoice {
  id: string;
  label: string;
  efforts: Effort[];
}

// What a computer reports for one of its AIs.
export interface ModelOffer {
  models: ModelChoice[];
  // What the AI itself is set to use: Claude Code's or Codex's own default.
  default: ModelChoice & { effort: Effort };
}

// What the person picked, for an AI or for one conversation. Null: the next
// one down decides (a conversation's pick, then the AI's, then its own default).
export interface ModelPick {
  model: string | null;
  effort: Effort | null;
}

export const NO_PICK: ModelPick = { model: null, effort: null };

// An AI's models as people and AIs see them. `uses`: what it uses now, as
// the relay works it out.
export interface AgentModels extends ModelOffer {
  picked: ModelPick;
  uses?: ModelUse;
}

// What a conversation runs on.
export interface ModelUse {
  model: string;
  label: string;
  effort: Effort;
}

// The 推理档位 a model takes nearest to the one wanted: a model without
// "很高" gets "高" instead.
function nearest(efforts: Effort[], want: Effort): Effort {
  if (!efforts.length || efforts.includes(want)) return want;
  const at = EFFORTS.indexOf(want);
  return [...efforts].sort((a, b) => Math.abs(EFFORTS.indexOf(a) - at) - Math.abs(EFFORTS.indexOf(b) - at) || EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}

// The model `id` among those offered; the default when it is gone (the
// computer stopped offering it).
export function choiceOf(offer: ModelOffer, id: string | null): ModelChoice {
  if (id === null || id === offer.default.id) return offer.default;
  return offer.models.find((m) => m.id === id) ?? offer.default;
}

// The conversation's pick, else the AI's, else its own default.
export function resolveUse(models: AgentModels, thread: ModelPick = NO_PICK): ModelUse {
  const choice = choiceOf(models, thread.model ?? models.picked.model);
  const effort = nearest(choice.efforts, thread.effort ?? models.picked.effort ?? models.default.effort);
  return { model: choice.id, label: choice.label, effort };
}

// "Opus 4.8 · 中", as on the web page and in the MCP tools.
export function useLine(use: { label: string; effort: Effort }): string {
  return `${use.label} · ${EFFORT_LABELS[use.effort]}`;
}

const CLAUDE_ALIASES: Record<string, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

// What people call a Claude model: "claude-opus-4-8[1m]" is "Opus 4.8 1M",
// "claude-haiku-4-5-20251001" is "Haiku 4.5", the alias "opus" is "Opus".
export function claudeLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (!m) return CLAUDE_ALIASES[id] ?? id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}${m[4] ? " 1M" : ""}`;
}

const MAX_MODELS = 30;

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function choice(raw: unknown): ModelChoice | null {
  const m = raw as Record<string, unknown> | null;
  const id = text(m?.id, 80);
  const label = text(m?.label, 80);
  if (!id || !label || !Array.isArray(m?.efforts)) return null;
  return { id, label, efforts: EFFORTS.filter((e) => (m.efforts as unknown[]).includes(e)) };
}

// What a computer reported, checked; null when it is not an offer.
export function readOffer(raw: unknown): ModelOffer | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || !Array.isArray(o.models) || o.models.length > MAX_MODELS) return null;
  const models = o.models.map(choice);
  const def = choice(o.default);
  const effort = (o.default as Record<string, unknown> | null)?.effort;
  if (models.some((m) => m === null) || !def || !isEffort(effort)) return null;
  return { models: models as ModelChoice[], default: { ...def, effort } };
}
