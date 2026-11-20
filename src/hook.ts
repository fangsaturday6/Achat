import { readFile } from "node:fs/promises";
import { RelayClient } from "./client.js";
import { ownerOf, type FormSupport } from "./asking.js";
import { cjk } from "./text.js";
import type { ThreadSummary, UnseenGroup } from "./types.js";

export interface HookInput {
  // The session's own conversation log, as Claude Code and Codex hand it to hooks.
  transcriptPath?: string;
  // The 动手 this session does (its TaskBook key, by the folder it runs in),
  // if it is a 动手 conversation: it is told nothing, since approving,
  // threads it asked and groups it spoke in are the front session's, and
  // the tools for them are not its own (createMcpServer).
  task?: string | null;
  // Whether this client shows review_pending's form (formSupport): where it
  // cannot, requests waiting for approval are left to the dialog on the
  // computer and the session is not told of them.
  forms?: FormSupport;
}

// The session's own log, which tells the threads and groups it took part in:
// an id shows up there once an Achat tool reported on it there. A session
// that never saw a thread or a group has nothing to continue. Empty when
// there is no log.
async function sessionLog(transcriptPath: string | undefined): Promise<string> {
  if (!transcriptPath) return "";
  try {
    return await readFile(transcriptPath, "utf8");
  } catch {
    return "";
  }
}

// Output for Claude Code's and Codex's UserPromptSubmit hook. For requests
// waiting for approval it only says how many, never who sent them or what
// they say, so nothing from the other side reaches the model before the person
// approves. For threads this AI asked, it tells the session that asked when
// the other side has said something since, so the work there carries on; for
// groups, the session that spoke there when someone replied to what it said
// (8n), naming only the group.
export async function userPromptHook(client: RelayClient, agentId: string, input: HookInput = {}): Promise<string | null> {
  if (process.env.ACHAT_HEADLESS || input.task) return null;
  let pending: ThreadSummary[];
  let news: ThreadSummary[];
  let replied: UnseenGroup[];
  try {
    [pending, news, replied] = await Promise.all([
      client.listThreads({ to: agentId, status: "pending", surfaced: true }),
      client.listThreads({ unseen: agentId }),
      // Groups need an account: on this computer alone, or with an Achat
      // service from before, there are none, and the rest is still told.
      client.unseenGroups(agentId).catch(() => []),
    ]);
  } catch {
    return null;
  }
  const lines: string[] = [];
  if (pending.length && input.forms !== "unshown") {
    lines.push(
      `Achat：有 ${pending.length} 个待批准的请求。先调用 achat 的 review_pending 工具，` +
        "让主人在弹出的对话框里同意或拒绝，然后继续主人刚才的事。不要猜测请求内容。",
    );
  }
  const log = news.length || replied.length ? await sessionLog(input.transcriptPath) : "";
  const here = news.filter((t) => log.includes(t.id));
  if (here.length) {
    const agents = await client.agents().catch(() => []);
    const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
    for (const t of here) {
      // The other side's person, when they wrote the news themself, also when
      // this computer already answered it in the background.
      let news = t.lastMessage;
      if (news?.sender === t.from && news.toPerson) {
        const detail = await client.getThread(t.id).catch(() => null);
        news = detail?.messages.filter((m) => m.sender === t.to).at(-1) ?? null;
      }
      const who = news?.sender === t.to && news.byPerson ? `${ownerOf(name(t.to))}本人` : name(t.to);
      lines.push(
        `Achat：${cjk(who, "在你之前发起的协作")}「${t.topic}」（${t.id}）里有新消息。` +
          "先用 achat 的 check_thread 看完整内容，把原文转给主人，再接着做这件事。",
      );
    }
  }
  for (const g of replied.filter((g) => log.includes(g.id))) {
    lines.push(`Achat：群「${g.name}」（${g.id}）里有人回了你发的消息。先用 achat 的 check_group（group: ${g.id}）看，再接着回答主人。`);
  }
  if (!lines.length) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
  });
}
