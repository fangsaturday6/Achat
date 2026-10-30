import assert from "node:assert/strict";
import { test } from "node:test";
import { stableNodePath } from "../src/node-path.js";
import { withoutTables, withReminderHook, withTomlKey } from "../src/setup.js";

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

test("hooks for Codex need its hooks feature on, without touching other settings", () => {
  assert.equal(withTomlKey("", "features", "hooks", "true"), "[features]\nhooks = true\n");
  assert.equal(withTomlKey('model = "gpt-5"\n', "features", "hooks", "true"), 'model = "gpt-5"\n\n[features]\nhooks = true\n');
  const toml = ['model = "gpt-5"', "", "[features]", "web_search = true", "hooks = false", "", "[profiles.work]", "hooks = 1"].join("\n");
  const out = withTomlKey(toml, "features", "hooks", "true");
  assert.match(out, /\[features\]\nweb_search = true\nhooks = true\n/);
  assert.match(out, /\[profiles\.work\]\nhooks = 1$/);
  assert.match(withTomlKey("[features]\nweb_search = true", "features", "hooks", "true"), /^\[features\]\nhooks = true\nweb_search = true$/);
});

test("the reminder hook replaces older Achat reminders and keeps the person's own hooks", () => {
  const settings = {
    model: "opus",
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: '"/opt/node" "/Users/fang/code/Achat/dist/cli.js" hook user-prompt --agent claude@local' }] },
        { hooks: [{ type: "command", command: "my-own-hook" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  };
  const out = withReminderHook(settings, '"/opt/node" "/Users/fang/.achat/app/dist/cli.js" hook user-prompt --agent claude@local');
  assert.equal(out.model, "opus");
  assert.deepEqual(out.hooks!.Stop, settings.hooks.Stop);
  assert.deepEqual(
    out.hooks!.UserPromptSubmit.map((e) => e.hooks[0].command),
    ["my-own-hook", '"/opt/node" "/Users/fang/.achat/app/dist/cli.js" hook user-prompt --agent claude@local'],
  );
});
