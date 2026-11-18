import assert from "node:assert/strict";
import { test } from "node:test";
import { LoginWait } from "../src/sidecar/login-wait.js";
import { LoginExpiredError } from "../src/sidecar/runners.js";

test("a login that ran out is waited for, told once, and given up after a day", async () => {
  let now = 0;
  const alerts: string[] = [];
  const wait = new LoginWait({ alert: (title) => alerts.push(title), retryMs: 5, timers: new Set(), log: () => {}, advice: () => "运行 achat claude-token", now: () => now });
  const told: string[] = [];
  const given: string[] = [];
  let again = 0;
  const hooks = { tell: async (n: string) => told.push(n), giveUp: async (n: string) => given.push(n), again: () => again++ };
  const err = new LoginExpiredError("claude", "Not logged in");

  await wait.loginExpired("t1", err, hooks);
  await wait.loginExpired("t2", err, hooks);
  assert.deepEqual(told, ["回答的 Claude 需要重新登录，登录后会自动接着回答", "回答的 Claude 需要重新登录，登录后会自动接着回答"]);
  assert.deepEqual(alerts, ["你的 Claude 需要重新登录"]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(again, 2);

  now = 24 * 3600_000 + 1;
  await wait.loginExpired("t1", err, hooks);
  assert.deepEqual(given, ["Claude 一天都没有重新登录，这次没有回答"]);

  // Answered: the person is told again next time it runs out.
  wait.answered("t2", "claude");
  await wait.loginExpired("t3", err, hooks);
  assert.deepEqual(alerts, ["你的 Claude 需要重新登录", "你的 Claude 需要重新登录"]);
});

test("a slow answer is tried once more, then fails", () => {
  const wait = new LoginWait({ timers: new Set(), log: () => {}, advice: () => "" });
  assert.equal(wait.timedOut("t"), true);
  assert.equal(wait.timedOut("t"), false);
  assert.equal(wait.timedOut("t"), true);
});
