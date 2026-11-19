import assert from "node:assert/strict";
import { test } from "node:test";
import { startTestCloud, startTestRelay } from "./helpers.js";

// Node closes an idle connection after 5 seconds, and fetch reuses one until
// shortly before that; on a busy machine a pause of a second or two between
// requests had the next one sent on a connection the server was closing
// ("fetch failed"). Both servers keep idle connections for 30 seconds.
test("the relay and the cloud keep an idle connection open for 30 seconds", async () => {
  const { relay, config } = await startTestRelay();
  const { cloud } = await startTestCloud();
  try {
    const local = await fetch(`${relay.url}/api/health`, { headers: { "x-achat-token": config.token } });
    await local.arrayBuffer();
    assert.equal(local.headers.get("keep-alive"), "timeout=30");
    const online = await fetch(`${cloud.url}/api/health`);
    await online.arrayBuffer();
    assert.equal(online.headers.get("keep-alive"), "timeout=30");
  } finally {
    await relay.close();
    await cloud.close();
  }
});
