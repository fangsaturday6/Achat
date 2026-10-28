import assert from "node:assert/strict";
import { test } from "node:test";
import { stableNodePath } from "../src/node-path.js";
import { withoutTables } from "../src/setup.js";

test("Homebrew's versioned node path becomes the link that survives upgrades", () => {
  const exists = (p: string) => p === "/opt/homebrew/opt/node@22/bin/node";
  assert.equal(stableNodePath("/opt/homebrew/Cellar/node@22/22.22.3/bin/node", exists), "/opt/homebrew/opt/node@22/bin/node");
  assert.equal(stableNodePath("/usr/local/Cellar/node/23.1.0/bin/node", exists), "/usr/local/Cellar/node/23.1.0/bin/node");
  assert.equal(stableNodePath("/Users/fang/.nvm/versions/node/v22.1.0/bin/node", exists), "/Users/fang/.nvm/versions/node/v22.1.0/bin/node");
});

test("the old achat tables are replaced and everything else is kept", () => {
  const toml = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.achat]",
    'command = "/opt/homebrew/Cellar/node@22/22.22.3/bin/node"',
    'args = ["/Users/fang/code/Achat/dist/cli.js", "mcp"]',
    "",
    "[mcp_servers.achat.env]",
    'ACHAT_AGENT = "codex@local"',
    "",
    "[mcp_servers.achat2]",
    'command = "x"',
    "",
    "[profiles.work] # comment",
    'model = "o3"',
  ].join("\n");
  const out = withoutTables(toml, "mcp_servers.achat");
  assert.doesNotMatch(out, /Cellar|ACHAT_AGENT|\[mcp_servers\.achat\]/);
  assert.match(out, /^model = "gpt-5"/);
  assert.match(out, /\[mcp_servers\.achat2\]\ncommand = "x"/);
  assert.match(out, /\[profiles\.work\] # comment\nmodel = "o3"$/);
});
