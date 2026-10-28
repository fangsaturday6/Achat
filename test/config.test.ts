import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { configPath, loadConfig } from "../src/config.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.ACHAT_HOME;
  process.env.ACHAT_HOME = mkdtempSync(join(tmpdir(), "achat-config-"));
});
afterEach(() => {
  if (saved === undefined) delete process.env.ACHAT_HOME;
  else process.env.ACHAT_HOME = saved;
});

function stored(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf8"));
}

test("a new config keeps only what belongs to this computer", () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.defaults, { maxRounds: 5, budgetUsd: 5 });
  assert.deepEqual(Object.keys(stored()).sort(), ["agents", "port", "token"]);
  assert.equal(loadConfig().token, cfg.token);
});

test("defaults written by the first version give way to the current ones", () => {
  const { token } = loadConfig();
  writeFileSync(configPath(), JSON.stringify({ ...stored(), defaults: { maxRounds: 5, budgetUsd: 1 } }));
  assert.equal(loadConfig().defaults.budgetUsd, 5);
  assert.equal(stored().defaults, undefined);
  assert.equal(stored().token, token);
});

test("defaults the person changed are kept", () => {
  loadConfig();
  writeFileSync(configPath(), JSON.stringify({ ...stored(), defaults: { budgetUsd: 2 } }));
  assert.deepEqual(loadConfig().defaults, { maxRounds: 5, budgetUsd: 2 });
});
