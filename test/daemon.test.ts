import assert from "node:assert/strict";
import { test } from "node:test";
import { stamped } from "../src/daemon.js";

// The background service's log says when each line happened, so a pause can
// be measured afterwards.
test("each line of the log starts with the date and time", () => {
  const lines: unknown[][] = [];
  const log = stamped((...args) => lines.push(args), () => new Date(2026, 10, 10, 10, 12, 37));
  log("回答 2da2e750ad（第 2 轮）");
  assert.deepEqual(lines, [["11-10 10:12:37", "回答 2da2e750ad（第 2 轮）"]]);
});
