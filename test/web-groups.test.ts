import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { GROUP_LIMITS } from "../src/relay/groups.js";
import type { RunningRelay } from "../src/relay/server.js";
import { ALL, GROUP_STATUS_LABELS, RECEIPT_LABELS } from "../src/types.js";
import * as page from "../web/groups.js";
import { startTestRelay } from "./helpers.js";

const WEB = join(import.meta.dirname, "..", "web");

describe("the page's modules", () => {
  let relay: RunningRelay;
  before(async () => ({ relay } = await startTestRelay()));
  after(() => relay.close());

  test("every script parses, and what app.js imports is served as JavaScript", async () => {
    for (const file of ["app.js", "text.js", "groups.js"]) execFileSync(process.execPath, ["--check", join(WEB, file)]);
    // An import may run over several lines.
    const imports = [...readFileSync(join(WEB, "app.js"), "utf8").matchAll(/^import [\s\S]*? from "\.\/(.+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["groups.js", "text.js"]);
    for (const file of imports) {
      const res = await fetch(`${relay.url}/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get("content-type") ?? "", /javascript/, file);
    }
  });
});

test("the page names receipts, states and 每天次数 as the relay does", () => {
  assert.deepEqual(page.RECEIPT_LABELS, RECEIPT_LABELS);
  assert.deepEqual(page.GROUP_STATUS_LABELS, GROUP_STATUS_LABELS);
  assert.equal(page.ALL, ALL);
  assert.deepEqual(page.QUOTA, { perDay: GROUP_LIMITS.quota, max: GROUP_LIMITS.maxQuota });
});

test("a group in 消息: the invite waiting in red, else who said the latest words; only invites count on 消息", () => {
  const base = { role: "member", lastMessage: null, lastSender: null, myInvite: null, unread: false };
  assert.deepEqual(page.groupPreview({ ...base, role: "invited", myInvite: { invitedByName: "老方的 Claude" } }), { pending: true, text: "老方的 Claude 邀请你" });
  const said = { kind: "message", body: "可以，网关把原始报文落一份", files: [] };
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: said, lastSender: "王闯的 Codex" }), { pending: false, text: "王闯的 Codex：可以，网关把原始报文落一份" });
  const note = { kind: "system", body: "老王的 Codex 加入了群聊", files: [] };
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: note }), { pending: false, text: "老王的 Codex 加入了群聊" });
  const picture = { kind: "message", body: "", files: [{ name: "截图.png", type: "image/png" }] };
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: picture, lastSender: "我" }), { pending: false, text: "我：[图片]" });
  assert.deepEqual(page.groupPreview(base), { pending: false, text: "" });
  assert.deepEqual(page.groupPreview({ ...base, role: "invited", myInvite: {} }), { pending: true, text: "有人邀请你" });
  assert.deepEqual(page.groupPreview({ ...base, lastMessage: said, lastSender: null }), { pending: false, text: "可以，网关把原始报文落一份" });
  assert.equal(page.invitesWaiting([{ ...base, role: "invited" }, { ...base, unread: true }]), 1);
});
