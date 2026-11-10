import { readFile } from "node:fs/promises";
import { RelayClient } from "./client.js";
import { ownerOf } from "./asking.js";
import { cjk } from "./text.js";
import type { ThreadSummary } from "./types.js";

export interface HookInput {
  // The session's own conversation log, as Claude Code and Codex hand it to hooks.
  transcriptPath?: string;
}

// The threads among `threads` that this session took part in: a thread's id
// shows up in the session's log once an Achat tool reported on it there. A
// session that never saw the thread has nothing to continue.
async function askedHere(threads: ThreadSummary[], transcriptPath: string | undefined): Promise<ThreadSummary[]> {
  if (!threads.length || !transcriptPath) return [];
  let log: string;
  try {
    log = await readFile(transcriptPath, "utf8");
  } catch {
    return [];
  }
  return threads.filter((t) => log.includes(t.id));
}

// Output for Claude Code's and Codex's UserPromptSubmit hook. For requests
// waiting for approval it only says how many, never who sent them or what
// they say, so nothing from the other side reaches the model before the person
// approves. For threads this AI asked, it tells the session that asked when
// the other side has said something since, so the work there carries on.
export async function userPromptHook(client: RelayClient, agentId: string, input: HookInput = {}): Promise<string | null> {
  if (process.env.ACHAT_HEADLESS) return null;
  let pending: ThreadSummary[];
  let news: ThreadSummary[];
  try {
    [pending, news] = await Promise.all([
      client.listThreads({ to: agentId, status: "pending", surfaced: true }),
      client.listThreads({ unseen: agentId }),
    ]);
  } catch {
    return null;
  }
  const lines: string[] = [];
  if (pending.length) {
    lines.push(
      `Achat：有 ${pending.length} 个待批准的请求。先调用 achat 的 review_pending 工具，` +
        "让主人在弹出的对话框里同意或拒绝，然后继续主人刚才的事。不要猜测请求内容。",
    );
  }
  const here = await askedHere(news, input.transcriptPath);
  if (here.length) {
    const agents = await client.agents().catch(() => []);
    const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
    for (const t of here) {
      // The other side's person, when they wrote the news themself.
      const last = t.lastMessage;
      const who = last && (last.sender === t.to ? last.byPerson : last.toPerson) ? `${ownerOf(name(t.to))}本人` : name(t.to);
      lines.push(
        `Achat：${cjk(who, "在你之前发起的协作")}「${t.topic}」（${t.id}）里有新消息。` +
          "先用 achat 的 check_thread 看完整内容，把原文转给主人，再接着做这件事。",
      );
    }
  }
  if (!lines.length) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
  });
}
