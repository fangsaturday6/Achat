import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { RunningRelay } from "../src/relay/server.js";
import { dialogIcon } from "../src/sidecar/dialog.js";
import { startTestRelay } from "./helpers.js";

describe("the Achat mark", () => {
  let relay: RunningRelay;
  before(async () => ({ relay } = await startTestRelay()));
  after(() => relay.close());

  test("the app links the browser and home-screen icons, and serves them with their types", async () => {
    const html = await (await fetch(`${relay.url}/`)).text();
    for (const [path, type] of [
      ["/brand/favicon-32.png", "image/png"],
      ["/brand/achat-mark.svg", "image/svg+xml"],
      ["/brand/apple-touch-icon.png", "image/png"],
    ]) {
      assert.match(html, new RegExp(`href="${path}"`));
      const res = await fetch(`${relay.url}${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), type, path);
    }
  });

  test("the stylesheet paints the mark from the one SVG", async () => {
    const css = await (await fetch(`${relay.url}/style.css`)).text();
    assert.match(css, /mask: url\(\/brand\/achat-mark\.svg\)/);
  });
});

test("dialogs on the computer show the Achat icon, a request's with 问答 or 动手 in its corner", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (const [kind, name] of [["answer", "icons/ask.png"], ["do", "icons/do.png"], ["app", "brand/achat-icon-512.png"]] as const) {
    const file = dialogIcon(kind);
    assert.ok(file?.endsWith(join("web", name)), `${kind}: ${file}`);
    assert.deepEqual(readFileSync(file).subarray(0, 4), png, `${kind} is a PNG`);
  }
});
