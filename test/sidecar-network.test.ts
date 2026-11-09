import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Sidecar } from "../src/sidecar/sidecar.js";
import type { ThreadDetail } from "../src/types.js";
import { CLAUDE, CODEX, ScriptedRunner, startTestRelay, until } from "./helpers.js";

// What goes wrong with one call: the connection fails, the relay takes the call
// but its reply never arrives, or a gateway answers instead of the relay.
type Fault = "down" | "reply-lost" | number;

// The first calls to an address go wrong as listed; later ones work.
function breakCalls(t: TestContext, method: string, path: RegExp, faults: Fault[]): { attempts: number } {
  const seen = { attempts: 0 };
  const real = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    let fault: Fault | undefined;
    if ((init?.method ?? "GET") === method && path.test(url.pathname + url.search)) {
      seen.attempts += 1;
      fault = faults[seen.attempts - 1];
    }
    if (fault === "down") throw new TypeError("fetch failed");
    if (typeof fault === "number") return new Response("<html>gateway</html>", { status: fault });
    const res = await real(input, init);
    if (fault === "reply-lost") throw new TypeError("fetch failed");
    return res;
  });
  return seen;
}

// A sidecar and a request the person has approved, waiting for its answer.
async function approvedRequest(t: TestContext, replies: (string | Error)[]) {
  const { relay, client, config } = await startTestRelay();
  const runner = new ScriptedRunner(replies);
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: runner },
    notify: () => {},
    webUrl: relay.url,
    relayRetryMs: 1,
    log: () => {},
  });
  t.after(async () => {
    sidecar.stop();
    await relay.close();
  });
  const thread = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "网络", message: "问题" });
  await client.approve(thread.id);
  return { client, runner, sidecar, id: thread.id };
}

function spoken(thread: ThreadDetail): string[] {
  return thread.messages.filter((m) => m.kind !== "system").map((m) => m.body);
}

test("an answer the relay could not take is sent again, without asking the AI twice", async (t) => {
  const { client, runner, sidecar, id } = await approvedRequest(t, ["回答"]);
  const posts = breakCalls(t, "POST", /\/messages$/, ["down", "down"]);

  await sidecar.answer(id);

  assert.equal(posts.attempts, 3);
  assert.equal(runner.calls.length, 1);
  const thread = await client.getThread(id);
  assert.equal(thread.status, "active");
  assert.deepEqual(spoken(thread), ["问题", "回答"]);
});

test("an answer that arrived before its reply was lost does not end the thread", async (t) => {
  const { client, sidecar, id } = await approvedRequest(t, ["回答"]);
  const posts = breakCalls(t, "POST", /\/messages$/, ["reply-lost"]);

  await sidecar.answer(id);

  assert.equal(posts.attempts, 2, "tried again, and the relay said it already has it");
  const thread = await client.getThread(id);
  assert.equal(thread.status, "active");
  assert.deepEqual(spoken(thread), ["问题", "回答"]);
});

test("a failure that could not be reported reaches the asker once the relay is back", async (t) => {
  const { client, sidecar, id } = await approvedRequest(t, [new Error("claude 意外退出")]);
  breakCalls(t, "POST", /\/fail$/, ["down", "down"]);

  await sidecar.answer(id);

  const thread = await client.getThread(id);
  assert.equal(thread.status, "closed");
  assert.ok(thread.messages.some((m) => m.body === "接收方出错：claude 意外退出"));
});

test("a thread is not ended because it could not be read for a moment", async (t) => {
  const { client, sidecar, id } = await approvedRequest(t, ["回答"]);
  await sidecar.answer(id);
  const reads = breakCalls(t, "GET", new RegExp(`/api/threads/${id}$`), ["down", "down"]);

  await sidecar.answer(id);

  assert.equal(reads.attempts, 3);
  assert.equal((await client.getThread(id)).status, "active");
});

for (const status of [429, 502, 503, 504]) {
  test(`HTTP ${status} means come back later, not that the answer failed`, async (t) => {
    const { client, sidecar, id } = await approvedRequest(t, ["回答"]);
    breakCalls(t, "POST", /\/messages$/, [status]);

    await sidecar.answer(id);

    const thread = await client.getThread(id);
    assert.equal(thread.status, "active");
    assert.deepEqual(spoken(thread), ["问题", "回答"]);
  });
}

test("a refusal from the relay is not waited on", async (t) => {
  const { client, sidecar, id } = await approvedRequest(t, ["长".repeat(20001)]);

  await sidecar.answer(id);

  const thread = await client.getThread(id);
  assert.equal(thread.status, "closed");
  assert.ok(thread.messages.some((m) => m.body.startsWith("接收方出错：消息需要在")));
});

test("threads waiting at startup are still picked up when the first look fails", async (t) => {
  const { client, sidecar, id } = await approvedRequest(t, ["回答"]);
  breakCalls(t, "GET", /\/api\/threads\?/, ["down", "down", "down"]);

  sidecar.start();

  await until(async () => spoken(await client.getThread(id)).includes("回答"));
});

test("the person's approval is delivered even if the first try fails", async (t) => {
  const { relay, client, config } = await startTestRelay();
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: new ScriptedRunner(["回答"]) },
    ask: () => ({ answer: Promise.resolve("approve"), close: () => {} }),
    notify: () => {},
    webUrl: relay.url,
    relayRetryMs: 1,
    log: () => {},
  });
  t.after(async () => {
    sidecar.stop();
    await relay.close();
  });
  const approvals = breakCalls(t, "POST", /\/approve$/, ["down", "down"]);

  sidecar.start();
  const { id } = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "批准", message: "问题" });

  await until(async () => spoken(await client.getThread(id)).includes("回答"));
  assert.equal(approvals.attempts, 3);
});

test("stopping while the relay is out of reach leaves the thread for the next start", async (t) => {
  const { client, sidecar, id } = await approvedRequest(t, ["回答"]);
  const posts = breakCalls(t, "POST", /\/messages$/, Array<Fault>(1000).fill("down"));

  const answering = sidecar.answer(id);
  await until(async () => posts.attempts >= 2);
  sidecar.stop();
  await answering;

  assert.equal((await client.getThread(id)).status, "active");
});
