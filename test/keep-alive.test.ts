import assert from "node:assert/strict";
import { test } from "node:test";
import { startTestCloud, startTestRelay } from "./helpers.js";

// Node closes an idle connection after 5 seconds, and fetch reuses one until
// shortly before that; on a busy machine a pause of a second or two between
// requests had the next one sent on a connection the server was closing
// ("fetch failed"). Caddy in front of the cloud keeps an idle connection to it
// for 2 minutes, so both servers keep theirs a little longer: 125 seconds.
test("the relay and the cloud keep an idle connection open for longer than Caddy in front of them does", async () => {
  const { relay, config } = await startTestRelay();
  const { cloud } = await startTestCloud();
  try {
    const local = await fetch(`${relay.url}/api/health`, { headers: { "x-achat-token": config.token } });
    await local.arrayBuffer();
    assert.equal(local.headers.get("keep-alive"), "timeout=125");
    const online = await fetch(`${cloud.url}/api/health`);
    await online.arrayBuffer();
    assert.equal(online.headers.get("keep-alive"), "timeout=125");
  } finally {
    await relay.close();
    await cloud.close();
  }
});
