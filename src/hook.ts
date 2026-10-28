import { RelayClient } from "./client.js";

// Output for Claude Code's UserPromptSubmit hook. It only says how many
// requests are waiting, never who sent them or what they say, so nothing from
// the other side reaches the model before the person approves.
export async function userPromptHook(client: RelayClient, agentId: string): Promise<string | null> {
  if (process.env.ACHAT_HEADLESS) return null;
  let count: number;
  try {
    count = (await client.listThreads({ to: agentId, status: "pending", surfaced: true })).length;
  } catch {
    return null;
  }
  if (!count) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        `Achat：有 ${count} 个待批准的请求。先调用 achat 的 review_pending 工具，` +
        "让主人在弹出的对话框里同意或拒绝，然后继续主人刚才的事。不要猜测请求内容。",
    },
  });
}
