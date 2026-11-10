import { cjk } from "./text.js";
import { MODE_LABELS, type Message, type Thread, type ThreadDetail } from "./types.js";

// How a request waiting for approval is put to the person who decides, the
// same in the dialog on their computer and in Claude: a first request, a
// 问答 asking to 动手, or asking to go on once the thread ended or its rounds
// or money ran out.

function upgrade(t: Thread): boolean {
  return t.prior?.mode === "answer" && t.mode === "do";
}

// 老王的 Codex 想问 / 想接着问 你的 Claude; 老王的 Codex 请你的 Claude (接着) 动手.
export function requestTitle(t: Thread, from: string, to: string): string {
  const goesOn = t.prior !== null && !upgrade(t);
  if (t.mode === "do") return cjk(from, "请", to, goesOn ? "接着动手" : "动手");
  return cjk(from, goesOn ? "想接着问" : "想问", to);
}

// Why it is asked again: the note the thread ended or paused with, such as
// "已到 5 轮上限，协作结束" or "花费到了上限 $1.00".
export function requestReason(t: ThreadDetail): string | null {
  if (!t.prior || upgrade(t)) return null;
  return t.messages.filter((m) => m.kind === "system").at(-1)?.body ?? null;
}

// A message's words, with the names of the files sent with it, for a person
// to read: "看下这张图\n[附件] 报错.png、日志.txt".
export function withFileNames(m: Message | undefined): string {
  if (!m) return "";
  const names = (m.files ?? []).map((f) => f.name).join("、");
  return names ? [m.body, `[附件] ${names}`].filter(Boolean).join("\n") : m.body;
}

// What the person decides on: the asker's latest message.
export function pendingMessage(t: ThreadDetail): Message | undefined {
  return t.messages.filter((m) => m.kind !== "system" && m.sender === t.from).at(-1);
}

// 问答 · 5 轮 · $5.00, or 动手 · 5 轮: 动手 runs on the person's Claude
// subscription and has no dollar figure.
export function scopeLine(t: Thread): string {
  const rounds = `${MODE_LABELS[t.mode]} · ${t.scope.maxRounds} 轮`;
  return t.mode === "do" ? rounds : `${rounds} · $${t.scope.budgetUsd.toFixed(2)}`;
}

// Who wrote a message: the AI's name, or for one the person wrote on the web
// page, the person: "老王本人", or "你的主人本人" when it is the reader's own.
export function speaker(m: Message, name: string): string {
  if (!m.byPerson) return name;
  const owner = name.replace(/的.*$/, "");
  return owner === "我" ? "你的主人本人" : `${owner}本人`;
}
