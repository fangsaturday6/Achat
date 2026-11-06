import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { RunningCloud } from "../src/cloud/server.js";
import { Activity } from "../src/daemon.js";
import { installedRelease, signPackage, signRelease } from "../src/release.js";
import type { Answer } from "../src/sidecar/dialog.js";
import type { RunOutput } from "../src/sidecar/runners.js";
import { stageUpdate, switchTo } from "../src/update.js";
import { startTestCloud } from "./helpers.js";

const { publicKey: key, privateKey: signer } = generateKeyPairSync("ed25519");
const MONDAY = new Date("2026-11-02T08:00:00Z");
const THURSDAY = new Date("2026-11-05T08:00:00Z");

// A built package as deploy/upload.sh leaves it; its cli says which one it is.
function writePackage(root: string, name: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "achat", type: "module" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(root, "dist", "cli.js"), `console.log(${JSON.stringify(name)});\n`);
  writeFileSync(join(root, "web", "index.html"), "<!doctype html>");
  return root;
}

const cli = (root: string) => readFileSync(join(root, "dist", "cli.js"), "utf8");

describe("updating people's computers", () => {
  let cloud: RunningCloud;
  const dir = mkdtempSync(join(tmpdir(), "achat-update-"));
  // What the service hands out, and the copy installed on a computer.
  const server = join(dir, "server");
  const app = join(dir, "home", "app");
  let installed: string[];
  const update = () =>
    stageUpdate({
      url: cloud.url,
      app,
      key,
      installDeps: async (d) => void installed.push(d),
      check: async () => {},
    });

  before(async () => {
    writePackage(server, "v2");
    ({ cloud } = await startTestCloud(undefined, { appDir: server }));
  });
  after(() => cloud.close());

  beforeEach(() => {
    installed = [];
    signRelease(writePackage(app, "v1"), signer, MONDAY);
    signRelease(writePackage(server, "v2"), signer, THURSDAY);
  });

  test("a computer installs a newer signed release beside the running copy, then switches to it", async () => {
    const staged = await update();
    assert.ok(staged);
    assert.equal(staged.dir, `${app}.new`);
    assert.deepEqual(installed, [staged.dir]);
    assert.match(cli(app), /v1/);

    switchTo(staged, app);
    assert.match(cli(app), /v2/);
    assert.equal(installedRelease(app)?.builtAt, THURSDAY.toISOString());
    assert.ok(!existsSync(`${app}.new`) && !existsSync(`${app}.old`));
    assert.equal(await update(), null);
  });

  test("a computer never goes back to an older release", async () => {
    signRelease(server, signer, new Date("2026-10-30T08:00:00Z"));
    assert.equal(await update(), null);
  });

  test("a release not signed with the release key is refused, and the installed copy stays", async () => {
    signRelease(server, generateKeyPairSync("ed25519").privateKey, THURSDAY);
    await assert.rejects(update(), /签名不对/);
    assert.match(cli(app), /v1/);
    assert.ok(!existsSync(`${app}.new`));
  });

  test("a file changed on the server after signing is refused", async () => {
    writeFileSync(join(server, "dist", "cli.js"), "steal()\n");
    await assert.rejects(update(), /对不上：dist\/cli\.js/);
    assert.deepEqual(installed, []);
    assert.match(cli(app), /v1/);
    assert.ok(!existsSync(`${app}.new`));
  });

  test("files an earlier deploy left on the server are not handed out", async () => {
    writeFileSync(join(server, "dist", "removed.js"), "old()\n");
    const res = await fetch(`${cloud.url}/download/achat.tgz`);
    const listing = spawnSync("tar", ["-tzf", "-"], { input: Buffer.from(await res.arrayBuffer()) }).stdout.toString();
    assert.ok(listing.includes("dist/cli.js") && listing.includes("release.sig"));
    assert.ok(!listing.includes("removed.js"));
    assert.ok(await update());
  });

  test("a service without a signed release offers no update, and still installs", async () => {
    rmSync(join(server, "release.json"));
    assert.equal((await fetch(`${cloud.url}/download/release`)).status, 404);
    assert.equal(await update(), null);
    const res = await fetch(`${cloud.url}/download/achat.tgz`);
    const listing = spawnSync("tar", ["-tzf", "-"], { input: Buffer.from(await res.arrayBuffer()) }).stdout.toString();
    assert.ok(listing.split("\n").includes("dist/cli.js"));
  });

  test("achat release signs only with the key that matches the code", () => {
    const keys = mkdtempSync(join(tmpdir(), "achat-key-"));
    process.env.ACHAT_RELEASE_KEY = join(keys, "release-key.pem");
    try {
      assert.throws(() => signPackage(server), /找不到发布私钥/);
      writeFileSync(process.env.ACHAT_RELEASE_KEY, signer.export({ type: "pkcs8", format: "pem" }));
      assert.throws(() => signPackage(server), /对不上/);
    } finally {
      delete process.env.ACHAT_RELEASE_KEY;
    }
  });
});

test("an update waits until nothing is being answered or asked", async () => {
  let now = 0;
  const activity = new Activity(() => now);
  let done!: (out: RunOutput) => void;
  const answering = activity.runner({ run: () => new Promise((r) => (done = r)) }).run({ prompt: "", systemPrompt: "", budgetUsd: 1 });
  now = 120_000;
  assert.equal(activity.quietFor(30_000), false);
  done({ text: "好", sessionId: "s", costUsd: 0 });
  await answering;
  // The answer is still being sent back.
  assert.equal(activity.quietFor(30_000), false);
  now += 30_000;
  assert.equal(activity.quietFor(30_000), true);

  let reply!: (a: Answer) => void;
  const ask = activity.asker(() => ({ answer: new Promise((r) => (reply = r)), close() {} }));
  const asking = ask({ title: "老王的 Codex 想问你的 Claude", topic: "", body: "", scope: "" })!;
  now += 600_000;
  assert.equal(activity.quietFor(30_000), false);
  reply("later");
  await asking.answer;
  now += 30_000;
  assert.equal(activity.quietFor(30_000), true);

  // Where this computer cannot show a question, there is nothing to wait for.
  assert.equal(activity.asker(() => null)({ title: "", topic: "", body: "", scope: "" }), null);
  assert.equal(activity.quietFor(30_000), true);
});
