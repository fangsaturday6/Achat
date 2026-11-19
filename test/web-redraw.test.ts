import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holdsRedraw, redrawGate } from "../web/redraw.js";

// A page with a menu that opens and closes, the redraws it draws, and what
// waits to run after the current task (setTimeout 0 on the page).
function page() {
  const p = { open: false, drawn: 0, queued: [] as (() => void)[] };
  const gate = redrawGate({ holding: () => p.open, redraw: () => p.drawn++, later: (fn: () => void) => p.queued.push(fn) });
  const settle = () => {
    while (p.queued.length) p.queued.shift()!();
  };
  return { p, gate, settle };
}

describe("an event's redraw", () => {
  test("comes at once while nothing is open", () => {
    const { p, gate } = page();
    gate.request();
    assert.equal(p.drawn, 1);
  });

  test("waits under an open menu, and comes once it is closed", () => {
    const { p, gate, settle } = page();
    p.open = true;
    gate.request();
    gate.request();
    assert.equal(p.drawn, 0);
    p.open = false;
    gate.release();
    assert.equal(p.drawn, 0, "after the click that closed it");
    settle();
    assert.equal(p.drawn, 1, "the events held back draw once");
  });

  test("closing a menu with nothing held back draws nothing", () => {
    const { p, gate, settle } = page();
    gate.release();
    settle();
    assert.equal(p.drawn, 0);
  });

  test("released twice (a menu closed, a field left), it draws once", () => {
    const { p, gate, settle } = page();
    p.open = true;
    gate.request();
    p.open = false;
    gate.release();
    gate.release();
    settle();
    assert.equal(p.drawn, 1);
  });

  test("still held when it comes (another menu opened meanwhile): it waits again", () => {
    const { p, gate, settle } = page();
    p.open = true;
    gate.request();
    gate.release();
    settle();
    assert.equal(p.drawn, 0);
    p.open = false;
    gate.release();
    settle();
    assert.equal(p.drawn, 1);
  });

  test("a redraw the person set off draws what was held: closing a menu then asks for nothing more", () => {
    const { p, gate, settle } = page();
    p.open = true;
    gate.request();
    p.open = false;
    gate.drawing();
    gate.release();
    settle();
    assert.equal(p.drawn, 0);
  });

  test("looks again once its data is in, as a menu may have opened while it fetched", () => {
    const { p, gate, settle } = page();
    assert.equal(gate.holdBack(), false, "nothing open: it draws");
    p.open = true;
    assert.equal(gate.holdBack(), true, "a menu opened: it waits");
    p.open = false;
    gate.release();
    settle();
    assert.equal(p.drawn, 1, "and comes once the menu is closed");
  });
});

test("a field marked data-hold holds the redraw back only while it is being changed", () => {
  assert.equal(holdsRedraw(false, null), false, "no field marked data-hold has the focus");
  assert.equal(holdsRedraw(false, { value: "30", defaultValue: "30" }), false, "only clicked into");
  assert.equal(holdsRedraw(false, { value: "3", defaultValue: "30" }), true, "being changed");
  assert.equal(holdsRedraw(true, null), true, "a menu or panel open");
});
