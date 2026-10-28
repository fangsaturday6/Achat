import assert from "node:assert/strict";
import { test } from "node:test";
import { autostartPlan } from "../src/autostart.js";

const opts = { node: "/opt/node/bin/node", home: "/Users/fang", path: "/opt/homebrew/bin:/usr/bin", uid: 501 };

test("macOS: a launch agent that keeps `achat start --wait` running", () => {
  const plan = autostartPlan("/Users/fang/Achat/dist/cli.js", { ...opts, os: "darwin" })!;
  assert.equal(plan.path, "/Users/fang/Library/LaunchAgents/local.achat.plist");
  assert.match(
    plan.content,
    /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/Users\/fang\/Achat\/dist\/cli.js<\/string>\s*<string>start<\/string>\s*<string>--wait<\/string>/,
  );
  assert.match(plan.content, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.match(plan.content, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.deepEqual(plan.start, [["launchctl", "bootstrap", "gui/501", plan.path]]);
  assert.deepEqual(plan.stop, [["launchctl", "bootout", "gui/501/local.achat"]]);
});

test("macOS: paths are escaped for the plist", () => {
  const plan = autostartPlan("/Users/fang/A&B <x>/dist/cli.js", { ...opts, os: "darwin" })!;
  assert.match(plan.content, /<string>\/Users\/fang\/A&amp;B &lt;x&gt;\/dist\/cli.js<\/string>/);
});

test("Linux: a systemd user service", () => {
  const plan = autostartPlan("/home/fang/Achat/dist/cli.js", { ...opts, os: "linux", home: "/home/fang" })!;
  assert.equal(plan.path, "/home/fang/.config/systemd/user/achat.service");
  assert.match(plan.content, /^ExecStart="\/opt\/node\/bin\/node" "\/home\/fang\/Achat\/dist\/cli.js" "start" "--wait"$/m);
  assert.match(plan.content, /^Environment="PATH=\/opt\/homebrew\/bin:\/usr\/bin"$/m);
  assert.deepEqual(plan.start.at(-1), ["systemctl", "--user", "enable", "--now", "achat.service"]);
});

test("other systems are not supported yet", () => {
  assert.equal(autostartPlan("C:\\achat\\dist\\cli.js", { ...opts, os: "win32" }), null);
});
