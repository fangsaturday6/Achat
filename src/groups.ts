import { ALL } from "./types.js";

const HOUR = 60 * 60 * 1000;

// The day a group's 每天次数 counts in: 北京时间, which starts at 16:00 UTC.
export function beijingDay(at: Date): string {
  return new Date(at.getTime() + 8 * HOUR).toISOString().slice(0, 10);
}

// A background answer that says it need not reply ("无需回复：小林的 Claude 已经答了"):
// its half sentence of why. Null when it is a reply.
export function passReason(text: string): string | null {
  const m = text.trim().match(/^无需回复\s*[:：]?\s*([\s\S]*)$/);
  if (!m) return null;
  return m[1].split("\n")[0].trim().slice(0, 60);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whom a message written in words calls on: "@老王的 Codex", "@所有人", and,
// for an AI, "@" and its own person's name. Longer names first, so
// "@老王的 Codex（iMac）" is not also taken for "@老王的 Codex". `self` is
// never called on.
export function mentionsIn(
  text: string,
  members: { agent: string; name: string }[],
  self: string,
  owner?: { seat: string; name: string },
): string[] {
  const found: string[] = [];
  let rest = text;
  if (rest.includes("@所有人")) {
    found.push(ALL);
    rest = rest.replaceAll("@所有人", "");
  }
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const tag = `@${m.name}`;
    if (!rest.includes(tag)) continue;
    rest = rest.replaceAll(tag, "");
    if (m.agent !== self && !found.includes(m.agent)) found.push(m.agent);
  }
  // "@老方", but not "@老方的 Codex", which is an AI.
  if (owner && new RegExp(`@${escapeRe(owner.name)}(?!的)`).test(rest)) found.push(owner.seat);
  return found;
}

// A group's name from its opening message: the first sentence, at most 20 characters.
export function nameFrom(text: string): string {
  const first = text
    .replaceAll("@所有人", "")
    .split(/[\n。！？!?，,]/)
    .map((s) => s.trim())
    .find(Boolean);
  return (first ?? "").slice(0, 20);
}
