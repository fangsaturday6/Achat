// One page for both setups: on this computer (experiment 0) the relay fills in
// a token; in the cloud the token is empty and the login cookie is used.
// Layout, colours and wording follow docs/ui.md.
const token = window.ACHAT_TOKEN;
const cloud = !token;
const STATUS = { pending: "待批准", active: "进行中", declined: "已拒绝", closed: "已结束", stopped: "已停止", expired: "已过期" };

// How each kind of AI looks where the person picks or manages their own AIs.
const CLIENTS = {
  claude: { name: "Claude Code", mark: "Cl", color: "#d97757", receives: true },
  codex: { name: "Codex", mark: "Cx", color: "#2b2b2b", receives: true },
  doubao: { name: "豆包", mark: "豆", color: "#4d7cfe", receives: false },
  workbuddy: { name: "WorkBuddy", mark: "WB", color: "#7a5af8", receives: false },
  other: { name: "其他 AI", mark: null, color: "#9e9e9e", receives: false },
};
// Avatar colours, picked by name; src/cloud/emails.ts picks the same way.
const AVATAR_COLORS = ["#6a8fd8", "#5dae8b", "#e8a05b", "#9c7bd1"];

const ICONS = {
  search: "M11 5a6 6 0 1 0 0 12a6 6 0 1 0 0-12zM20 20l-4.5-4.5",
  plus: "M12 5v14M5 12h14",
  addPerson: "M10 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM3.5 19.5c.6-3.2 3.3-5 6.5-5s5.9 1.8 6.5 5M18.5 7.5v6M15.5 10.5h6",
  person: "M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM4 20c.8-3.6 4-6 8-6s7.2 2.4 8 6z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  close: "M6 6l12 12M18 6L6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "M5 12l5 5L20 7",
  monitor: "M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 20h8M12 16v4",
  right: "M9 6l6 6-6 6",
  left: "M15 6l-6 6 6 6",
  heart: "M12 20.5l-1.2-1.1C6.4 15.4 3.5 12.8 3.5 9.6 3.5 7 5.5 5 8.1 5c1.5 0 2.9.7 3.9 1.8C13 5.7 14.4 5 15.9 5c2.6 0 4.6 2 4.6 4.6 0 3.2-2.9 5.8-7.3 9.8z",
  chat: "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  people: "M9 5.3a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4zM3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.6c1.6.7 2.7 2.3 3 4.4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12",
  // 问答 and 动手, as in docs/ui.md.
  ask: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4 3.5V17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9.8 8.6a2.2 2.2 0 1 1 3.2 2c-.6.3-1 .8-1 1.4M12 14.4h.01",
  wrench: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  // Sending files or pictures, beside the text box.
  attach: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8v8M8 12h8",
};

// What a message may carry, as the relay checks it.
const MAX_FILES = 9;
const MAX_FILES_BYTES = 20 * 1024 * 1024;
// Pictures shown in the conversation; other files are cards to download.
const SHOWN_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MODE = { answer: "问答", do: "动手" };

const state = {
  me: null,
  agents: new Map(),
  contacts: [],
  threads: [],
  detail: null,
  friends: [],
  query: "",
  error: "",
  // People whose conversations are listed under them in 消息.
  expanded: new Set(),
  // The conversation last opened, so its person is expanded once, not on every redraw.
  opened: null,
  // 硅基圈: the posts on screen, the one opened, whose page it is, and the few
  // shown on a friend's profile.
  posts: [],
  post: null,
  person: null,
  personPosts: [],
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(cloud ? { "x-achat-web": "1" } : { "x-achat-token": token }), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data;
}

// --- building blocks

// Builds DOM nodes; strings become text nodes, so message content is never
// parsed as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG = "http://www.w3.org/2000/svg";

function icon(name, size = 24, strokeWidth = 1.6) {
  const svg = document.createElementNS(SVG, "svg");
  const attrs = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": name === "more" ? 3 : strokeWidth, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

// Joins text with a space only where a Latin word meets a Chinese one:
// "连接 Claude Code"、"连接豆包".
function cjk(...parts) {
  const han = /[一-鿿]/;
  return parts.reduce((out, part) => {
    const a = out.at(-1) ?? "";
    const b = part[0] ?? "";
    const gap = (/[A-Za-z0-9]/.test(a) && han.test(b)) || (han.test(a) && /[A-Za-z0-9]/.test(b));
    return gap ? `${out} ${part}` : out + part;
  });
}

function agentName(id) {
  return state.agents.get(id)?.name ?? id;
}

function isMine(id) {
  return agentName(id).startsWith("我");
}

function myName() {
  return (cloud && state.me?.account.name) || "我";
}

// "小林的 Codex" belongs to 小林; "我的 Claude" to the person looking.
function ownerOf(name) {
  return name.startsWith("我") ? myName() : name.replace(/的.*$/, "");
}

function initialOf(name) {
  return name.replace(/的.*$/, "").slice(-1) || "?";
}

function avatar(name, size) {
  const owner = ownerOf(name);
  const color = AVATAR_COLORS[[...owner].reduce((n, c) => n + c.codePointAt(0), 0) % AVATAR_COLORS.length];
  return h(
    "span",
    { class: "avatar", style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${color}`, "aria-hidden": "true" },
    initialOf(owner),
  );
}

function clientAvatar(client, size) {
  const c = CLIENTS[client] ?? CLIENTS.other;
  if (!c.mark) return iconAvatar("plus", c.color, size);
  const mono = c.mark.length > 1;
  return h(
    "span",
    { class: `avatar${mono ? " mono" : ""}`, style: `width:${size}px;height:${size}px;font-size:${Math.round(size * (mono ? 0.36 : 0.42))}px;background:${c.color}`, "aria-hidden": "true" },
    c.mark,
  );
}

function iconAvatar(name, color, size) {
  return h("span", { class: "avatar", style: `width:${size}px;height:${size}px;background:${color}`, "aria-hidden": "true" }, icon(name, Math.round(size * 0.6), 1.7));
}

function shortTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function busy(button, fn) {
  return async (event) => {
    event?.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await fn();
    } finally {
      button.disabled = false;
    }
  };
}

let toastTimer = null;

function toast(text) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = h("div", { class: "toast", role: "status" }, text);
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 1500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function copyButton(text, primary = true) {
  const button = h("button", { type: "button", class: primary ? "btn primary" : "text-btn" }, "复制");
  button.addEventListener("click", async () => {
    if (await copyText(text)) toast("已复制");
    else toast("复制不了，请手动选中");
  });
  return button;
}

function waiting(text) {
  return h("span", { class: "waiting", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), text);
}

// A menu that opens under a button and closes on a click elsewhere or Esc.
// Items: [label, onSelect, { danger, icon, disabled }], or [label, null, { control }]
// for a row holding a switch. `bar` lays it out as 硅基圈's dark strip beside the button.
let closeOpenMenu = null;

function openMenu(button, container, items, { bar = false } = {}) {
  closeOpenMenu?.();
  const menu = h(
    "div",
    { class: `menu${bar ? " action-bar" : ""}`, role: "menu" },
    ...items.map(([label, onSelect, opts = {}]) => {
      if (opts.control) return h("label", { class: "menu-item" }, label, opts.control);
      const item = h(
        "button",
        { type: "button", class: `menu-item${opts.danger ? " danger" : ""}`, role: "menuitem", disabled: opts.disabled },
        opts.icon ? icon(opts.icon, 16, 1.7) : null,
        label,
      );
      item.addEventListener("click", () => {
        close();
        onSelect?.();
      });
      return item;
    }),
  );
  const onKey = (event) => {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  };
  const onClick = (event) => {
    if (!menu.contains(event.target) && event.target !== button && !button.contains(event.target)) close();
  };
  function close() {
    menu.remove();
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onClick, true);
    closeOpenMenu = null;
  }
  container.append(menu);
  button.setAttribute("aria-expanded", "true");
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onClick, true);
  closeOpenMenu = close;
  menu.querySelector("button, input")?.focus();
}

function moreButton(label, container, items) {
  const button = h("button", { type: "button", class: "icon-btn", "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false" }, icon("more", 18));
  button.addEventListener("click", () => (closeOpenMenu ? closeOpenMenu() : openMenu(button, container, items())));
  return button;
}

// --- adding friends: one form for the dialog, the empty 通讯录 and first use

function addForm({ large = false, onDone } = {}) {
  const input = h("input", { class: `input${large ? " large" : ""}`, type: "email", placeholder: "对方的邮箱", "aria-label": "对方的邮箱", autocomplete: "off", required: true });
  const error = h("p", { class: "error", role: "alert" });
  const fallback = h("div");
  const copy = h("button", { type: "button", class: "text-btn" }, icon("link", 16, 1.8), "复制邀请链接");
  const send = h("button", { type: "submit", class: `btn primary${large ? " large" : ""}` }, "发送邀请");
  copy.addEventListener(
    "click",
    busy(copy, async () => {
      error.textContent = "";
      try {
        const invite = await api("POST", "/api/invites", {});
        if (await copyText(invite.url)) toast("已复制");
        else fallback.replaceChildren(h("pre", { class: "code-box" }, invite.url));
      } catch (err) {
        error.textContent = err.message;
      }
    }),
  );
  const form = h(
    "form",
    {
      class: "add-form",
      onsubmit: busy(send, async () => {
        error.textContent = "";
        try {
          const sent = await api("POST", "/api/invites", { email: input.value });
          input.value = "";
          toast(sent.status === "accepted" ? cjk("已和", sent.contact.name, "成为朋友") : "已发送");
          await onDone?.(sent);
        } catch (err) {
          error.textContent = err.message;
        }
      }),
    },
    input,
    error,
    fallback,
    h("div", { class: "actions" }, copy, send),
  );
  return form;
}

function openAddDialog() {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => event.key === "Escape" && close();
  const closeButton = h("button", { type: "button", class: "icon-btn", "aria-label": "关闭" }, icon("close", 18, 1.8));
  closeButton.addEventListener("click", close);
  const overlay = h(
    "div",
    { class: "overlay" },
    h(
      "div",
      { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "add-title" },
      h("div", { class: "dialog-head" }, h("h2", { id: "add-title" }, "添加朋友"), closeButton),
      addForm({
        onDone: async () => {
          close();
          if (location.hash === "#/contacts/new") await refresh();
          else location.hash = "#/contacts/new";
        },
      }),
    ),
  );
  overlay.addEventListener("click", (event) => event.target === overlay && close());
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  overlay.querySelector("input").focus();
}

// --- the app: rail, list, content

function route() {
  const hash = location.hash || "#/";
  const id = (prefix) => decodeURIComponent(hash.slice(prefix.length)) || null;
  if (hash.startsWith("#/contacts")) return { view: "contacts", id: id("#/contacts/") };
  if (hash.startsWith("#/me")) return { view: "me", id: id("#/me/") };
  if (hash.startsWith("#/start")) return { view: "start", id: hash.split("/")[2] ?? "" };
  if (hash.startsWith("#/t/")) return { view: "messages", id: id("#/t/") };
  if (hash.startsWith("#/new/")) return { view: "messages", id: null, compose: id("#/new/") };
  if (hash.startsWith("#/posts")) return { view: "posts", sub: "feed", id: null };
  if (hash.startsWith("#/u/")) return { view: "posts", sub: "person", id: id("#/u/") };
  if (hash.startsWith("#/p/")) {
    const [post, part] = hash.slice(4).split("/");
    return { view: "posts", sub: part === "page" ? "page" : "post", id: decodeURIComponent(post) };
  }
  return { view: "messages", id: null };
}

function setBadge(id, count, label) {
  const badge = document.getElementById(id);
  badge.hidden = !count;
  badge.textContent = String(count);
  badge.parentElement.setAttribute("aria-label", count ? `${label[0]}，${count} ${label[1]}` : label[0]);
}

function renderRail(view) {
  for (const [id, name] of [["nav-messages", "messages"], ["nav-contacts", "contacts"], ["nav-posts", "posts"], ["nav-me", "me"], ["nav-avatar", "me"]]) {
    const el = document.getElementById(id);
    if (view === name) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  setBadge("messages-badge", state.threads.filter(needsYou).length, ["消息", "个对话等你看"]);
  setBadge("contacts-badge", state.me?.newFriends ?? 0, ["通讯录", "个新的朋友"]);
  // 硅基圈 needs an account; its dot says friends posted since the person last looked.
  const posts = document.getElementById("nav-posts");
  posts.hidden = !cloud;
  const fresh = !!state.me?.newPosts && view !== "posts";
  document.getElementById("posts-dot").hidden = !fresh;
  posts.setAttribute("aria-label", fresh ? "硅基圈，有新动态" : "硅基圈");
  document.getElementById("nav-avatar").replaceChildren(avatar(myName(), 34));
  const settings = document.getElementById("nav-settings");
  settings.hidden = !cloud;
  settings.onclick = () => (closeOpenMenu ? closeOpenMenu() : openMenu(settings, settings.parentElement, settingsItems()));
}

function notifySwitch() {
  const notify = h("input", { type: "checkbox", class: "switch", role: "switch", checked: state.me.emailNotify });
  notify.addEventListener("change", () => void saveNotify(notify.checked));
  return notify;
}

function settingsItems() {
  return [
    ["邮件提醒", null, { control: notifySwitch() }],
    ["退出登录", logout],
  ];
}

async function saveNotify(on) {
  state.me = await api("POST", "/api/me", { emailNotify: on }).catch((err) => (toast(err.message), state.me));
}

async function logout() {
  await api("POST", "/api/auth/logout", {}).catch(() => {});
  location.href = "/";
}

function listHead(placeholder) {
  const input = h("input", { type: "search", placeholder: "搜索", "aria-label": placeholder, value: state.query });
  input.addEventListener("input", () => {
    state.query = input.value.trim();
    renderListBody(route());
  });
  return h(
    "div",
    { class: "list-head" },
    h("label", { class: "search" }, icon("search", 14, 2), input),
    cloud ? h("button", { type: "button", class: "plus", "aria-label": "添加朋友", onclick: openAddDialog }, icon("plus", 16, 1.8)) : null,
  );
}

function item(href, current, pic, name, { sub, time, right } = {}) {
  return h(
    "a",
    { class: "item", href, "aria-current": current ? "true" : null },
    pic,
    h(
      "span",
      { class: "item-text" },
      time ? h("span", { class: "item-row" }, h("span", { class: "item-name" }, name), h("span", { class: "item-time" }, time)) : h("span", { class: "item-name" }, name),
      sub ? h("span", { class: "item-sub" }, sub) : null,
    ),
    right ?? null,
  );
}

function matches(...texts) {
  return !state.query || texts.some((t) => t?.toLowerCase().includes(state.query.toLowerCase()));
}

function renderList(r) {
  const list = document.getElementById("list");
  const head =
    r.view === "me" && cloud
      ? h("div", { class: "list-head profile-head" }, avatar(myName(), 40), h("span", { class: "item-text" }, h("span", { class: "item-name" }, myName()), h("span", { class: "item-sub" }, state.me.account.email)))
      : listHead({ messages: "搜索消息", contacts: "搜索朋友", me: "搜索" }[r.view]);
  list.setAttribute("aria-label", { messages: "消息", contacts: "通讯录", me: "我" }[r.view]);
  list.replaceChildren(head, h("div", { class: "list-body", id: "list-body" }));
  renderListBody(r);
}

// --- 消息: one row per person, their conversations underneath

// A conversation that has something new for the person, or waits on their approval.
function needsYou(t) {
  return t.unread || (t.status === "pending" && isMine(t.to));
}

// Whose conversation it is: the other person's account, or "me" between one's own AIs.
function personOf(t) {
  if (isMine(t.from) && isMine(t.to)) return "me";
  const other = otherSide(t);
  return state.agents.get(other)?.owner ?? ownerOf(agentName(other));
}

function people() {
  const byPerson = new Map();
  const threads = [...state.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const t of threads) {
    const key = personOf(t);
    if (!byPerson.has(key)) {
      const name = key === "me" ? "我的 AI" : state.contacts.find((c) => c.id === key)?.name ?? ownerOf(agentName(otherSide(t)));
      byPerson.set(key, { key, name, avatarName: key === "me" ? myName() : name, threads: [] });
    }
    byPerson.get(key).threads.push(t);
  }
  return [...byPerson.values()];
}

function preview(t) {
  const last = t.lastMessage;
  const text = t.status === "pending" || !last || last.kind === "system" ? t.topic : messageText(last);
  return [t.status === "pending" && isMine(t.to) ? h("span", { class: "tag-pending" }, "[待批准] ") : null, text];
}

function withCount(pic, count) {
  if (!count) return pic;
  return h("span", { class: "avatar-wrap" }, pic, h("span", { class: "badge", "aria-hidden": "true" }, String(count)));
}

function renderPeople(r) {
  const rows = [];
  for (const p of people()) {
    const threads = p.threads.filter((t) => matches(p.name, t.topic, agentName(t.from), agentName(t.to)));
    if (!threads.length) continue;
    const open = state.expanded.has(p.key) || !!state.query;
    const count = p.threads.filter(needsYou).length;
    const latest = p.threads[0];
    const toggle = h(
      "button",
      { type: "button", class: "item", "aria-expanded": String(open), "aria-label": count ? `${p.name}，${count} 个对话等你看` : p.name },
      withCount(avatar(p.avatarName, 40), count),
      h(
        "span",
        { class: "item-text" },
        h("span", { class: "item-row" }, h("span", { class: "item-name" }, p.name), h("span", { class: "item-time" }, shortTime(latest.updatedAt))),
        open ? null : h("span", { class: "item-sub" }, preview(latest)),
      ),
    );
    toggle.addEventListener("click", () => {
      if (open) {
        state.expanded.delete(p.key);
        return renderListBody(r);
      }
      state.expanded.add(p.key);
      if (p.threads.some((t) => t.id === r.id)) renderListBody(r);
      else location.hash = `#/t/${latest.id}`;
    });
    rows.push(toggle);
    if (!open) continue;
    for (const t of threads) {
      const status =
        t.status === "pending" && isMine(t.to)
          ? h("span", { class: "convo-status tag-pending" }, "待批准")
          : h("span", { class: "convo-status" }, t.status === "pending" ? "等待批准" : t.status === "active" ? "进行中" : shortTime(t.updatedAt));
      rows.push(
        h(
          "a",
          { class: "convo", href: `#/t/${t.id}`, "aria-current": r.id === t.id ? "true" : null },
          h("span", { class: `dot${t.unread ? " on" : ""}`, "aria-label": t.unread ? "未读" : null }),
          t.mode === "do" ? h("span", { class: "mode-do", role: "img", "aria-label": "动手" }, icon("wrench", 14, 2)) : null,
          h("span", { class: "convo-topic" }, t.topic),
          status,
        ),
      );
    }
  }
  return rows;
}

function renderListBody(r) {
  const body = document.getElementById("list-body");
  if (r.view === "messages") {
    body.replaceChildren(...renderPeople(r));
    return;
  }
  if (r.view === "contacts") {
    if (!cloud) {
      body.replaceChildren(
        ...[...state.agents.values()].filter((a) => a.client !== "person" && matches(a.name)).map((a) => item(`#/contacts/${encodeURIComponent(a.id)}`, r.id === a.id, avatar(a.name, 40), a.name)),
      );
      return;
    }
    const count = state.me?.newFriends ?? 0;
    body.replaceChildren(
      item("#/contacts/new", r.id === "new", iconAvatar("addPerson", "var(--accent)", 40), "新的朋友", {
        right: count ? h("span", { class: "badge inline", "aria-label": `${count} 个` }, String(count)) : null,
      }),
      ...state.contacts.filter((c) => matches(c.name, c.email)).map((c) => item(`#/contacts/${encodeURIComponent(c.id)}`, r.id === c.id, avatar(c.name, 40), c.name)),
    );
    return;
  }
  if (!cloud) {
    body.replaceChildren(item("#/me/this", true, iconAvatar("monitor", "#8c8c8c", 40), "这台电脑"));
    return;
  }
  const me = state.me;
  body.replaceChildren(
    item("#/start", false, iconAvatar("plus", "var(--accent)", 40), "连接 AI"),
    ...me.devices.map((d) =>
      item(`#/me/${encodeURIComponent(d.id)}`, r.id === d.id, iconAvatar("monitor", "#8c8c8c", 40), d.name, { sub: d.ais.join("、") }),
    ),
    ...me.remoteAis.map((a) =>
      item(`#/me/${encodeURIComponent(a.id)}`, r.id === a.id, clientAvatar(a.client, 40), a.name, { sub: a.lastUsedAt ? null : "还没连上" }),
    ),
    h("label", { class: "item narrow-only" }, h("span", { class: "item-text" }, "邮件提醒"), notifySwitch()),
    h("button", { type: "button", class: "item narrow-only danger", onclick: logout }, "退出登录"),
  );
}

function otherSide(t) {
  return isMine(t.from) && !isMine(t.to) ? t.to : t.from;
}

// The content column: a title bar, the body, and an optional bar at the bottom.
// `flush` drops the body's side padding; `backAlways` shows the back button on
// wide screens too, for pages one level down that have no list beside them.
// `drop`: takes files dragged onto the conversation.
function showMain(title, body, { right, foot, back, center, onContent, flush, backAlways, drop } = {}) {
  const main = document.getElementById("main");
  main.ondragover = drop
    ? (e) => {
        if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
        e.preventDefault();
        main.classList.add("drop-over");
      }
    : null;
  main.ondragleave = (e) => {
    if (!main.contains(e.relatedTarget)) main.classList.remove("drop-over");
  };
  main.ondrop = drop
    ? (e) => {
        e.preventDefault();
        main.classList.remove("drop-over");
        drop([...(e.dataTransfer?.files ?? [])]);
      }
    : null;
  const backLink = back ? h("a", { class: `back-btn icon-btn${backAlways ? " always" : ""}`, href: back, "aria-label": "返回" }, icon("left", 20, 1.8)) : null;
  const head = title === null ? null : h("header", { class: "main-head" }, backLink, h("h1", {}, title), right ?? null);
  const bodyEl = h("div", { class: `main-body${center ? " center" : ""}${onContent ? " on-content" : ""}${flush ? " flush" : ""}` }, body);
  main.replaceChildren(...[head, bodyEl, foot].filter(Boolean));
  return bodyEl;
}

function showEmpty() {
  showMain(null, h("span", { class: "empty-mark", "aria-hidden": "true" }, "Achat"), { center: true });
}

async function act(fn) {
  state.error = "";
  try {
    await fn();
  } catch (err) {
    state.error = err.message;
  }
  await refresh();
}

// --- a conversation

// 问答 or 动手 with its icon. While the person decides on a 动手, or picks
// one for a new conversation, it is a button that switches between the two.
function modeChip(mode, onToggle) {
  const chip = h(onToggle ? "button" : "span", onToggle ? { type: "button" } : {});
  const paint = (m) => {
    chip.className = `mode ${m}`;
    chip.replaceChildren(icon(m === "do" ? "wrench" : "ask", 13, 2), MODE[m]);
    if (onToggle) chip.setAttribute("aria-label", `做法：${MODE[m]}，点一下切换`);
  };
  paint(mode);
  chip.dataset.mode = mode;
  if (onToggle) {
    chip.addEventListener("click", () => {
      chip.dataset.mode = chip.dataset.mode === "do" ? "answer" : "do";
      paint(chip.dataset.mode);
      onToggle(chip.dataset.mode);
    });
  }
  return chip;
}

// The person's own seat, from which they start conversations and write.
function mySeat() {
  return [...state.agents.values()].find((a) => a.client === "person" && isMine(a.id))?.id ?? null;
}

// Who wrote a message: the AI, or the person themself on the web page.
function writerName(m) {
  if (!m.byPerson) return agentName(m.sender);
  return isMine(m.sender) ? "我" : ownerOf(agentName(m.sender));
}

// A request: the question, and while it waits, its scope. The person who
// decides changes the scope and answers right here, under the request.
function requestCard(t, m, waiting) {
  // The question, and the files that came with it.
  const asked = [m.body ? h("p", {}, m.body) : null, m.files.length ? h("div", { class: "card-files" }, ...m.files.map(fileTile)) : null];
  if (!waiting) return h("article", { class: "card", "aria-label": `请求：${t.topic}` }, ...asked);
  const spend = t.mode === "do" ? "" : ` · $${t.scope.budgetUsd.toFixed(2)}`;
  if (!isMine(t.to)) {
    const scope = h("div", { class: "scope" }, `${agentName(t.to)} · `, modeChip(t.mode), ` · ${t.scope.maxRounds} 轮${spend}`);
    return h("article", { class: "card", "aria-label": `请求：${t.topic}` }, ...asked, scope);
  }
  const budget = h(
    "span",
    { hidden: t.mode === "do" },
    " · $",
    h("input", { type: "number", min: "0.1", max: "50", step: "0.1", value: t.scope.budgetUsd.toFixed(2), "aria-label": "花费上限（美元）" }),
  );
  const chip = t.mode === "do" ? modeChip("do", (mode) => (budget.hidden = mode === "do")) : modeChip("answer");
  const rounds = h("input", { type: "number", min: "1", max: "20", value: String(t.scope.maxRounds), "aria-label": "最多轮数" });
  const scope = h("div", { class: "scope" }, `${agentName(t.to)} · `, chip, " · ", rounds, " 轮", budget);
  const decline = h("button", { type: "button", class: "btn", onclick: () => act(() => api("POST", `/api/threads/${t.id}/decline`, {})) }, "拒绝");
  const approve = h(
    "button",
    {
      type: "button",
      class: "btn primary",
      onclick: () =>
        act(() =>
          api("POST", `/api/threads/${t.id}/approve`, {
            mode: chip.dataset.mode,
            maxRounds: Number(rounds.value),
            budgetUsd: Number(budget.querySelector("input").value),
          }),
        ),
    },
    "同意",
  );
  const error = state.error ? h("p", { class: "error", role: "alert" }, state.error) : null;
  return h("article", { class: "card", "aria-label": `请求：${t.topic}` }, ...asked, scope, error, h("div", { class: "card-actions" }, decline, approve));
}

// --- files in a conversation

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// "PDF", "ZIP": what the file is, on its icon.
function fileTypeIcon(name) {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toUpperCase() ?? "";
  return h("span", { class: "file-type", "aria-hidden": "true" }, ext.length <= 4 ? ext : ext.slice(0, 4));
}

function fileText(name, size) {
  return h("span", { class: "file-text" }, h("span", { class: "file-name" }, name), h("span", { class: "file-size" }, sizeLabel(size)));
}

// A file's bytes as an address the page can show or save. Fetched once, with
// the same credentials as the API, which an <img src> could not send.
const fileUrls = new Map();
function fileUrl(id) {
  if (!fileUrls.has(id)) {
    const loading = fetch(`/api/files/${encodeURIComponent(id)}`, { headers: cloud ? {} : { "x-achat-token": token } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => URL.createObjectURL(blob));
    loading.catch(() => fileUrls.delete(id));
    fileUrls.set(id, loading);
  }
  return fileUrls.get(id);
}

// A picture at full size over the page; a click or Esc closes it.
function showImage(src, name) {
  const close = () => {
    view.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  const view = h("div", { class: "lightbox", role: "dialog", "aria-label": name, onclick: close }, h("img", { src, alt: name }));
  document.addEventListener("keydown", onKey);
  document.body.append(view);
}

async function saveFile(f) {
  const link = h("a", { href: await fileUrl(f.id), download: f.name });
  document.body.append(link);
  link.click();
  link.remove();
}

// A file in the conversation: a picture shown as it is, anything else a card
// that downloads it, as in WeChat.
function fileTile(f) {
  if (SHOWN_TYPES.has(f.type)) {
    const img = h("img", { class: "msg-image", alt: f.name });
    fileUrl(f.id).then(
      (src) => (img.src = src),
      () => button.replaceWith(fileCard(f)),
    );
    const button = h("button", { type: "button", class: "image-btn", "aria-label": `看大图：${f.name}`, onclick: () => img.src && showImage(img.src, f.name) }, img);
    return button;
  }
  return fileCard(f);
}

function fileCard(f) {
  const card = h("button", { type: "button", class: "file-card", "aria-label": `下载 ${f.name}` }, fileText(f.name, f.size), fileTypeIcon(f.name));
  card.addEventListener("click", busy(card, () => saveFile(f).catch(() => toast("下载失败，再点一次"))));
  return card;
}

// The words of a message in a list: what it said, or what it sent.
function messageText(m) {
  if (m.body || !m.files?.length) return m.body;
  return m.files.every((f) => SHOWN_TYPES.has(f.type)) ? "[图片]" : `[文件] ${m.files.find((f) => !SHOWN_TYPES.has(f.type)).name}`;
}

// A picture waiting to be sent, shown from the person's own copy.
const previews = new WeakMap();
function previewOf(file) {
  if (!previews.has(file)) previews.set(file, URL.createObjectURL(file));
  return previews.get(file);
}

// A file waiting to be sent, read into base64 for the API.
function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result).replace(/^data:[^,]*,/, "") });
    reader.onerror = () => reject(new Error(`读不了 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// The bottom of a conversation, as in WeChat: ＋ to pick files or pictures
// (they can also be pasted or dragged in), what the person writes, the
// rounds and money so far on the left, 停止 and 发送 on the right.
function writeBox({ label, status, extra, send }) {
  const box = h("textarea", { class: "write", "aria-label": label, rows: "3" });
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const button = h("button", { type: "button", class: "btn primary" }, "发送");
  const picked = [];
  const tray = h("div", { class: "tray", "aria-label": "要发的文件", hidden: true });
  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  const paint = () => {
    tray.replaceChildren(
      ...picked.map((file, i) => {
        const remove = h("button", { type: "button", class: "tray-remove", "aria-label": `不发${file.name}` }, icon("close", 10, 3));
        remove.addEventListener("click", () => {
          picked.splice(i, 1);
          paint();
        });
        const shown = SHOWN_TYPES.has(file.type)
          ? h("img", { class: "tray-image", src: previewOf(file), alt: file.name })
          : h("span", { class: "tray-file" }, fileTypeIcon(file.name), fileText(file.name, file.size));
        return h("div", { class: "tray-item" }, shown, remove);
      }),
    );
    tray.hidden = !picked.length;
  };
  const take = (files) => {
    if (!files.length) return;
    const all = [...picked, ...files];
    if (all.length > MAX_FILES) return showError(`一次最多 ${MAX_FILES} 个文件`);
    if (all.reduce((n, f) => n + f.size, 0) > MAX_FILES_BYTES) return showError("文件太大，一次最多 20 MB");
    error.hidden = true;
    picked.push(...files);
    paint();
    box.focus();
  };
  const chooser = h("input", { type: "file", multiple: true, hidden: true });
  chooser.addEventListener("change", () => {
    take([...chooser.files]);
    chooser.value = "";
  });
  const plus = h("button", { type: "button", class: "icon-btn write-tool", "aria-label": "发送文件或图片", title: "发送文件或图片" }, icon("attach", 22));
  plus.addEventListener("click", () => chooser.click());
  // A screenshot pasted in is a picture to send, as in WeChat.
  box.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    take(files.map((f) => (f.type.startsWith("image/") && /^image\.\w+$/.test(f.name) ? new File([f], f.name.replace(/^image/, "截图"), { type: f.type }) : f)));
  });
  const go = async () => {
    const text = box.value.trim();
    if ((!text && !picked.length) || button.disabled) return;
    button.disabled = true;
    error.hidden = true;
    try {
      await send(text, await Promise.all(picked.map(fileData)));
    } catch (err) {
      showError(err.message);
      button.disabled = false;
    }
  };
  button.addEventListener("click", go);
  // Return sends, Shift+Return starts a new line, as in WeChat.
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void go();
    }
  });
  const foot = h(
    "footer",
    { class: "main-foot write-foot" },
    h("div", { class: "write-tools" }, plus, chooser),
    tray,
    box,
    error,
    h("div", { class: "write-row" }, status, h("div", { class: "buttons" }, ...(extra ?? []), button)),
  );
  return { foot, box, take };
}

function renderThread(t) {
  const ownPair = isMine(t.from) && isMine(t.to);
  const startedByMe = state.agents.get(t.from)?.client === "person";
  // Between one's own: the person, or else the AI that answers, on the right.
  const onRight = (sender) => (ownPair ? sender === (startedByMe ? t.from : t.to) : isMine(sender));
  // One person can have several AIs, so each message says which one wrote it.
  const row = (m, ...content) =>
    h(
      "div",
      { class: `msg${onRight(m.sender) ? " right" : ""}` },
      avatar(agentName(m.sender), 34),
      h("div", { class: "msg-col" }, h("span", { class: "msg-name" }, writerName(m)), ...content),
    );
  const log = h("div", { class: "log", role: "log", "aria-label": "对话原文" }, h("span", { class: "event" }, shortTime(t.createdAt)));
  // While pending, the asker's latest message is what the person decides on.
  const waiting = t.status === "pending" ? t.messages.filter((m) => m.kind !== "system" && m.sender === t.from).at(-1) : null;
  for (const m of t.messages) {
    if (m.kind === "system") log.append(h("span", { class: "event" }, m.body));
    else if (m.kind === "request" || m === waiting) log.append(row(m, requestCard(t, m, m === waiting)));
    else {
      const bubble = m.body ? h("div", { class: "bubble" }, m.body) : null;
      const said = bubble && m.redactions > 0 ? h("div", { class: "bubble-wrap" }, bubble, h("span", { class: "muted" }, `已过滤 ${m.redactions} 处`)) : bubble;
      log.append(row(m, said, ...m.files.map(fileTile)));
    }
  }
  const lastSpoken = t.messages.filter((m) => m.kind !== "system").at(-1);
  if (t.status === "active" && lastSpoken?.sender === t.from) {
    log.append(row({ sender: t.to }, h("div", { class: "bubble", role: "img", "aria-label": `${agentName(t.to)}正在回答` }, h("span", { class: "typing" }, h("i"), h("i"), h("i")))));
  }
  if (t.status === "pending" && !isMine(t.to)) log.append(h("span", { class: "event" }, cjk("等", ownerOf(agentName(t.to)), "批准")));

  // 动手 runs on the person's Claude subscription, so it has rounds only.
  const rounds = `${t.roundsUsed} / ${t.scope.maxRounds} 轮`;
  const usage = t.mode === "do" ? rounds : `${rounds} · $${t.costUsd.toFixed(2)} / $${t.scope.budgetUsd.toFixed(2)}`;
  // The person writes as the side that is theirs; between their own AIs, as the asker.
  const side = isMine(t.from) ? t.from : isMine(t.to) ? t.to : null;
  const writes = side && (t.status === "active" || t.status === "closed" || (t.status === "expired" && side === t.from));
  let foot = null;
  let drop;
  if (writes) {
    const stop = t.status === "active" ? [h("button", { type: "button", class: "btn danger", onclick: () => act(() => api("POST", `/api/threads/${t.id}/stop`, {})) }, "停止")] : [];
    const status = h("span", { class: "muted" }, t.status === "active" ? usage : `${usage} · ${STATUS[t.status]}`);
    ({ foot, take: drop } = writeBox({
      label: `发给${agentName(side === t.from ? t.to : t.from)}`,
      status,
      extra: stop,
      send: async (text, files) => {
        await api("POST", `/api/threads/${t.id}/messages`, { from: side, body: text, byPerson: true, files });
        await refresh();
      },
    }));
  } else if (t.status !== "pending") {
    foot = h("footer", { class: "main-foot" }, h("span", { class: "muted" }, `${usage} · ${STATUS[t.status]}`));
  }
  const body = showMain(t.topic, log, { foot, back: "#/", drop });
  body.scrollTop = body.scrollHeight;
  // Pictures arrive after the first layout; the newest stays in view.
  for (const img of log.querySelectorAll("img")) img.addEventListener("load", () => (body.scrollTop = body.scrollHeight), { once: true });
}

// The first sentence names a conversation the person starts on the web.
function topicOf(text) {
  const first = text.split(/[\n。！？!?]/).map((s) => s.trim()).find(Boolean) ?? text;
  return first.slice(0, 20);
}

// A new conversation with one AI, started by the person on the web: nothing
// above yet, the input box below. 动手 is offered where that AI can do it.
function renderCompose(to) {
  const target = state.agents.get(to);
  const seat = mySeat();
  if (!target || !seat || target.canReceive === false) return showEmpty();
  const chip = target.client === "claude" ? modeChip("answer", () => {}) : modeChip("answer");
  const { foot, box, take } = writeBox({
    label: `发给${target.name}`,
    status: chip,
    send: async (text, files) => {
      const topic = topicOf(text) || files[0].name.slice(0, 20);
      const t = await api("POST", "/api/threads", { from: seat, to, topic, message: text, mode: chip.dataset.mode, files });
      location.hash = `#/t/${t.id}`;
    },
  });
  showMain(target.name, h("div"), { foot, back: "#/", drop: take });
  box.focus();
}

// 发消息 beside an AI that can answer; "只能提问" beside one that cannot.
function sendLink(agent) {
  return agent.canReceive === false
    ? h("span", { class: "muted" }, "只能提问")
    : h("a", { class: "btn small", href: `#/new/${encodeURIComponent(agent.id)}` }, "发消息");
}

// --- 通讯录

function renderFriends() {
  if (!state.friends.length) return showMain("新的朋友", h("span", { class: "empty-mark", "aria-hidden": "true" }, "Achat"), { back: "#/contacts", center: true });
  const list = h("ul", { class: "friends" });
  for (const f of state.friends) {
    const known = f.direction === "in" || f.status === "accepted";
    const row = h("li", {}, known ? avatar(f.name, 40) : iconAvatar("person", "#c8c8c8", 40), h("span", { class: "item-text" }, h("span", { class: "item-name" }, f.name), f.direction === "in" && f.email ? h("span", { class: "item-sub" }, f.email) : null));
    let right;
    if (f.direction === "in" && f.status === "pending") {
      right = h("button", { type: "button", class: "btn primary small" }, "接受");
      right.addEventListener(
        "click",
        busy(right, () =>
          act(async () => {
            await api("POST", `/api/invites/${encodeURIComponent(f.id)}/accept`, {});
            toast("已添加");
          }),
        ),
      );
    } else {
      const status = h("span", { class: "muted" }, { pending: "等待验证", accepted: "已添加", expired: "已过期" }[f.status]);
      right = h(
        "span",
        { class: "right" },
        status,
        f.direction === "out" && f.status !== "accepted"
          ? moreButton(`${f.name}的更多操作`, row, () => [
              ["再发一次", () => act(async () => (await api("POST", `/api/invites/${encodeURIComponent(f.id)}/resend`, {}), toast("已发送")))],
              ["撤回", () => act(() => api("DELETE", `/api/invites/${encodeURIComponent(f.id)}`)), { danger: true }],
            ])
          : null,
      );
    }
    row.append(right);
    list.append(row);
  }
  showMain("新的朋友", [state.error ? h("p", { class: "error", role: "alert", style: "padding-top:16px" }, state.error) : null, list], { back: "#/contacts" });
}

function renderContact(id) {
  if (cloud && id === "new") return renderFriends();
  const person = state.contacts.find((c) => c.id === id);
  if (person) {
    const main = document.getElementById("main");
    const more = moreButton(`${person.name}的更多操作`, main, () => [
      [
        "删除朋友",
        () => {
          if (!confirm(`删除${person.name}后，你们的 AI 不能再互相问。`)) return;
          void act(async () => {
            await api("DELETE", `/api/contacts/${encodeURIComponent(person.id)}`);
            location.hash = "#/contacts";
          });
        },
        { danger: true },
      ],
    ]);
    showMain(
      person.name,
      h(
        "div",
        { class: "profile" },
        h("div", { class: "profile-top" }, avatar(person.name, 64), h("div", {}, h("h2", {}, person.name), person.email ? h("span", { class: "muted" }, person.email) : null)),
        h("div", { class: "divider" }),
        h(
          "div",
          { class: "field-row" },
          h("span", { class: "label" }, "AI"),
          h("div", { class: "values" }, ...(person.agents.length ? person.agents.map((a) => h("span", { class: "with-avatar" }, avatar(a.name, 34), h("span", { class: "grow" }, a.name), sendLink(a))) : [h("span", { class: "muted", style: "line-height:34px" }, "还没连接 AI")])),
        ),
        state.personPosts.length ? [h("div", { class: "divider" }), postsRow(person.id, state.personPosts)] : null,
        state.error ? h("p", { class: "error", role: "alert" }, state.error) : null,
      ),
      { right: more, back: "#/contacts" },
    );
    return;
  }
  const agent = state.agents.get(id);
  if (agent && !cloud && agent.client !== "person") {
    const count = state.threads.filter((t) => t.from === id || t.to === id).length;
    showMain(
      agent.name,
      h(
        "div",
        { class: "profile" },
        h("div", { class: "profile-top" }, avatar(agent.name, 64), h("div", {}, h("h2", {}, agent.name), h("span", { class: "muted" }, agent.id))),
        h("div", { class: "divider" }),
        h("div", { class: "field-row" }, h("span", { class: "label" }, "协作"), h("span", { style: "line-height:34px" }, `${count} 次`)),
        h("span", {}, sendLink(agent)),
      ),
      { back: "#/contacts" },
    );
    return;
  }
  // No friends yet: the place to add one is right here.
  if (cloud && !state.contacts.length) {
    return showMain("添加朋友", h("div", { style: "display:flex;justify-content:center;padding-top:72px" }, addForm({ onDone: () => (location.hash = "#/contacts/new") })), { back: "#/contacts", onContent: true });
  }
  showEmpty();
}

// --- 我

function renderMe(id) {
  if (!cloud) {
    return showMain(
      "这台电脑",
      h("div", { class: "column" }, h("span", { class: "muted" }, "还没加入 Achat 账号"), h("pre", { class: "code-box" }, "achat link")),
      { back: "#/me" },
    );
  }
  const me = state.me;
  const error = state.error ? h("p", { class: "error", role: "alert" }, state.error) : null;
  const device = me.devices.find((d) => d.id === id);
  if (device) {
    const remove = h("button", { type: "button", class: "btn danger" }, "移除这台电脑");
    remove.addEventListener("click", () => {
      if (!confirm(`移除「${device.name}」后，这台电脑上的 AI 不能再代表你联系别人。`)) return;
      void act(async () => {
        await api("DELETE", `/api/devices/${encodeURIComponent(device.id)}`);
        location.hash = "#/me";
      });
    });
    const seen = device.lastSeenAt ? `最近在线 ${shortTime(device.lastSeenAt)}` : `添加于 ${shortTime(device.createdAt)}`;
    return showMain(
      device.name,
      h(
        "div",
        { class: "column" },
        h("span", { class: "muted" }, seen),
        h(
          "ul",
          { class: "panel-list" },
          ...(device.agents ?? device.ais.map((label) => ({ client: label === "Codex" ? "codex" : "claude" }))).map((a) =>
            h("li", {}, clientAvatar(a.client, 34), h("span", { class: "grow" }, `我的 ${a.client === "codex" ? "Codex" : "Claude"}`), a.id ? sendLink(a) : null),
          ),
        ),
        error,
        h("span", {}, remove),
      ),
      { back: "#/me" },
    );
  }
  const ai = me.remoteAis.find((a) => a.id === id);
  if (ai) {
    const remove = h("button", { type: "button", class: "btn danger" }, "移除");
    remove.addEventListener("click", () => {
      if (!confirm(`移除后，${ai.name}的连接凭证立即作废。`)) return;
      void act(async () => {
        await api("DELETE", `/api/agents/${encodeURIComponent(ai.id)}`);
        location.hash = "#/me";
      });
    });
    return showMain(
      ai.name,
      h(
        "div",
        { class: "column" },
        h("span", { class: "muted" }, ai.lastUsedAt ? `最近使用 ${shortTime(ai.lastUsedAt)}` : "还没连上"),
        error,
        h("div", { class: "buttons" }, h("a", { class: "btn", href: `#/start/${ai.client}` }, "重新连接"), remove),
      ),
      { back: "#/me" },
    );
  }
  showEmpty();
}

// --- the first-use checklist on the 消息 page

function checklistDone() {
  const c = state.me?.checklist;
  return !c || (c.connected && c.invited && c.collaborated);
}

function renderChecklist() {
  const c = state.me.checklist;
  const rows = [
    ["注册", true],
    ["连接 AI", c.connected, () => h("a", { class: "btn primary small", href: "#/start" }, "连接")],
    ["添加朋友", c.invited, () => h("button", { type: "button", class: "btn primary small", onclick: openAddDialog }, "添加")],
    ["问朋友的 AI 一个问题", c.collaborated],
  ];
  showMain(
    "开始使用",
    h(
      "div",
      { class: "column" },
      h(
        "ul",
        { class: "panel-list" },
        ...rows.map(([label, done, action]) =>
          h(
            "li",
            {},
            h("span", { class: `check${done ? " done" : ""}`, "aria-hidden": "true" }, done ? icon("check", 13, 3) : null),
            h("span", { class: `grow${done ? " done-label" : ""}` }, label),
            done ? h("span", { class: "visually-hidden" }, "已完成") : action?.() ?? null,
          ),
        ),
      ),
    ),
  );
}

// --- 硅基圈

function postTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return shortTime(iso);
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return "昨天";
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

// The top of 硅基圈 and of someone's page: a wafer, their name and avatar.
function cover(name, { href, back } = {}) {
  const pic = href ? h("a", { href, "aria-label": cjk(name, "的硅基圈") }, avatar(name, 72)) : avatar(name, 72);
  return h(
    "div",
    { class: "cover" },
    back ? h("a", { class: "cover-back", href: back, "aria-label": "返回" }, icon("left", 20, 1.8)) : null,
    h("div", { class: "cover-person" }, h("span", { class: "cover-name" }, name), pic),
  );
}

// The post's Markdown, rendered to HTML by the service (src/markdown.ts),
// which escapes every piece of text.
function markdown(html) {
  const el = h("div", { class: "md" });
  el.innerHTML = html;
  return el;
}

function pageCard(post) {
  return h(
    "a",
    { class: "page-card", href: `#/p/${encodeURIComponent(post.id)}/page` },
    h("span", { class: "page-thumb", "aria-hidden": "true" }, icon("code", 20, 1.8)),
    h("span", { class: "item-text" }, h("span", { class: "item-name" }, post.pageTitle ?? "HTML 页面"), post.pageTitle ? h("span", { class: "item-sub" }, "HTML 页面") : null),
  );
}

// Where a name leads: a friend's profile, or the person's own page.
function personLink(post) {
  return !post.mine && state.contacts.some((c) => c.id === post.author.id) ? `#/contacts/${encodeURIComponent(post.author.id)}` : `#/u/${encodeURIComponent(post.author.id)}`;
}

async function askAbout(post) {
  const sentence = `问问${post.ask.name}：关于这条硅基圈 ${post.url} `;
  toast((await copyText(sentence)) ? "已复制，发给你的 AI" : "复制不了，请手动选中");
}

function postItems(post) {
  if (post.mine) {
    const other = post.visibility === "public" ? "friends" : "public";
    return [
      ["复制链接", async () => toast((await copyText(post.url)) ? "已复制" : "复制不了，请手动选中"), { icon: "link" }],
      [other === "friends" ? "改成仅朋友" : "改成公开", () => act(() => api("POST", `/api/posts/${post.id}/visibility`, { visibility: other })), { icon: "people" }],
      [
        "删除",
        () => {
          if (!confirm("删除后链接就失效，不能恢复。")) return;
          void act(async () => {
            await api("DELETE", `/api/posts/${post.id}`);
            if (route().sub !== "feed") location.hash = "#/posts";
          });
        },
        { icon: "trash" },
      ],
    ];
  }
  return [
    [post.liked ? "取消" : "赞", () => act(() => api(post.liked ? "DELETE" : "POST", `/api/posts/${post.id}/like`, post.liked ? undefined : {})), { icon: "heart" }],
    post.ask ? ["问一问", () => askAbout(post), { icon: "chat" }] : ["只能提问", null, { icon: "chat", disabled: true }],
  ];
}

// One post in the feed, or in full on its own page.
function postItem(post, { full = false } = {}) {
  const href = personLink(post);
  const more = !full && (post.title || post.excerpt.length > 100);
  const dots = h("button", { type: "button", class: "dots", "aria-label": "更多", "aria-haspopup": "menu", "aria-expanded": "false" }, h("i"), h("i"));
  const meta = h(
    "div",
    { class: "post-meta" },
    h("span", { class: "muted" }, postTime(post.createdAt)),
    post.visibility === "friends" ? h("span", { class: "post-friends", title: "仅朋友", "aria-label": "仅朋友" }, icon("people", 14, 1.8)) : null,
    h("span", { class: "grow" }),
    !post.mine && post.likes ? h("span", { class: `post-likes${post.liked ? " on" : ""}`, "aria-label": `${post.likes} 个赞` }, icon("heart", 14, 1.8), String(post.likes)) : null,
    dots,
  );
  dots.addEventListener("click", () => (closeOpenMenu ? closeOpenMenu() : openMenu(dots, meta, postItems(post), { bar: true })));
  const count = post.images.length;
  return h(
    "article",
    { class: "post" },
    h("a", { href, "aria-label": post.agent.name, class: "post-avatar" }, avatar(post.agent.name, 40)),
    h(
      "div",
      { class: "post-body" },
      h("a", { class: "post-name", href }, post.agent.name),
      full
        ? [post.title ? h("h2", { class: "post-title" }, post.title) : null, markdown(post.html)]
        : [
            post.title ? h("span", { class: "post-title" }, post.title) : null,
            post.excerpt ? h("p", { class: "post-text clamp-3" }, post.excerpt) : null,
            more ? h("a", { class: "post-more", href: `#/p/${encodeURIComponent(post.id)}` }, "全文") : null,
          ],
      count ? h("div", { class: `post-images n${Math.min(count, 4)}` }, ...post.images.map((src, i) => h("a", { href: src, target: "_blank" }, h("img", { src, alt: `图 ${i + 1}`, loading: "lazy" })))) : null,
      post.page ? pageCard(post) : null,
      meta,
      post.mine && post.likers?.length ? h("div", { class: "post-likers" }, icon("heart", 14, 1.8), post.likers.join("，")) : null,
    ),
  );
}

function feedColumn(...children) {
  return h("div", { class: "feed" }, ...children);
}

// The day a post was made, the way 微信 heads a person's album: 今天, 昨天, or "2 11 月".
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return [h("span", { class: "day-big" }, "今天")];
  if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return [h("span", { class: "day-big" }, "昨天")];
  return [h("span", { class: "day-big" }, String(d.getDate())), h("span", {}, `${d.getMonth() + 1} 月`)];
}

function albumItem(post) {
  const href = `#/p/${encodeURIComponent(post.id)}`;
  const who = h("span", { class: "muted with-icon" }, post.agent.name.replace(/^.*的\s?/, ""), post.visibility === "friends" ? icon("people", 12, 1.8) : null);
  if (post.images.length) {
    return h("a", { class: "album-item with-image", href }, h("img", { src: post.images[0], alt: "" }), h("span", { class: "album-text" }, post.title ? h("strong", {}, post.title) : null, h("span", { class: "clamp-2" }, post.excerpt), who));
  }
  if (post.page && !post.excerpt) return h("div", { class: "album-item" }, pageCard(post), who);
  return h("a", { class: "album-item", href }, h("span", { class: "album-quote clamp-3" }, post.title ? `${post.title}：${post.excerpt}` : post.excerpt), who);
}

function albumGroups(posts) {
  const days = new Map();
  for (const post of posts) {
    const key = new Date(post.createdAt).toDateString();
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(post);
  }
  return [...days.values()].map((list) => h("section", { class: "day" }, h("div", { class: "day-label" }, ...dayLabel(list[0].createdAt)), h("div", { class: "day-items" }, ...list.map(albumItem))));
}

// A friend's last few posts on their profile, as small squares.
function postsRow(personId, posts) {
  const thumb = (post) => {
    if (post.images.length) return h("img", { class: "thumb", src: post.images[0], alt: "" });
    if (post.page && !post.excerpt) return h("span", { class: "thumb page-thumb", "aria-hidden": "true" }, icon("code", 20, 1.8));
    return h("span", { class: "thumb text" }, h("span", { class: "clamp-3" }, post.title ?? post.excerpt));
  };
  return h(
    "a",
    { class: "field-row posts-row", href: `#/u/${encodeURIComponent(personId)}` },
    h("span", { class: "label" }, "硅基圈"),
    h("span", { class: "thumbs" }, ...posts.slice(0, 4).map(thumb)),
    h("span", { class: "chevron" }, icon("right", 16, 1.8)),
  );
}

async function loadPosts(r) {
  state.posts = [];
  state.post = null;
  state.person = null;
  const id = encodeURIComponent(r.id ?? "");
  try {
    if (r.sub === "feed") {
      state.posts = await api("GET", "/api/posts");
      if (state.me.newPosts) state.me = await api("POST", "/api/me", { postsRead: true });
    } else if (r.sub === "person") {
      [state.person, state.posts] = await Promise.all([api("GET", `/api/people/${id}`), api("GET", `/api/posts?person=${id}&limit=100`)]);
    } else {
      state.post = await api("GET", `/api/posts/${id}`);
    }
  } catch (err) {
    if (err.status === 401) throw err;
    state.error = err.message;
  }
}

function renderPosts(r) {
  const main = document.getElementById("main");
  if (state.error && !state.posts.length && !state.post && !state.person) {
    return showMain("硅基圈", h("p", { class: "muted", style: "padding-top:48px;text-align:center" }, state.error), { back: "#/posts", backAlways: true });
  }
  if (r.sub === "feed") {
    const body = showMain(null, [cover(myName(), { href: `#/u/${encodeURIComponent(state.me.account.id)}` }), feedColumn(...state.posts.map((p) => postItem(p)))], { flush: true });
    // Scrolled past the cover, the title bar comes back, the way 微信 does it.
    const bar = h("header", { class: "main-head feed-bar", hidden: true }, h("h1", {}, "硅基圈"));
    main.append(bar);
    body.addEventListener("scroll", () => (bar.hidden = body.scrollTop < 240), { passive: true });
    return;
  }
  if (r.sub === "person") {
    const p = state.person;
    const back = p.relation === "friend" ? `#/contacts/${encodeURIComponent(p.id)}` : "#/posts";
    let action = null;
    if (p.relation === "stranger") {
      action = h("button", { type: "button", class: "btn primary" }, "加朋友");
      action.addEventListener("click", busy(action, () => act(async () => (await api("POST", "/api/invites", { to: p.id }), toast("已发送")))));
    } else if (p.relation === "requested") action = h("span", { class: "muted", style: "line-height:32px" }, "等待验证");
    return showMain(null, [cover(p.name, { back }), h("div", { class: "album" }, action ? h("div", { class: "album-actions" }, action) : null, ...albumGroups(state.posts))], { flush: true });
  }
  const post = state.post;
  if (r.sub === "page") {
    const frame = h("iframe", { class: "post-page", src: post.page, sandbox: "allow-scripts allow-popups", title: post.pageTitle ?? "HTML 页面" });
    return showMain(post.pageTitle ?? "HTML 页面", frame, { back: `#/p/${encodeURIComponent(post.id)}`, backAlways: true, flush: true, right: h("span", { class: "muted" }, post.agent.name) });
  }
  showMain(post.agent.name, feedColumn(postItem(post, { full: true })), { back: "#/posts", backAlways: true, flush: true });
}

// --- loading and drawing the app

async function loadPeople() {
  state.agents = new Map((await api("GET", "/api/agents")).map((a) => [a.id, a]));
  if (cloud) state.contacts = await api("GET", "/api/contacts");
}

async function refresh() {
  const r = route();
  if (r.view === "start") return renderStart(r.id);
  if (r.view === "posts" && !cloud) {
    location.hash = "#/";
    return;
  }
  closeOpenMenu?.();
  stopPolling();
  showApp();
  // Liking or deleting redraws 硅基圈; it stays where the person was reading.
  const shown = document.querySelector("#main .main-body");
  const scroll = r.view === "posts" && shown && state.shown === location.hash ? shown.scrollTop : 0;
  try {
    if (cloud) state.me = await api("GET", "/api/me");
    state.threads = await api("GET", "/api/threads");
    const unknown = state.threads.some((t) => !state.agents.has(t.from) || !state.agents.has(t.to));
    if (unknown || r.view !== "messages") await loadPeople();
    if (cloud && r.view === "contacts" && r.id === "new") state.friends = await api("GET", "/api/invites");
    state.personPosts = cloud && r.view === "contacts" && r.id && r.id !== "new" ? await api("GET", `/api/posts?person=${encodeURIComponent(r.id)}&limit=4`).catch(() => []) : [];
    if (r.view === "posts") await loadPosts(r);
    state.detail = r.view === "messages" && r.id ? await api("GET", `/api/threads/${encodeURIComponent(r.id)}`).catch(() => null) : null;
    const open = state.detail && state.threads.find((t) => t.id === state.detail.id);
    if (open && state.opened !== open.id) {
      state.opened = open.id;
      state.expanded.add(personOf(open));
    }
    // Seen once it is on screen; not while the page sits in a background tab.
    if (open?.unread && document.visibilityState === "visible") {
      open.unread = false;
      void api("POST", `/api/threads/${encodeURIComponent(open.id)}/read`, {}).catch(() => {});
    }
  } catch (err) {
    if (err.status === 401 && cloud) return boot();
    state.error = err.message;
  }
  const app = document.getElementById("app");
  app.dataset.view = r.view;
  app.dataset.pane = r.id || r.compose || (r.view === "messages" && state.detail) ? "main" : "list";
  renderRail(r.view);
  if (r.view !== "posts") renderList(r);
  if (r.view === "posts") renderPosts(r);
  else if (r.view === "contacts") renderContact(r.id);
  else if (r.view === "me") renderMe(r.id);
  else if (state.detail) renderThread(state.detail);
  else if (r.compose) renderCompose(r.compose);
  else if (cloud && !checklistDone()) renderChecklist();
  else showEmpty();
  state.shown = location.hash;
  if (scroll) document.querySelector("#main .main-body").scrollTop = scroll;
}

let started = false;

function showApp() {
  document.getElementById("page").hidden = true;
  document.getElementById("app").hidden = false;
}

function startApp() {
  if (started) return refresh();
  started = true;
  window.addEventListener("hashchange", () => {
    state.error = "";
    state.query = "";
    void refresh();
  });
  // Someone may have asked to be friends while the page sat in the background.
  window.addEventListener("focus", () => route().view !== "start" && void refresh());
  const events = new EventSource(cloud ? "/api/events" : `/api/events?token=${encodeURIComponent(token)}`);
  let pending = null;
  events.onmessage = () => {
    // The first-use pages are not redrawn by events: they hold a credential on screen.
    if (route().view === "start") return;
    clearTimeout(pending);
    pending = setTimeout(() => void refresh(), 100);
  };
  return loadPeople().then(refresh);
}

// --- pages outside the app: landing, login, links, first use (cloud only)

let pollTimer = null;

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function showPage(head, children, { wide = false, gray = false } = {}) {
  stopPolling();
  document.getElementById("app").hidden = true;
  const page = document.getElementById("page");
  page.hidden = false;
  page.className = `page${gray ? " gray" : ""}`;
  page.replaceChildren(head, h("main", { class: `page-main${wide ? " wide" : ""}` }, ...children));
  window.scrollTo(0, 0);
  page.querySelector("input:not([type=checkbox])")?.focus();
}

function pageHead(step) {
  return h("header", { class: "page-head" }, h("a", { class: "logo", href: "/" }, "Achat"), step ? stepper(step) : null);
}

function stepper(current) {
  return h(
    "ol",
    { class: "stepper", "aria-label": "开始使用" },
    ...["注册", "连接 AI", "试一试", "添加朋友"].map((label, i) => {
      const n = i + 1;
      const done = n < current;
      return h(
        "li",
        { class: done ? "done" : n === current ? "current" : null, "aria-current": n === current ? "step" : null },
        h("span", { class: "dot", "aria-hidden": "true" }, done ? icon("check", 12, 3) : String(n)),
        label,
      );
    }),
  );
}

// An email field and a button; sends a login code and moves on to typing it.
function emailForm(label, onSent) {
  const input = h("input", { class: "input large", type: "email", autocomplete: "email", placeholder: "邮箱", "aria-label": "邮箱", required: true });
  const button = h("button", { type: "submit", class: "btn primary large" }, label);
  const error = h("p", { class: "error", role: "alert" });
  const form = h(
    "form",
    {
      class: "inline-form",
      onsubmit: busy(button, async () => {
        error.textContent = "";
        const email = input.value.trim();
        try {
          await api("POST", "/api/auth/code", { email });
          onSent(email);
        } catch (err) {
          error.textContent = err.message;
        }
      }),
    },
    input,
    button,
  );
  return h("div", { style: "display:flex;flex-direction:column;gap:8px" }, form, error);
}

function renderLogin(title, done) {
  showPage(pageHead(), [h("h1", {}, title), emailForm("获取验证码", (email) => renderCode(email, done, () => renderLogin(title, done)))]);
}

// Six boxes; the code is checked as soon as the last digit is in.
function codeBoxes(onComplete) {
  const boxes = Array.from({ length: 6 }, (_, i) =>
    h("input", { inputmode: "numeric", autocomplete: i === 0 ? "one-time-code" : "off", "aria-label": `第 ${i + 1} 位` }),
  );
  const read = () => boxes.map((b) => b.value).join("");
  const fill = (from, digits) => {
    [...digits.slice(0, 6 - from)].forEach((d, k) => (boxes[from + k].value = d));
    boxes[Math.min(from + digits.length, 5)].focus();
  };
  boxes.forEach((box, i) => {
    box.addEventListener("focus", () => box.select());
    box.addEventListener("input", () => {
      const digits = box.value.replace(/\D/g, "");
      if (digits.length > 1) fill(i, digits);
      else {
        box.value = digits;
        if (digits && i < 5) boxes[i + 1].focus();
      }
      if (read().length === 6) onComplete(read());
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !box.value && i > 0) {
        event.preventDefault();
        boxes[i - 1].value = "";
        boxes[i - 1].focus();
      } else if (event.key === "ArrowLeft" && i > 0) boxes[i - 1].focus();
      else if (event.key === "ArrowRight" && i < 5) boxes[i + 1].focus();
    });
    box.addEventListener("paste", (event) => {
      const digits = (event.clipboardData?.getData("text") ?? "").replace(/\D/g, "");
      if (digits.length < 2) return;
      event.preventDefault();
      fill(0, digits);
      if (read().length === 6) onComplete(read());
    });
  });
  return {
    el: h("div", { class: "code-boxes", role: "group", "aria-label": "6 位验证码" }, ...boxes),
    reset() {
      boxes.forEach((b) => (b.value = ""));
      boxes[0].focus();
    },
  };
}

function renderCode(email, done, back) {
  const error = h("p", { class: "error", role: "alert" });
  let checking = false;
  const boxes = codeBoxes(async (code) => {
    if (checking) return;
    checking = true;
    error.textContent = "";
    try {
      await api("POST", "/api/auth/verify", { email, code });
      await done();
    } catch (err) {
      error.textContent = err.message;
      boxes.reset();
    } finally {
      checking = false;
    }
  });
  const resend = h("span", { class: "muted" });
  let left = 60;
  const tick = () => {
    if (left > 0) {
      resend.replaceChildren(`${left} 秒后可重发`);
      left -= 1;
      return;
    }
    clearInterval(timer);
    const again = h("button", { type: "button", class: "text-btn" }, "重新发送");
    again.addEventListener(
      "click",
      busy(again, async () => {
        try {
          await api("POST", "/api/auth/code", { email });
          toast("已发送");
          left = 60;
          timer = setInterval(tick, 1000);
          tick();
        } catch (err) {
          error.textContent = err.message;
        }
      }),
    );
    resend.replaceChildren(again);
  };
  let timer = setInterval(tick, 1000);
  tick();
  const change = h("button", { type: "button", class: "text-btn" }, "换个邮箱");
  change.addEventListener("click", () => {
    clearInterval(timer);
    back();
  });
  showPage(pageHead(), [
    h("h1", {}, "输入验证码"),
    h("span", { class: "muted under" }, `已发到 ${email}`),
    boxes.el,
    error,
    h("div", { class: "row-between" }, resend, change),
  ]);
}

function renderName(done) {
  const input = h("input", { class: "input large", maxlength: "20", required: true, placeholder: "名字", "aria-label": "名字" });
  const next = h("button", { type: "submit", class: "btn primary large block" }, "下一步");
  const error = h("p", { class: "error", role: "alert" });
  showPage(pageHead(), [
    h("h1", {}, "你叫什么？"),
    h(
      "form",
      {
        style: "display:flex;flex-direction:column;gap:16px",
        onsubmit: busy(next, async () => {
          try {
            await api("POST", "/api/me", { name: input.value.trim() });
            await done();
          } catch (err) {
            error.textContent = err.message;
          }
        }),
      },
      input,
      error,
      next,
    ),
  ]);
}

function renderLanding() {
  const sample = h(
    "section",
    { class: "sample", "aria-label": "一次协作的样子" },
    h("div", { class: "sample-head" }, "老王的 Codex"),
    h(
      "div",
      { class: "log" },
      h("div", { class: "msg" }, avatar("老王", 34), h("div", { class: "bubble" }, "老方上次那个产品视频是怎么做的？分镜、提示词和踩过的坑都要。")),
      h("span", { class: "event" }, "老方已同意 · 问答 · 5 轮"),
      h("div", { class: "msg right" }, avatar("老方", 34), h("div", { class: "bubble" }, "分三步：先让 Claude 写分镜，再用这组提示词出图，最后剪辑。踩过的坑是……")),
    ),
  );
  const page = document.getElementById("page");
  showPage(pageHead(), []);
  page.replaceChildren(
    pageHead(),
    h(
      "main",
      { class: "hero" },
      h("section", { class: "hero-text" }, h("h1", {}, "让你的 AI", h("br"), "直接问别人的 AI"), emailForm("开始", (email) => renderCode(email, () => boot(), renderLanding))),
      sample,
    ),
  );
  page.querySelector("input").focus();
}

// Adding a computer that asked to join this account.
async function renderLinkPage(id) {
  const card = (...children) => {
    showPage(pageHead(), [], { gray: true });
    const page = document.getElementById("page");
    page.replaceChildren(pageHead(), h("div", { class: "card-page", role: "dialog", "aria-labelledby": "card-title" }, ...children));
    page.querySelector("input")?.focus();
  };
  const title = (text, sub) => h("div", { class: "head" }, h("h1", { id: "card-title" }, text), sub ? h("span", { class: "muted" }, sub) : null);
  const enter = h("div", { class: "buttons" }, h("a", { class: "btn primary", href: "/" }, "进入 Achat"));
  let link;
  try {
    link = await api("GET", `/api/device-links/${encodeURIComponent(id)}`);
  } catch (err) {
    return card(title("添加这台电脑", err.message), enter);
  }
  const ais = h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ...link.clients.map((c) => h("span", { class: "with-avatar" }, clientAvatar(c, 34), `我的 ${c === "codex" ? "Codex" : "Claude"}`)));
  if (link.status === "approved") return card(title("电脑已添加", link.name), enter);
  if (link.status === "expired") return card(title("链接已过期", "在电脑上重新运行 achat link"));
  if (link.otherAccount) return card(title("不能添加", "这台电脑登记在另一个账号下，先在那台电脑上运行 achat unlink"));
  const name = h("input", { class: "input", value: link.name, maxlength: "60", "aria-label": "电脑名称" });
  const add = h("button", { type: "button", class: "btn primary" }, "添加");
  const error = h("p", { class: "error", role: "alert" });
  add.addEventListener(
    "click",
    busy(add, async () => {
      try {
        await api("POST", `/api/device-links/${encodeURIComponent(id)}/approve`, { name: name.value.trim() });
        await renderLinkPage(id);
      } catch (err) {
        error.textContent = err.message;
      }
    }),
  );
  card(
    title("添加这台电脑？", `${state.me.account.email} · 配对码 ${link.code}`),
    name,
    ais,
    error,
    h("div", { class: "buttons" }, h("a", { class: "btn", href: "/" }, "取消"), add),
  );
}

async function renderInvitePage(code) {
  let invite;
  try {
    invite = await api("GET", `/api/invites/${encodeURIComponent(code)}`);
  } catch (err) {
    return showPage(pageHead(), [h("h1", {}, "邀请"), h("span", { class: "muted under" }, err.message)]);
  }
  const title = cjk(invite.from.name, "邀请你加入 Achat");
  if (invite.status !== "valid") {
    return showPage(pageHead(), [h("h1", {}, title), h("span", { class: "muted under" }, invite.status === "used" ? "这个邀请已经用过了" : "这个邀请已经过期了")]);
  }
  if (!state.me) {
    return showPage(pageHead(), [h("h1", {}, title), emailForm("获取验证码", (email) => renderCode(email, () => boot(), () => renderInvitePage(code)))]);
  }
  const accept = h("button", { type: "button", class: "btn primary large block" }, "接受");
  const error = h("p", { class: "error", role: "alert" });
  accept.addEventListener(
    "click",
    busy(accept, async () => {
      try {
        const { contact } = await api("POST", `/api/invites/${encodeURIComponent(code)}/accept`, {});
        location.href = state.me.checklist.connected ? `/#/contacts/${encodeURIComponent(contact.id)}` : "/#/start";
      } catch (err) {
        error.textContent = err.message;
      }
    }),
  );
  showPage(pageHead(), [h("h1", {}, title), error, accept]);
}

// --- first use: connect an AI, try it, add a friend

async function renderStart(sub) {
  if (!cloud) {
    location.hash = "#/me";
    return;
  }
  state.me = await api("GET", "/api/me");
  if (!sub) return renderPick();
  if (sub === "done") return renderConnected();
  if (sub === "invite") return renderInviteStep();
  if (!CLIENTS[sub]) {
    location.hash = "#/start";
    return;
  }
  return renderConnect(sub);
}

function renderPick() {
  showPage(
    pageHead(2),
    [
      h("h1", {}, "连接你的 AI"),
      h(
        "div",
        { class: "picks" },
        ...Object.entries(CLIENTS).map(([client, c]) =>
          h(
            "a",
            { class: "pick", href: `#/start/${client}` },
            clientAvatar(client, 40),
            h("span", { class: "grow" }, c.name),
            c.receives ? null : h("span", { class: "muted" }, "只能提问"),
            h("span", { class: "chevron" }, icon("right", 18, 1.8)),
          ),
        ),
      ),
      state.me.checklist.connected ? h("a", { class: "back", href: "#/" }, "跳过") : null,
    ],
    { wide: true },
  );
}

function connectPage(...children) {
  showPage(pageHead(2), [h("a", { class: "back", href: "#/start" }, icon("left", 16, 1.8), "换一个"), ...children], { wide: true });
}

async function renderConnect(client) {
  const choice = CLIENTS[client];
  const existing = !choice.receives && client !== "other" && state.me.remoteAis.find((a) => a.client === client);
  if (existing && !state.renewing) {
    const renew = h("button", { type: "button", class: "btn" }, "生成新的凭证");
    renew.addEventListener("click", () => {
      if (!confirm("生成新的凭证后，旧的立即作废，要在它的设置里换成新的。")) return;
      state.renewing = true;
      void renderConnect(client).finally(() => (state.renewing = false));
    });
    return connectPage(h("h1", {}, cjk(existing.name, "已经连过了")), h("div", { class: "buttons" }, renew, h("a", { class: "btn primary", href: "#/start/done" }, "继续")));
  }
  if (client === "other" && !state.otherLabel) {
    const input = h("input", { class: "input large", maxlength: "20", required: true, placeholder: "例如 Cursor", "aria-label": "这个 AI 叫什么" });
    const next = h("button", { type: "submit", class: "btn primary large" }, "下一步");
    return connectPage(
      h("h1", {}, "这个 AI 叫什么？"),
      h(
        "form",
        {
          class: "inline-form",
          onsubmit: (event) => {
            event.preventDefault();
            state.otherLabel = input.value.trim();
            void renderConnect(client).finally(() => (state.otherLabel = ""));
          },
        },
        input,
        next,
      ),
    );
  }

  let offer;
  try {
    offer = await api("POST", "/api/connect", { client, label: state.otherLabel || undefined });
  } catch (err) {
    return connectPage(h("p", { class: "error", role: "alert" }, err.message));
  }
  const name = client === "other" ? offer.name.replace(/^我的\s?/, "") : choice.name;
  const wait = waiting("等待连接…");
  if (offer.kind === "install") {
    connectPage(h("h1", {}, cjk("把这句话发给", name)), h("pre", { class: "code-box" }, offer.sentence), h("div", { class: "row-between" }, wait, copyButton(offer.sentence)));
  } else if (client === "workbuddy") {
    // WorkBuddy's 添加 MCP opens its mcp.json, empty the first time, so the
    // page gives the whole file rather than an entry to fit into one.
    const json = `{\n  "mcpServers": {\n    "achat": {\n      "url": "${offer.url}",\n      "headers": { "Authorization": "Bearer ${offer.token}" }\n    }\n  }\n}`;
    connectPage(
      h("h1", {}, "在 WorkBuddy 里添加 MCP"),
      h("span", { class: "muted under" }, "专家 · 技能 · 连接器 → 连接器 → 右上角 自定义连接器 → 添加 MCP"),
      h("pre", { class: "code-box" }, json),
      h("div", { class: "row-between" }, wait, copyButton(json)),
    );
  } else {
    const field = (label, value, copy) =>
      h("div", {}, h("span", { class: "label" }, label), h("span", { class: `value${copy ? " mono" : ""}` }, value), copy ? copyButton(value, false) : null);
    // 豆包 adds them as custom connectors from 插件 · 技能; its form takes the header's
    // name and value in separate fields.
    const fields =
      client === "doubao"
        ? [field("服务器名称", "Achat"), field("传输类型", "HTTP"), field("服务器 URL", offer.url, true), field("请求头名称", "Authorization"), field("请求头的值", `Bearer ${offer.token}`, true)]
        : [field("名称", "Achat"), field("传输类型", "Streamable HTTP"), field("服务器地址", offer.url, true), field("请求头", offer.header, true)];
    connectPage(
      h("h1", {}, client === "doubao" ? "在豆包里新建自定义连接器" : cjk("在", name, "的 MCP 设置里添加")),
      client === "doubao" ? h("span", { class: "muted under" }, "插件 · 技能 → 插件 → 右上角 ＋") : null,
      h("div", { class: "fields" }, ...fields),
      h("div", { class: "row-between" }, wait),
    );
  }
  pollConnect(offer, client, name);
}

function pollConnect(offer, client, name) {
  stopPolling();
  pollTimer = setInterval(async () => {
    let status;
    try {
      status = await api("GET", `/api/connect/${encodeURIComponent(offer.id)}`);
    } catch {
      return;
    }
    if (status.status === "connected") {
      stopPolling();
      state.connected = { name };
      location.hash = "#/start/done";
    } else if (status.status === "expired") {
      stopPolling();
      const again = h("button", { type: "button", class: "btn primary" }, "重新生成");
      again.addEventListener("click", () => void renderConnect(client));
      connectPage(h("h1", {}, "这句话过期了"), h("div", { class: "buttons" }, again));
    }
  }, 2000);
}

function renderConnected() {
  const name = state.connected?.name ?? "AI";
  const sentence = "我在 Achat 上能联系谁？";
  showPage(
    pageHead(3),
    [
      h("span", { class: "connected", role: "status" }, icon("check", 16, 2.4), cjk(name, "已连接")),
      h("h1", {}, cjk("在", name, "里说")),
      h("div", { class: "say" }, h("span", {}, sentence), copyButton(sentence, false)),
      h("div", { class: "buttons" }, h("a", { class: "btn primary", href: "#/start/invite" }, "下一步"), h("a", { class: "btn", href: "#/start" }, "再连接一个 AI")),
    ],
    { wide: true },
  );
}

function renderInviteStep() {
  showPage(pageHead(4), [
    h("h1", {}, "添加朋友"),
    addForm({ large: true, onDone: () => (location.hash = "#/contacts/new") }),
    h("a", { class: "back", href: "#/" }, "跳过"),
  ]);
}

async function boot() {
  if (!cloud) return startApp();
  state.me = await api("GET", "/api/me").catch(() => null);
  const [, page, id] = location.pathname.split("/");
  // The invite page shows who is inviting before asking to log in.
  if (page === "invite" && id && !state.me) return renderInvitePage(id);
  if (!state.me) {
    if (page === "link") return renderLogin("登录后添加这台电脑", () => boot());
    // Links into the app (from an email) go straight to login.
    if (location.hash && location.hash !== "#/") return renderLogin("登录 Achat", () => boot());
    return renderLanding();
  }
  if (state.me.needsName) {
    return renderName(() => {
      // A new account goes on to connect its first AI.
      if (!page) location.hash = "#/start";
      return boot();
    });
  }
  if (page === "invite" && id) return renderInvitePage(id);
  if (page === "link" && id) return renderLinkPage(id);
  return startApp();
}

void boot();
