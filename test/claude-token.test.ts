import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findToken } from "../src/claude-token.js";
import { onPath } from "../src/which.js";

const cli = [
  "--no-warnings=ExperimentalWarning",
  "--import",
  "tsx",
  join(import.meta.dirname, "..", "src", "cli.ts"),
];

// A made-up credential in the shape `claude setup-token` prints; not anyone's.
const CREDENTIAL = "sk-ant-oat01-" + "Ab3_x-".repeat(15) + "Zz9";

// What `claude setup-token` prints once the person has authorized.
function screen(token: string): string {
  return (
    "\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\n" +
    "Your OAuth token (valid for 1 year):\r\n\r\n" +
    token +
    "\r\n\r\n\x1b[33mStore this token securely. You won't be able to see it again.\x1b[39m\r\n"
  );
}

test("finds the credential claude setup-token printed, also when the terminal wrapped it", () => {
  assert.equal(findToken(screen(CREDENTIAL)), CREDENTIAL);
  const wrapped = [CREDENTIAL.slice(0, 44), CREDENTIAL.slice(44, 88), CREDENTIAL.slice(88)].join("\r\n");
  assert.equal(findToken(screen(wrapped)), CREDENTIAL);
  assert.equal(findToken(`  ${CREDENTIAL}            (c to copy)\nStore this token securely.\n`), CREDENTIAL);
  assert.equal(findToken("OAuth error: Socket is closed\n"), null);
});

// A stand-in for Anthropic: accepts only CREDENTIAL, used the way Claude Code uses it.
async function anthropic(): Promise<{ url: string; seen: IncomingMessage[]; close: () => void }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    const ok = req.headers.authorization === `Bearer ${CREDENTIAL}` && req.headers["anthropic-beta"] === "oauth-2025-04-20";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
}

function run(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [...cli, "claude-token", ...args], { env: { ...process.env, ...env } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.stdin.end(input ?? "");
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

function home(): { ACHAT_HOME: string; ACHAT_KEYSTORE: string; saved: () => string | null } {
  const dir = mkdtempSync(join(tmpdir(), "achat-token-test-"));
  const file = join(dir, "claude-token");
  return {
    ACHAT_HOME: dir,
    ACHAT_KEYSTORE: "file",
    saved: () => (existsSync(file) ? readFileSync(file, "utf8").trim() : null),
  };
}

test(
  "claude-token keeps the credential claude setup-token printed, without copying, once Anthropic accepts it",
  { skip: !onPath("script") && "needs the script command" },
  async () => {
    const api = await anthropic();
    const h = home();
    const bin = join(h.ACHAT_HOME, "claude");
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nif (process.argv[2] !== "setup-token") process.exit(2);\nprocess.stdout.write(${JSON.stringify(screen(CREDENTIAL))});\n`,
    );
    chmodSync(bin, 0o755);
    try {
      const { code, out } = await run([], { ...h, ACHAT_CLAUDE_BIN: bin, ACHAT_ANTHROPIC_URL: api.url });
      assert.equal(code, 0, out);
      assert.match(out, /已保存。/);
      assert.equal(h.saved(), CREDENTIAL);
      assert.equal(api.seen.length, 1);
    } finally {
      api.close();
    }
  },
);

test("a pasted credential Anthropic does not accept is not kept", async () => {
  const api = await anthropic();
  const h = home();
  try {
    const half = CREDENTIAL.slice(0, 60);
    const { code, out } = await run(["--paste"], { ...h, ACHAT_ANTHROPIC_URL: api.url }, `${half}\n`);
    assert.equal(code, 1);
    assert.match(out, /Anthropic 不认这个凭证/);
    assert.equal(h.saved(), null);

    // The whole setup-token output piped in, wrapped by a narrow terminal, is fine.
    const wrapped = [CREDENTIAL.slice(0, 44), CREDENTIAL.slice(44, 88), CREDENTIAL.slice(88)].join("\n");
    const ok = await run(["--paste"], { ...h, ACHAT_ANTHROPIC_URL: api.url }, screen(wrapped));
    assert.equal(ok.code, 0, ok.out);
    assert.equal(h.saved(), CREDENTIAL);
  } finally {
    api.close();
  }
});

test("when Anthropic cannot be reached, the credential is kept and that is said", async () => {
  const h = home();
  const { code, out } = await run(["--paste"], { ...h, ACHAT_ANTHROPIC_URL: "http://127.0.0.1:1" }, `${CREDENTIAL}\n`);
  assert.equal(code, 0, out);
  assert.match(out, /没能确认凭证可用/);
  assert.equal(h.saved(), CREDENTIAL);
});
