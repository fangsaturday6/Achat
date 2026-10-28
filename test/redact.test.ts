import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../src/redact.js";

test("filters keys, tokens, contact details and home paths", () => {
  const input = [
    "key sk-ant-api03-abcdefghijklmnopqrstuvwx",
    "gh token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123",
    'api_key = "abcdefgh12345678"',
    "mail me@example.com or call 13812345678",
    "file /Users/fang/Movies/demo.mp4 and /home/fang/notes.md",
  ].join("\n");
  const { text, count } = redact(input);
  assert.equal(count, 8);
  assert.doesNotMatch(text, /sk-ant|ghp_|abcdefgh12345678|me@example\.com|13812345678|fang/);
  assert.match(text, /api_key = "\[已过滤\]"/);
  assert.match(text, /~\/Movies\/demo\.mp4/);
});

test("leaves ordinary text alone", () => {
  const input = "第二步用 Midjourney 生成画面，风格参数是 --stylize 250，一共 12 个镜头。";
  assert.deepEqual(redact(input), { text: input, count: 0 });
});
