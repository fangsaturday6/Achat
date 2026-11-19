// When an event redraws the page, worked out without touching it: web/app.js
// asks, and test/web-redraw.test.ts checks it in Node.
//
// An event redraws the page, but not under a menu or panel that is open, nor
// while the person is changing a field marked data-hold: the redraw would
// throw that away. It comes once they close it or leave the field.

// Whether a redraw now would throw away what the person is doing: a menu or
// panel is open (`menuOpen`), or `field`, the field marked data-hold that
// has the focus (null when none has), is being changed. A field keeps what
// it first showed as its defaultValue, so one only clicked into, changing
// nothing, holds nothing back.
export function holdsRedraw(menuOpen, field) {
  return menuOpen || (!!field && field.value !== field.defaultValue);
}

// The redraws events ask for. `holding()`: whether one would throw something
// away now (holdsRedraw); `redraw()`: fetch and draw; `later(fn)`: run fn
// once what is going on now is over (after the click that closed a menu).
export function redrawGate({ holding, redraw, later }) {
  let held = false;
  const gate = {
    // An event, or the window's focus, asks for a redraw.
    request() {
      if (holding()) {
        held = true;
        return;
      }
      held = false;
      redraw();
    },
    // Any redraw starts: it draws whatever was held back, so closing a menu
    // after this asks for nothing more.
    drawing() {
      held = false;
    },
    // An event's redraw has its data: whether to hold back after all, since
    // a menu may have opened while it fetched.
    holdBack() {
      if (!holding()) return false;
      held = true;
      return true;
    },
    // A menu closed, or a field marked data-hold left: what was held back
    // comes now, once, however many times this is said.
    release() {
      if (held) later(() => held && gate.request());
    },
  };
  return gate;
}
