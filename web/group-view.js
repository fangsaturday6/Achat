// 群 on the page, as in WeChat's group chats: its row in 消息, the group,
// 群设置, 发起群聊 and 邀请, and the invite card. What these show is worked
// out in web/groups.js; web/app.js routes to them and lends the building
// blocks they are drawn with. The two import each other, so nothing here
// may use what comes from web/app.js before the page starts (only inside
// functions). The ids are the ones docs/ui.md lists for AI Agents.
import {
  act,
  api,
  avatar,
  busy,
  clientAvatar,
  closeOpenMenu,
  cloud,
  faceOwner,
  fileTile,
  groupAvatar,
  h,
  icon,
  item,
  loadPeople,
  myAccount,
  myName,
  mySeat,
  openMenu,
  popup,
  refresh,
  shortTime,
  showMain,
  state,
  toast,
  whose,
  writerOf,
  writers,
} from "./app.js";
import {
  ALL,
  applyPick,
  composeMessage,
  GROUP_STATUS_LABELS,
  groupPath,
  groupPreview,
  inviteChoices,
  inviteEmpty,
  isAnswering,
  isPicked,
  leaveNote,
  loadedGroups,
  mentionAt,
  openingProblem,
  pickerOptions,
  pickerRows,
  pickProblem,
  QUOTA,
  quotaLine,
  quotaOf,
  quotaProblem,
  RECEIPT_LABELS,
  receiptLine,
  segments,
  sentByMe,
  settingsTiles,
  settingsView,
  tagsOf,
  targetsOf,
  tileActions,
  timeBreaks,
  todayTotal,
  togglePick,
  usedText,
  whoIn,
} from "./groups.js";
import { cjk, isOwn, ownerName } from "./text.js";

// Wide enough for 群设置 beside the group, not over it (style.css says the same).
const BESIDE = matchMedia("(min-width: 1080px)");

// --- 消息: a group's row, and loading the groups

// A group in 消息: its 四宫格 with a red dot for new words (never a number),
// its name, and the latest words, or the invite waiting in red.
export function groupRow(g, current) {
  const { pending, text } = groupPreview(g);
  const dot = g.role === "member" && g.unread ? h("span", { class: "dot-new", role: "img", "aria-label": "有新消息" }) : null;
  return item(`#/g/${encodeURIComponent(g.id)}`, current, h("span", { class: "avatar-wrap" }, groupAvatar(g.faces, 40), dot), g.name, {
    id: `group-${g.id}`,
    sub: [pending ? h("span", { class: "tag-pending" }, "[待加入] ") : null, text],
    time: g.status === "open" ? shortTime(g.updatedAt) : GROUP_STATUS_LABELS[g.status],
  });
}

// Groups need an account: only the cloud has them. Fetched alongside the
// conversations; what fails keeps what was shown (loadedGroups). Returns
// whether the group in the address is one the person cannot open: the one
// way back to 消息 from a group, whether they left it, were removed from it,
// or followed a wrong link.
export async function loadGroups(r) {
  if (!cloud) {
    state.groups = [];
    state.group = null;
    return false;
  }
  const [list, one] = await Promise.allSettled([api("GET", groupPath()), r.group ? api("GET", groupPath(r.group)) : null]);
  const { groups, group, gone } = loadedGroups(state, r.group, list, one);
  state.groups = groups;
  state.group = group;
  const shown = group && groups.find((g) => g.id === group.id);
  // Read once it is on screen, as a conversation is.
  if (shown?.unread && shown.role === "member" && document.visibilityState === "visible") {
    shown.unread = false;
    void api("POST", groupPath(shown.id, "read"), {}).catch(() => {});
  }
  return gone;
}

// --- a group

// Words with each @ in blue, named from the person's side.
function withAts(body, mentions, names) {
  return segments(body, tagsOf(mentions, names, { name: myName(), seat: mySeat() })).map((s) => (s.at ? h("span", { class: "at" }, s.text) : s.text));
}

// A group: its messages, each @ in blue, under each who did not reply, and
// the box to write in; 群设置 slides over on the right (#/g/<id>/settings).
export function renderGroup(g, r) {
  if (g.role === "invited") return renderInvite(g);
  const main = document.getElementById("main");
  // A redraw of the same group keeps the place the person was reading,
  // unless they were at the bottom, where the newest stays in view, or have
  // just sent something, which they see as in WeChat.
  const old = main.dataset.group === g.id ? main.querySelector(".main-body") : null;
  // The box is the same one across redraws (writers); a dissolved group is only read.
  const writer = groupWriter(g);
  const sent = !!writer?.sent;
  const stick = !old || sent || old.scrollHeight - old.scrollTop - old.clientHeight < 80;
  const keep = old?.scrollTop ?? 0;
  // 群设置 stays where it was scrolled to, as well, and what had the focus in it keeps it.
  const oldDrawer = old && main.querySelector("#group-settings");
  const keepDrawer = oldDrawer?.scrollTop ?? 0;
  const focusedIn = oldDrawer?.contains(document.activeElement) ? document.activeElement.id : "";
  const more = h(
    "a",
    {
      class: `icon-btn group-more${r.settings ? " on" : ""}`,
      id: "group-settings-btn",
      href: `#/g/${encodeURIComponent(g.id)}${r.settings ? "" : "/settings"}`,
      "aria-label": r.settings ? "关上群设置" : "群设置",
      "aria-expanded": String(r.settings),
    },
    icon("more", 20),
  );
  const foot = writer?.foot ?? h("footer", { class: "main-foot" }, h("span", { class: "muted" }, GROUP_STATUS_LABELS.dissolved));
  const body = showMain(`${g.name}（${g.members.length}）`, groupLog(g, !r.settings), { right: more, foot, back: "#/", drop: writer?.take });
  main.dataset.group = g.id;
  if (writer) writer.sent = false;
  foot.classList.toggle("beside-drawer", r.settings);
  if (r.settings) {
    body.classList.add("beside-drawer");
    const drawer = groupSettings(g);
    main.append(drawer);
    drawer.scrollTop = keepDrawer;
    if (focusedIn) document.getElementById(focusedIn)?.focus({ preventScroll: true });
    // In a window too narrow for both side by side, 群设置 lies over the
    // group: a click on the group left of it closes it, as in WeChat.
    body.addEventListener(
      "click",
      (e) => {
        if (BESIDE.matches) return;
        e.preventDefault();
        e.stopPropagation();
        location.hash = `#/g/${encodeURIComponent(g.id)}`;
      },
      { capture: true },
    );
  }
  body.scrollTop = stick ? body.scrollHeight : keep;
  for (const img of body.querySelectorAll("img")) img.addEventListener("load", () => stick && (body.scrollTop = body.scrollHeight), { once: true });
}

// The messages of a group, a time before the first and after each pause.
// `withError`: what went wrong shows here, unless 群设置 shows it.
function groupLog(g, withError = true) {
  const breaks = timeBreaks(g.messages);
  const log = h("div", { class: "log", role: "log", "aria-label": "群消息" });
  for (const m of g.messages) {
    if (breaks.has(m.seq)) log.append(h("span", { class: "event" }, shortTime(m.createdAt)));
    log.append(m.kind === "system" ? h("span", { class: "event" }, m.body) : groupMessage(g, m));
  }
  if (withError && state.error) log.append(h("p", { class: "error", role: "alert" }, state.error));
  return log;
}

// Whom an AI or a seat in a group belongs to, by name, for its face: the
// person's own name for what shows on the right (sentByMe), else as whoIn
// finds it; one known only by its name (`name`), by that.
function groupOwnerOf(g, id, name = g.names[id] ?? "") {
  if (sentByMe(id, g, myAccount(), state.agents)) return myName();
  return whose(whoIn(id, g, state.agents)) || ownerName(name);
}

// One message: who said it (the person's own on the right), the words, its
// files, and under it who did not reply.
function groupMessage(g, m) {
  const name = g.names[m.sender] ?? "已移除的 AI";
  const words = m.body ? h("div", { class: "bubble" }, ...withAts(m.body, m.mentions, g.names)) : null;
  const said = words && m.redactions > 0 ? h("div", { class: "bubble-wrap" }, words, h("span", { class: "muted" }, `已过滤 ${m.redactions} 处`)) : words;
  return h(
    "div",
    { class: `msg${sentByMe(m.sender, g, state.me.account.id, state.agents) ? " right" : ""}`, "data-seq": String(m.seq) },
    avatar(groupOwnerOf(g, m.sender), 34),
    h("div", { class: "msg-col" }, h("span", { class: "msg-name" }, name), said, ...m.files.map(fileTile), receiptsUnder(g, m)),
  );
}

// The gray line under a message; when there is more to say, a click shows
// each AI's state and why, until a click elsewhere or Esc.
function receiptsUnder(g, m) {
  const line = receiptLine(m.receipts, g.names);
  if (!line) return null;
  const spin = line.reading ? h("span", { class: "spinner small", "aria-hidden": "true" }) : null;
  if (!line.open) return h("span", { class: "receipts" }, spin, line.text);
  const id = `receipts-${m.seq}`;
  const button = h("button", { type: "button", class: "receipts", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": id }, spin, line.text, icon("down", 12, 2));
  button.addEventListener("click", () => {
    if (closeOpenMenu) return closeOpenMenu();
    const rows = line.items.map((i) =>
      h(
        "div",
        { class: "receipt-row", "data-agent": i.agent },
        avatar(groupOwnerOf(g, i.agent, i.name), 28),
        h(
          "span",
          { class: "item-text" },
          h("span", { class: "item-row" }, h("span", { class: "item-name" }, i.name), h("span", { class: "item-time" }, RECEIPT_LABELS[i.state])),
          i.reason ? h("span", { class: "item-sub" }, i.reason) : null,
        ),
      ),
    );
    popup(button, button.parentElement, h("div", { class: "menu receipts-panel", role: "dialog", id, "aria-label": "没有回复的 AI" }, ...rows));
  });
  return button;
}

// A group's 四宫格 faces, from its row in 消息.
function facesOf(g) {
  return state.groups.find((x) => x.id === g.id)?.faces ?? [];
}

// The bottom of a group: the box to write in (writers), the person's 每天次数
// on the left, 叫停 or 继续 on the right, and the list under "@". Null once
// dissolved: the group is only read, and its box goes.
function groupWriter(g) {
  const key = `g:${g.id}`;
  if (g.status === "dissolved") {
    writers.drop(key);
    return null;
  }
  const w = writerOf(key, groupComposer);
  w.update(g);
  return w;
}

function groupComposer(w) {
  let g = null;
  w.box.id = "group-input";
  w.button.id = "group-send";
  w.foot.classList.add("group-foot");
  const picker = mentionPicker(w.box, () => g);
  w.foot.append(picker.el);
  const send = async (text, files) => {
    const { body, mentions } = composeMessage(text, g.members, myName());
    await api("POST", groupPath(g.id, "messages"), { from: mySeat(), body, mentions, files });
    w.sent = true;
    await refresh();
  };
  return Object.assign(w, {
    // Just sent: the next redraw goes to the bottom (renderGroup).
    sent: false,
    update(next) {
      g = next;
      w.show({ label: `发到${g.name}`, status: groupStatus(g), extra: groupAction(g), send });
      picker.refresh();
    },
  });
}

// The list under "@", typed in the box: 所有人 and the AIs in the group.
// ↑↓ move, Return or Tab picks, Esc closes; a pick writes "@名字 ". The list
// follows the caret when it moves without typing (a click, ←→, Home, End),
// and with nothing there to pick, Return and Tab do what they always do.
function mentionPicker(box, groupOf) {
  const el = h("div", { class: "menu mention-picker", role: "listbox", id: "mention-picker", "aria-label": "选择要 @ 的 AI", hidden: true });
  let options = [];
  // The AI lit, by id, so a redraw that reorders the list keeps it; null when
  // none shown can be picked.
  let active = null;
  const close = () => {
    options = [];
    el.hidden = true;
    box.removeAttribute("aria-activedescendant");
  };
  const pick = (o) => {
    const next = applyPick(box.value, box.selectionStart, o.name);
    close();
    if (!next) return;
    box.value = next.value;
    box.setSelectionRange(next.caret, next.caret);
    box.focus();
  };
  const paint = () => {
    el.replaceChildren(
      ...options.map((o, i) => {
        const on = o.id === active;
        const row = h(
          "div",
          { class: `mention-option${on ? " on" : ""}`, role: "option", id: `mention-${i}`, "data-agent": o.id, "aria-selected": String(on), "aria-disabled": o.disabled ? "true" : null },
          o.id === ALL ? groupAvatar(facesOf(groupOf()), 28) : avatar(groupOwnerOf(groupOf(), o.id, o.name), 28),
          h("span", { class: "grow" }, o.name),
          o.note ? h("span", { class: "muted" }, o.note) : null,
        );
        // mousedown, so the box keeps its focus and caret.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (!o.disabled) pick(o);
        });
        return row;
      }),
    );
    const lit = options.findIndex((o) => o.id === active);
    if (lit >= 0) box.setAttribute("aria-activedescendant", `mention-${lit}`);
    else box.removeAttribute("aria-activedescendant");
  };
  // What fits the @ just before the caret, as it is now.
  const refresh = () => {
    const at = mentionAt(box.value, box.selectionStart);
    options = at ? pickerOptions(groupOf().members, state.me.account.id, at.query) : [];
    if (!options.length) return close();
    if (!options.some((o) => o.id === active && !o.disabled)) active = options.find((o) => !o.disabled)?.id ?? null;
    el.hidden = false;
    paint();
  };
  box.addEventListener("input", () => {
    active = null;
    refresh();
  });
  const follow = () => !el.hidden && refresh();
  box.addEventListener("click", follow);
  box.addEventListener("keyup", (e) => ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key) && follow());
  // Ahead of writeBox's own Return, which would send.
  box.addEventListener(
    "keydown",
    (e) => {
      if (el.hidden || e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        return close();
      }
      if (!["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) return;
      refresh();
      const lit = options.findIndex((o) => o.id === active);
      if (lit < 0) return close();
      e.preventDefault();
      if (e.key === "Enter" || e.key === "Tab") {
        e.stopImmediatePropagation();
        return pick(options[lit]);
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      for (let i = 1; i < options.length; i++) {
        const next = options[(lit + step * i + options.length) % options.length];
        if (!next.disabled) {
          active = next.id;
          break;
        }
      }
      paint();
    },
    { capture: true },
  );
  // Closes when the focus leaves the box; the window losing the focus keeps it.
  box.addEventListener("blur", () => document.activeElement !== box && close());
  return { el, refresh: follow };
}

// Left of the buttons: 已叫停, or the person's AI nearest its 每天次数, which opens 群设置.
function groupStatus(g) {
  if (g.status === "stopped") return [h("span", { class: "stopped" }, icon("pause", 14, 2), GROUP_STATUS_LABELS.stopped)];
  const q = quotaLine(g.members, state.me.account.id);
  if (!q) return [];
  return [h("a", { class: `quota-link${q.full ? " full" : ""}`, id: "group-quota-link", href: `#/g/${encodeURIComponent(g.id)}/settings` }, q.text)];
}

// 叫停 while some AI is reading; 继续 once stopped. Each is pressed once
// until the relay answers.
function groupAction(g) {
  const button = (id, cls, label, to) => {
    const b = h("button", { type: "button", class: cls, id }, label);
    b.addEventListener("click", busy(b, () => act(() => api("POST", groupPath(g.id, to), {}))));
    return b;
  };
  if (g.status === "stopped") return [button("group-continue", "btn", "继续", "continue")];
  if (isAnswering(g)) return [button("group-stop", "btn danger", "叫停", "stop")];
  return [];
}

// 群设置: who is in the group and who is invited, its name, how many times a
// day each of the person's AIs may be woken here, and leaving or ending it.
function groupSettings(g) {
  const view = settingsView(g, state.me.account.id);
  const invite = view.invite
    ? h(
        "div",
        { class: "member-cell" },
        h(
          "button",
          { type: "button", class: "member", id: "group-invite", onclick: () => void openGroupPicker({ group: g }) },
          h("span", { class: "member-add", "aria-hidden": "true" }, icon("plus", 18, 1.8)),
          h("span", { class: "muted" }, "邀请"),
        ),
      )
    : null;
  const grid = h("div", { class: "member-grid" }, ...settingsTiles(g, state.me.account.id).map((t) => memberTile(g, t)), invite);
  const quotas = view.quotas.length
    ? h("section", { class: "my-ais", "aria-labelledby": "my-ais-title" }, h("h2", { id: "my-ais-title", class: "muted" }, "我的 AI"), ...view.quotas.map((m) => quotaRow(g, m)))
    : null;
  const leave = view.leave ? h("button", { type: "button", class: "btn danger", id: "group-leave", onclick: () => leaveGroup(g, view.mine.map((m) => m.agent)) }, "退出群") : null;
  const dissolve = view.dissolve
    ? h(
        "button",
        {
          type: "button",
          class: "btn danger",
          id: "group-dissolve",
          onclick: () => {
            if (confirm("解散后群里只能看不能发，AI 也不会再被叫醒。")) void act(() => api("POST", groupPath(g.id, "dissolve"), {}));
          },
        },
        "解散群",
      )
    : null;
  return h(
    "aside",
    { class: "group-settings", id: "group-settings", "aria-label": "群设置" },
    grid,
    groupNameRow(g, view.rename),
    quotas,
    state.error ? h("p", { class: "error", id: "group-settings-error", role: "alert" }, state.error) : null,
    h("span", { class: "spacer" }),
    h("div", { class: "settings-actions" }, leave, dissolve),
  );
}

// One member in 群设置 (#group-member-<AI>, or #group-invite-<invite> while
// 等加入): its face and name; a click offers what the person may do with it.
function memberTile(g, t) {
  const label = [
    h("span", { class: `member-face${t.waiting ? " waiting" : ""}` }, avatar(whose(t.who), 44)),
    h("span", { class: "member-name" }, t.name),
    t.waiting ? h("span", { class: "muted" }, "等加入") : null,
  ];
  const data = t.waiting ? { id: `group-invite-${t.id}`, "data-invite": t.id } : { id: `group-member-${t.id}`, "data-agent": t.id };
  const cell = h("div", { class: "member-cell" });
  const actions = tileActions(t, g, state.me.account.id);
  if (!actions.length) {
    cell.append(h("div", { class: "member", ...data }, ...label));
    return cell;
  }
  const remove = () => {
    if (confirm(cjk("移出后", t.name, "不会再被叫醒。"))) void act(() => api("POST", groupPath(g.id, "remove"), { agent: t.id }));
  };
  // The invite asks for one AI by name: accepting brings in that one.
  const answer = (action, body) => void act(() => api("POST", groupPath(g.id, "invites", t.id, action), body));
  const items = {
    leave: ["退出群聊", () => leaveGroup(g, [t.id]), { danger: true, id: "member-leave" }],
    remove: ["移出群聊", remove, { danger: true, id: "member-remove" }],
    join: ["加入群聊", () => answer("accept", { agents: [t.agent] }), { id: "member-join" }],
    decline: ["拒绝", () => answer("decline", {}), { id: "member-decline" }],
  };
  const button = h("button", { type: "button", class: "member", ...data, "aria-haspopup": "menu", "aria-expanded": "false" }, ...label);
  button.addEventListener("click", () => (closeOpenMenu ? closeOpenMenu() : openMenu(button, cell, actions.map((a) => items[a]))));
  cell.append(button);
  return cell;
}

// 群名: 群主 clicks it to change it right there. Return, or leaving the box,
// saves it, as 每天次数 does; Esc puts it back, and so does the same name or
// none. Then the row has the focus again.
function groupNameRow(g, editable) {
  const value = h("span", { class: "muted name-value" }, g.name, editable ? icon("right", 12, 2) : null);
  if (!editable) return h("div", { class: "settings-row", id: "group-name" }, h("span", {}, "群名"), value);
  const row = h("button", { type: "button", class: "settings-row", id: "group-name" }, h("span", {}, "群名"), value);
  row.addEventListener("click", () => {
    const input = h("input", { class: "input", id: "group-name-input", value: g.name, maxlength: "30", "aria-label": "群名", "data-hold": "" });
    const editing = h("div", { class: "settings-row editing" }, input);
    // Once: taking the box away blurs it, which comes back here.
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== g.name) {
        void act(() => api("POST", groupPath(g.id, "rename"), { name })).then(() => document.getElementById("group-name")?.focus());
        return;
      }
      editing.replaceWith(row);
      row.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter");
      }
    });
    // The window losing the focus leaves the box as it is.
    input.addEventListener("blur", () => document.activeElement !== input && finish(true));
    row.replaceWith(editing);
    input.focus();
    input.select();
  });
  return row;
}

// One of the person's AIs in 群设置: 每天几次 (Return, or leaving the box,
// saves it), a bar of today so far, and the count.
function quotaRow(g, m) {
  const input = h("input", { class: "quota-box", id: `group-quota-${m.agent}`, type: "text", inputmode: "numeric", value: String(m.quota), "aria-label": cjk(m.name, "每天最多被叫醒几次"), "data-hold": "" });
  input.addEventListener("change", () => {
    const problem = quotaProblem(input.value);
    if (problem) {
      state.error = problem;
      input.value = String(m.quota);
      return void refresh();
    }
    const perDay = quotaOf(input.value);
    if (perDay !== m.quota) void act(() => api("POST", groupPath(g.id, "quota"), { agent: m.agent, perDay }));
  });
  // What went wrong last time goes once the person types again.
  input.addEventListener("input", () => {
    if (!state.error) return;
    state.error = "";
    document.getElementById("group-settings-error")?.remove();
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && input.blur());
  const total = todayTotal(m);
  const used = Math.min(100, Math.round((m.usedToday / total) * 100));
  return h(
    "div",
    { class: "quota-row", "data-agent": m.agent },
    h(
      "div",
      { class: "with-avatar" },
      clientAvatar(state.agents.get(m.agent)?.client, 28),
      h("span", { class: "grow" }, m.name),
      h("label", { class: "muted quota-label", for: input.id }, "每天", input, "次"),
    ),
    h(
      "div",
      { class: `progress${m.usedToday >= total ? " full" : ""}`, role: "progressbar", "aria-label": cjk(m.name, usedText(m)), "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(m.usedToday) },
      h("span", { style: `width:${used}%` }),
    ),
    h("span", { class: "muted" }, usedText(m)),
  );
}

// Some of the person's AIs leave, from 退出群 or a tile, once they agree to
// what follows (leaveNote). With the last of them the person cannot open the
// group any more, and the refresh after goes back to 消息 (loadGroups).
function leaveGroup(g, agents) {
  if (!confirm(leaveNote(g, state.me.account.id, agents))) return;
  void act(async () => {
    for (const agent of agents) await api("POST", groupPath(g.id, "leave"), { agent });
  });
}

// 发起群聊, and 邀请 in 群设置: the person's own AIs and friends on the left
// (a friend opens to show their AIs, to invite just one), what is picked on
// the right. A friend picked as a person chooses their AIs ("他来选 AI");
// in 邀请, who is invited already shows 等加入 (pickerRows). A new group
// picked again starts from what was picked before. The one dialog wider
// than 380px (docs/ui.md). One at a time: a second click while the first
// is loading opens nothing more.
let pickerOpening = false;

export async function openGroupPicker({ group } = {}) {
  if (pickerOpening || document.getElementById("group-picker")) return;
  pickerOpening = true;
  try {
    await loadPeople();
  } catch (err) {
    return void toast(err.message);
  } finally {
    pickerOpening = false;
  }
  const me = state.me.account.id;
  const rowsOf = (query, opened) => pickerRows({ me, agents: [...state.agents.values()], contacts: state.contacts, group, query, opened });
  const draft = group ? null : state.newGroup;
  // A new group starts with the person's first AI that can answer: a group needs one of theirs.
  const first = group || draft ? null : rowsOf("", new Set()).find((r) => r.kind === "ai" && !r.item.speaksOnly)?.item;
  let picked = draft?.picked ?? (first ? [first] : []);
  let query = "";
  const opened = new Set();
  // A friend has their face; an AI its person's, the person's own its mark.
  const face = (p) => (p.person ? avatar(p.name, 28) : isOwn(p, me) ? clientAvatar(p.client, 28) : avatar(whose(p), 28));
  const list = h("div", { class: "picker-list" });
  const chosen = h("div", { class: "picker-picked" });
  const count = h("span", { class: "muted picker-count" });
  const error = h("p", { class: "error", role: "alert", id: "group-picker-error" });
  const search = h("input", { type: "search", id: "group-picker-search", placeholder: "搜索", "aria-label": "搜索朋友和 AI" });
  const done = h("button", { type: "button", class: "btn primary", id: "group-picker-done" }, "完成");
  const cancel = h("button", { type: "button", class: "btn", id: "group-picker-cancel" }, "取消");
  const closeButton = h("button", { type: "button", class: "icon-btn", id: "group-picker-close", "aria-label": "关闭" }, icon("close", 18, 1.8));
  // Every change to what is picked: what went wrong with the last 完成 goes.
  const change = (next) => {
    picked = next;
    error.textContent = "";
    paint();
  };
  // A friend or an AI to tick (#pick-person-<account>, #pick-<AI>), or 等加入.
  const choice = ({ item, waiting, indent }) => {
    const box = h("input", { type: "checkbox", id: item.person ? `pick-person-${item.person}` : `pick-${item.agent}`, checked: !waiting && isPicked(picked, item), disabled: waiting });
    box.addEventListener("change", () => change(togglePick(picked, item)));
    const note = waiting ? "等加入" : item.speaksOnly ? "只能发言" : null;
    return h("label", { class: `pick${indent ? " indent" : ""}${waiting ? " invited" : ""}` }, box, face(item), h("span", { class: "grow" }, item.name), note ? h("span", { class: "muted" }, note) : null);
  };
  // A friend, with the arrow (#pick-open-<account>) that shows or hides their AIs.
  const personRow = (row) => {
    const id = row.item.person;
    const open = row.toggle === "open";
    const arrow = row.toggle
      ? h("button", { type: "button", class: "icon-btn", id: `pick-open-${id}`, "aria-label": `${open ? "收起" : "展开"}${row.item.name}的 AI`, "aria-expanded": String(open) }, icon(open ? "down" : "right", 12, 2))
      : null;
    arrow?.addEventListener("click", () => {
      if (open) opened.delete(id);
      else opened.add(id);
      paint();
    });
    return h("div", { class: "pick-row" }, choice(row), arrow);
  };
  // What is picked, each with its × (#unpick-<AI>, #unpick-person-<account>).
  const pickedRow = (p) => {
    const x = h("button", { type: "button", class: "icon-btn", id: p.person ? `unpick-person-${p.person}` : `unpick-${p.agent}`, "aria-label": `去掉${p.name}` }, icon("close", 12, 2));
    x.addEventListener("click", () => change(togglePick(picked, p)));
    return h("div", { class: "pick-row", "data-agent": p.agent ?? null, "data-person": p.person ?? null }, face(p), h("span", { class: "grow" }, p.name), p.person ? h("span", { class: "muted" }, "他来选 AI") : null, x);
  };
  // Drawn anew on each change; the control that had the focus has it again,
  // found by its id, or the search box once it is gone (an × taken away).
  function paint() {
    const focused = overlay?.contains(document.activeElement) ? document.activeElement.id : "";
    list.replaceChildren(...rowsOf(query, opened).map((r) => (r.kind === "head" ? h("span", { class: "muted picker-head" }, r.text) : r.kind === "person" ? personRow(r) : choice(r))));
    const label = `已选 ${picked.length} 个`;
    count.textContent = label;
    chosen.replaceChildren(h("span", { class: "muted picker-head" }, label), ...picked.map(pickedRow));
    done.disabled = !picked.length;
    if (focused) (document.getElementById(focused) ?? search).focus();
  }
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => event.key === "Escape" && close();
  const overlay = h(
    "div",
    { class: "overlay" },
    h(
      "div",
      { class: "dialog wide", role: "dialog", "aria-modal": "true", "aria-labelledby": "group-picker-title", id: "group-picker" },
      h("div", { class: "dialog-head" }, h("h2", { id: "group-picker-title" }, group ? "邀请" : "发起群聊"), closeButton),
      h("div", { class: "picker-cols" }, h("div", { class: "picker-left" }, h("label", { class: "search" }, icon("search", 14, 2), search), list), chosen),
      error,
      h("div", { class: "dialog-actions" }, count, cancel, done),
    ),
  );
  search.addEventListener("input", () => {
    query = search.value.trim();
    paint();
  });
  done.addEventListener(
    "click",
    busy(done, async () => {
      error.textContent = "";
      const problem = pickProblem(picked, me, group);
      if (problem) return void (error.textContent = problem);
      if (!group) {
        // The group is made with its first words: see renderNewGroup. What is
        // half written there stays (its box is kept in writers).
        state.newGroup = { ...state.newGroup, picked, targets: targetsOf(picked), members: picked.filter((p) => p.agent), title: picked.map((p) => p.name).join("、") };
        close();
        if (location.hash === "#/new-group") await refresh();
        else location.hash = "#/new-group";
        return;
      }
      try {
        await api("POST", groupPath(group.id, "invites"), { from: mySeat(), members: targetsOf(picked) });
        close();
        toast("已邀请");
        await refresh();
      } catch (err) {
        error.textContent = err.message;
      }
    }),
  );
  cancel.addEventListener("click", close);
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => event.target === overlay && close());
  document.addEventListener("keydown", onKey);
  paint();
  document.body.append(overlay);
  search.focus();
}

// Invited: a card from whoever invited the person, with the opening message
// and its files, who is in the group, which of their AIs to bring in, and
// how many times a day each may be woken; 拒绝 or 加入, which answer every
// invite the person has to the group. What the person ticks and types is
// kept by invite (state.inviteDrafts), so a redraw that events bring keeps
// it, and 每天次数 being changed holds the redraw off (data-hold). With
// nothing to bring in, a gray line says why.
function renderInvite(g) {
  const invite = g.myInvite;
  const mine = g.invites.filter((i) => i.account === state.me.account.id);
  const invites = mine.length ? mine : [invite];
  const choices = inviteChoices(invites, [...state.agents.values()], state.me.account.id, state.me.devices);
  const empty = inviteEmpty(invites, choices);
  // `sending`: 拒绝 or 加入 went and has not come back, or came back done.
  const draft = state.inviteDrafts.get(invite.id) ?? { ticked: new Map(), quota: String(QUOTA.perDay), sending: false };
  state.inviteDrafts.set(invite.id, draft);
  const focused = document.getElementById("invite-card")?.contains(document.activeElement) ? document.activeElement.id : "";
  const opener = g.messages[0] ?? null;
  const picks = choices.map((c) => {
    const box = h("input", { type: "checkbox", id: `invite-ai-${c.id}`, checked: c.locked || (draft.ticked.get(c.id) ?? c.checked), disabled: c.locked, "data-agent": c.id });
    box.addEventListener("change", () => draft.ticked.set(c.id, box.checked));
    return h("label", { class: "pick" }, box, clientAvatar(c.client, 28), h("span", { class: "grow" }, c.name), c.note ? h("span", { class: "muted" }, c.note) : null);
  });
  const quota = h("input", { class: "quota-box", id: "invite-quota", type: "text", inputmode: "numeric", value: draft.quota, "aria-label": "每天最多被叫醒几次", "data-hold": "" });
  quota.addEventListener("input", () => (draft.quota = quota.value));
  const why = empty && h("p", { class: "muted invite-empty", id: "invite-empty" }, empty.connect ? h("a", { href: "#/start", id: "invite-connect" }, empty.text) : empty.text);
  // What went wrong shows here, as it does in a group (state.error), so a
  // redraw keeps it.
  const error = h("p", { class: "error", role: "alert", id: "invite-error" }, state.error || null);
  const decline = h("button", { type: "button", class: "btn", id: "invite-decline", disabled: draft.sending }, "拒绝");
  const accept = h("button", { type: "button", class: "btn primary", id: "invite-accept", disabled: draft.sending || !choices.length }, "加入");
  // Pressed once: until the relay answers, the card events redraw meanwhile
  // has both buttons off too, and what went wrong shows on the card then on
  // screen. Answered, the draft stays `sending`, for a redraw already under way.
  const answer = async (action, body) => {
    draft.sending = decline.disabled = accept.disabled = true;
    state.error = error.textContent = "";
    try {
      await api("POST", groupPath(g.id, "invites", invite.id, action), body);
      if (action === "decline") return void (location.hash = "#/");
    } catch (err) {
      draft.sending = false;
      state.error = err.message;
    }
    await refresh();
  };
  decline.addEventListener("click", () => void answer("decline", {}));
  accept.addEventListener("click", () => {
    const agents = picks.map((p) => p.querySelector("input")).filter((i) => i.checked).map((i) => i.dataset.agent);
    const problem = agents.length ? quotaProblem(quota.value) : "选至少一个 AI 进群";
    if (problem) return void (state.error = error.textContent = problem);
    void answer("accept", { agents, quota: quotaOf(quota.value) });
  });
  const card = h(
    "article",
    { class: "card invite-card", id: "invite-card", "aria-label": `邀请你加入「${g.name}」` },
    h("h2", {}, `邀请你加入「${g.name}」`),
    opener?.body ? h("p", {}, ...withAts(opener.body, opener.mentions, g.names)) : null,
    opener?.files.length ? h("div", { class: "card-files" }, ...opener.files.map(fileTile)) : null,
    h("span", { class: "with-avatar faces" }, ...facesOf(g).slice(0, 3).map((name) => avatar(faceOwner(name), 20)), h("span", { class: "muted" }, `群里有 ${g.members.length} 个 AI`)),
    h("div", { class: "invite-pick" }, ...picks, why),
    choices.length ? h("label", { class: "muted quota-label", for: quota.id }, "查对话记录 · 每天", quota, "次") : null,
    error,
    h("div", { class: "card-actions" }, decline, accept),
  );
  const log = h(
    "div",
    { class: "log", role: "log", "aria-label": "进群邀请" },
    h("span", { class: "event" }, shortTime(opener?.createdAt ?? g.createdAt)),
    h("div", { class: "msg" }, avatar(groupOwnerOf(g, invite.invitedBy, invite.invitedByName), 34), h("div", { class: "msg-col" }, h("span", { class: "msg-name" }, invite.invitedByName), card)),
  );
  showMain(g.name, log, { back: "#/" });
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

// A new group before its first words: they are its opening message
// (@所有人) and give it its name; only then is it made. "@所有人" alone is
// not enough (openingProblem): the words stay in the box with a red line.
// With nothing picked (a reload, an address typed in, or 返回 after the
// group was made), 消息 instead; the new group takes this page's place in
// the history, so 返回 from it does not come back here.
export function renderNewGroup() {
  const draft = state.newGroup;
  const seat = mySeat();
  if (!draft || !seat) return void location.replace("#/");
  // The same box while the page redraws, or the person picks again (writers).
  const w = writerOf("new-group", (made) => {
    made.box.id = "group-input";
    made.button.id = "group-send";
    made.box.value = "@所有人 ";
    return made;
  });
  w.show({
    label: "发到新群聊",
    send: async (text, files) => {
      const problem = openingProblem(text, files.length);
      if (problem) throw new Error(problem);
      // Picked again since the box was made: what is picked now.
      const { targets, members } = state.newGroup;
      const { body } = composeMessage(text, members, myName());
      const g = await api("POST", groupPath(), { from: seat, members: targets, message: body, files });
      state.newGroup = null;
      writers.drop("new-group");
      location.replace(`#/g/${encodeURIComponent(g.id)}`);
    },
  });
  showMain(draft.title, h("div"), { foot: w.foot, back: "#/", drop: w.take, focus: w.box });
}
