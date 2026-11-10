import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { digestLines, HistoryDigest } from "../src/sidecar/history.js";

const line = (o: object): string => JSON.stringify(o);

const CLAUDE_TRANSCRIPT = [
  line({ type: "queue-operation", operation: "enqueue", content: "排队的内容" }),
  line({
    type: "user",
    cwd: "/Users/me/cgman",
    timestamp: "2026-11-06T06:03:00Z",
    message: { role: "user", content: "帮我统计单聊绑定<system-reminder>系统提醒</system-reminder>" },
  }),
  line({ type: "user", isMeta: true, cwd: "/Users/me/cgman", message: { role: "user", content: "Caveat: 内部消息" } }),
  line({
    type: "assistant",
    cwd: "/Users/me/cgman",
    timestamp: "2026-11-06T06:04:00Z",
    message: {
      content: [
        { type: "thinking", thinking: "思考过程" },
        { type: "text", text: "我来查一下" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ickey-claw-cli api-operations call --id 281", description: "查单聊绑定" } },
      ],
    },
  }),
  line({
    type: "user",
    cwd: "/Users/me/cgman",
    timestamp: "2026-11-06T06:05:00Z",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "开头" + "x".repeat(5000) + "结尾标记" }] },
  }),
  line({ type: "attachment", attachment: { type: "hook_success", content: "钩子输出" } }),
  "{这一行坏了",
  line({ type: "assistant", cwd: "/Users/me/cgman", timestamp: "2026-11-06T06:06:00Z", message: { content: [{ type: "text", text: "共 1,714 个联系人" }] } }),
];

test("a Claude Code transcript reads as plain words: who said what, the commands run and the start of their output", () => {
  const text = digestLines("claude", CLAUDE_TRANSCRIPT, "/raw/cgman/a.jsonl")!;
  for (const part of ["/Users/me/cgman", "/raw/cgman/a.jsonl", "主人：", "帮我统计单聊绑定", "Claude：", "我来查一下"]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(text.includes("Bash：ickey-claw-cli api-operations call --id 281"));
  assert.ok(text.includes("查单聊绑定"));
  assert.ok(text.includes("开头xxx"));
  assert.ok(text.includes("共 1,714 个联系人"));
  // A long result keeps its start and says where the rest is.
  assert.ok(!text.includes("结尾标记"));
  assert.ok(text.includes("原始记录第 5 行"));
  for (const gone of ["排队的内容", "系统提醒", "Caveat", "思考过程", "钩子输出"]) {
    assert.ok(!text.includes(gone), gone);
  }
});

test("a Codex transcript reads the same way, without its instructions and hidden reasoning", () => {
  const text = digestLines(
    "codex",
    [
      line({ type: "session_meta", timestamp: "2026-11-08T15:59:32Z", payload: { cwd: "/Users/me/video", timestamp: "2026-11-08T15:59:32Z" } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:33Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex" }] } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:33Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n规则" }] } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:33Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:34Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "做个产品视频" }] } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:35Z", payload: { type: "reasoning", encrypted_content: "gAAAA密文" } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:36Z", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ffmpeg -i a.mp4 b.mp4" }), call_id: "c1" } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:37Z", payload: { type: "function_call_output", call_id: "c1", output: "转好了" } }),
      line({ type: "event_msg", timestamp: "2026-11-08T15:59:38Z", payload: { type: "agent_message", message: "重复的一句" } }),
      line({ type: "response_item", timestamp: "2026-11-08T15:59:39Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "视频做好了" }] } }),
    ],
    "/raw/codex/r.jsonl",
  )!;
  for (const part of ["/Users/me/video", "主人：", "做个产品视频", "exec_command：ffmpeg -i a.mp4 b.mp4", "转好了", "Codex：", "视频做好了"]) {
    assert.ok(text.includes(part), part);
  }
  for (const gone of ["You are Codex", "AGENTS.md", "gAAAA", "重复的一句", "page_id"]) {
    assert.ok(!text.includes(gone), gone);
  }
});

test("a transcript from a folder left out, such as the answering AI's own, gives nothing", () => {
  assert.equal(digestLines("claude", CLAUDE_TRANSCRIPT, "/raw/a.jsonl", ["/Users/me/cgman"]), null);
});

function folders(): { source: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "achat-history-"));
  return { source: join(root, "projects"), dir: join(root, "digest") };
}

test("the plain copies follow the transcripts: new, changed, unchanged and removed", async () => {
  const { source, dir } = folders();
  mkdirSync(join(source, "proj", "s1", "subagents"), { recursive: true });
  const a = join(source, "proj", "a.jsonl");
  const b = join(source, "proj", "s1", "subagents", "b.jsonl");
  writeFileSync(a, CLAUDE_TRANSCRIPT.join("\n") + "\n");
  writeFileSync(b, CLAUDE_TRANSCRIPT.slice(0, 2).join("\n") + "\n");
  const history = new HistoryDigest("claude", source, dir);

  await history.refresh();
  const aCopy = join(dir, "proj", "a.md");
  const bCopy = join(dir, "proj", "s1", "subagents", "b.md");
  assert.ok(readFileSync(aCopy, "utf8").includes("共 1,714 个联系人"));
  assert.ok(readFileSync(bCopy, "utf8").includes("帮我统计单聊绑定"));

  // Unchanged transcripts are not read again.
  writeFileSync(aCopy, "旧的");
  const { atime, mtime } = statSync(a);
  utimesSync(aCopy, atime, mtime);
  await history.refresh();
  assert.equal(readFileSync(aCopy, "utf8"), "旧的");

  // A transcript that grew is read again.
  appendFileSync(a, line({ type: "assistant", cwd: "/Users/me/cgman", message: { content: [{ type: "text", text: "后来又补充了一句" }] } }) + "\n");
  utimesSync(a, atime, new Date(mtime.getTime() + 5000));
  await history.refresh();
  assert.ok(readFileSync(aCopy, "utf8").includes("后来又补充了一句"));

  // A transcript the person deleted is gone from the copies too.
  rmSync(b);
  await history.refresh();
  assert.ok(!existsSync(bCopy));
});

test("transcripts from a left-out folder get no plain copy", async () => {
  const { source, dir } = folders();
  mkdirSync(join(source, "proj"), { recursive: true });
  writeFileSync(join(source, "proj", "a.jsonl"), CLAUDE_TRANSCRIPT.join("\n") + "\n");
  await new HistoryDigest("claude", source, dir, ["/Users/me/cgman"]).refresh();
  assert.ok(!existsSync(join(dir, "proj", "a.md")));
});

test("folders inside a left-out folder are left out too, such as one per thread for answering a person", async () => {
  const { source, dir } = folders();
  mkdirSync(join(source, "proj"), { recursive: true });
  writeFileSync(join(source, "proj", "a.jsonl"), CLAUDE_TRANSCRIPT.join("\n") + "\n");
  await new HistoryDigest("claude", source, dir, ["/Users/me/cg"]).refresh();
  assert.ok(existsSync(join(dir, "proj", "a.md")), "a folder whose name only starts the same is not inside");
  rmSync(dir, { recursive: true, force: true });
  await new HistoryDigest("claude", source, dir, ["/Users/me"]).refresh();
  assert.ok(!existsSync(join(dir, "proj", "a.md")));
});

test("asking for fresh copies while they are being made waits for the same run", async () => {
  const { source, dir } = folders();
  mkdirSync(join(source, "proj"), { recursive: true });
  writeFileSync(join(source, "proj", "a.jsonl"), CLAUDE_TRANSCRIPT.join("\n") + "\n");
  const history = new HistoryDigest("claude", source, dir);
  const first = history.refresh();
  assert.equal(history.refresh(), first);
  await first;
  assert.ok(existsSync(join(dir, "proj", "a.md")));
});

test("compressed Codex transcripts get a plain copy too", { skip: typeof zlib.zstdCompressSync !== "function" }, async () => {
  const { source, dir } = folders();
  mkdirSync(join(source, "2026", "03", "04"), { recursive: true });
  const transcript = [
    line({ type: "session_meta", payload: { cwd: "/Users/me/video" } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "三月份做的视频" }] } }),
    line({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "开头" + "y".repeat(5000) } }),
  ].join("\n");
  writeFileSync(join(source, "2026", "03", "04", "rollout-1.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(transcript)));
  await new HistoryDigest("codex", source, dir).refresh();
  const copy = readFileSync(join(dir, "2026", "03", "04", "rollout-1.md"), "utf8");
  assert.ok(copy.includes("三月份做的视频"));
  // A compressed original cannot be opened at a line, so the copy does not point there.
  assert.ok(!copy.includes("原始记录第"));
});

test("a missing transcript folder is not an error", async () => {
  const { source, dir } = folders();
  await new HistoryDigest("codex", source, dir).refresh();
});
