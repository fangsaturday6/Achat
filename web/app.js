const token = window.ACHAT_TOKEN;
const STATUS = { pending: "待批准", active: "进行中", declined: "已拒绝", closed: "已结束", stopped: "已停止" };

const state = { agents: new Map(), threads: [], detail: null, error: "" };

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "x-achat-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

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

function agentName(id) {
  return state.agents.get(id)?.name ?? id;
}

function avatar(id, size) {
  const agent = state.agents.get(id);
  const name = agent?.name ?? id;
  const mine = name.startsWith("我");
  const initial = mine ? "我" : name.replace(/的.*$/, "").slice(-1);
  const client = agent?.client === "codex" ? "Cx" : "Cl";
  return h(
    "span",
    {
      class: `avatar ${mine ? "mine" : "theirs"}`,
      style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`,
      "aria-hidden": "true",
    },
    initial,
    h("span", { class: "client" }, client),
  );
}

function shortTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function route() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/contacts")) return { view: "contacts", id: hash.split("/")[2] ?? null };
  if (hash.startsWith("#/t/")) return { view: "messages", id: hash.slice(4) };
  return { view: "messages", id: null };
}

function renderRail(view) {
  for (const [id, name] of [["nav-messages", "messages"], ["nav-contacts", "contacts"]]) {
    const el = document.getElementById(id);
    if (view === name) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  const pending = state.threads.filter((t) => t.status === "pending").length;
  const badge = document.getElementById("pending-badge");
  badge.hidden = pending === 0;
  badge.textContent = String(pending);
  document.getElementById("nav-messages").setAttribute("aria-label", pending ? `消息，${pending} 个待批准` : "消息");
}

function renderList(r) {
  const list = document.getElementById("list");
  document.getElementById("list-title").textContent = r.view === "contacts" ? "联系人" : "消息";
  if (r.view === "contacts") {
    list.replaceChildren(
      ...[...state.agents.values()].map((a) =>
        h(
          "a",
          { class: "item", href: `#/contacts/${encodeURIComponent(a.id)}`, "aria-current": r.id === a.id ? "true" : null },
          avatar(a.id, 36),
          h("span", { class: "item-text" }, h("span", { class: "item-name" }, a.name)),
        ),
      ),
    );
    return;
  }
  if (!state.threads.length) {
    list.replaceChildren(h("p", { class: "empty" }, "还没有协作。在 Codex 里说“问问我的 Claude……”试试。"));
    return;
  }
  list.replaceChildren(
    ...state.threads.map((t) => {
      const last = t.lastMessage;
      const preview = t.status === "pending" || !last || last.kind === "system" ? t.topic : last.body;
      return h(
        "a",
        { class: "item", href: `#/t/${t.id}`, "aria-current": r.id === t.id ? "true" : null },
        avatar(t.from, 40),
        h(
          "span",
          { class: "item-text" },
          h(
            "span",
            { class: "item-row" },
            h("span", { class: "item-name" }, agentName(t.from)),
            h("span", { class: "item-time" }, shortTime(t.updatedAt)),
          ),
          h(
            "span",
            { class: "item-preview" },
            t.status === "pending" ? h("span", { class: "tag-pending" }, "[待批准] ") : null,
            preview,
          ),
        ),
      );
    }),
  );
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

function requestCard(t) {
  const request = t.messages.find((m) => m.kind === "request");
  const rounds = h("input", { type: "number", min: "1", max: "20", value: String(t.scope.maxRounds), "aria-label": "最多轮数" });
  const budget = h("input", { type: "number", min: "0.1", max: "50", step: "0.1", value: t.scope.budgetUsd.toFixed(2), "aria-label": "花费上限（美元）" });
  return h(
    "article",
    { class: "card", "aria-labelledby": "req-title" },
    h("div", { class: "card-body" }, h("h2", { id: "req-title" }, t.topic), h("p", {}, request?.body ?? "")),
    h(
      "div",
      { class: "scope" },
      h("span", {}, `${agentName(t.to)} 回答 · 只读对话记录`),
      h("label", {}, rounds, "轮"),
      h("label", {}, "$", budget),
    ),
    state.error ? h("p", { class: "error", role: "alert" }, state.error) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", onclick: () => act(() => api("POST", `/api/threads/${t.id}/decline`, {})) }, "拒绝"),
      h(
        "button",
        {
          type: "button",
          onclick: () =>
            act(() =>
              api("POST", `/api/threads/${t.id}/approve`, {
                maxRounds: Number(rounds.value),
                budgetUsd: Number(budget.value),
              }),
            ),
        },
        "同意",
      ),
    ),
  );
}

function renderThread(t) {
  const log = h("div", { class: "log", role: "log", "aria-label": "对话原文" });
  log.append(h("span", { class: "time" }, shortTime(t.createdAt)));
  for (const m of t.messages) {
    if (m.kind === "request" && t.status === "pending") {
      log.append(h("div", { class: "row" }, avatar(t.from, 36), requestCard(t)));
      continue;
    }
    if (m.kind === "system") {
      log.append(h("span", { class: "system" }, m.body));
      continue;
    }
    const mine = m.sender === t.to;
    log.append(
      h(
        "div",
        { class: `row${mine ? " mine" : ""}` },
        avatar(m.sender, 36),
        h(
          "div",
          { class: "bubble" },
          m.body,
          m.redactions > 0 ? h("span", { class: "filtered" }, `已过滤 ${m.redactions} 处`) : null,
        ),
      ),
    );
  }
  const lastSpoken = t.messages.filter((m) => m.kind !== "system").at(-1);
  if (t.status === "active" && lastSpoken?.sender === t.from) {
    log.append(
      h(
        "div",
        { class: "row mine" },
        avatar(t.to, 36),
        h("span", { class: "typing", role: "img", "aria-label": `${agentName(t.to)}正在回复` }, h("i"), h("i"), h("i")),
      ),
    );
  }

  const foot =
    t.status === "pending"
      ? null
      : h(
          "footer",
          { class: "foot" },
          h(
            "span",
            {},
            `${t.roundsUsed} / ${t.scope.maxRounds} 轮 · $${t.costUsd.toFixed(2)} / $${t.scope.budgetUsd.toFixed(2)}`,
            t.status === "active" ? "" : ` · ${STATUS[t.status]}`,
          ),
          t.status === "active"
            ? h("button", { type: "button", onclick: () => act(() => api("POST", `/api/threads/${t.id}/stop`, {})) }, "停止")
            : null,
        );

  const chat = document.getElementById("chat");
  const head = h(
    "header",
    { class: "chat-head" },
    h("h1", {}, agentName(t.from)),
    h("span", { class: "topic" }, `${t.topic} · ${STATUS[t.status]}`),
  );
  chat.replaceChildren(...[head, log, foot].filter(Boolean));
  log.scrollTop = log.scrollHeight;
}

function renderContact(id) {
  const chat = document.getElementById("chat");
  const agent = state.agents.get(id);
  if (!agent) {
    chat.replaceChildren(h("p", { class: "placeholder" }, "选择一个联系人"));
    return;
  }
  const count = state.threads.filter((t) => t.from === id || t.to === id).length;
  chat.replaceChildren(
    h(
      "div",
      { class: "profile" },
      h(
        "div",
        { class: "profile-inner" },
        h("div", { class: "profile-head" }, avatar(id, 64), h("div", {}, h("h1", {}, agent.name), h("span", { class: "profile-meta" }, agent.id))),
        h("span", { class: "profile-meta" }, `${count} 次协作`),
      ),
    ),
  );
}

async function refresh() {
  const r = route();
  state.threads = await api("GET", "/api/threads");
  if (r.view === "messages" && r.id) {
    try {
      state.detail = await api("GET", `/api/threads/${r.id}`);
    } catch {
      state.detail = null;
    }
  } else {
    state.detail = null;
  }
  renderRail(r.view);
  renderList(r);
  if (r.view === "contacts") renderContact(r.id ? decodeURIComponent(r.id) : null);
  else if (state.detail) renderThread(state.detail);
  else document.getElementById("chat").replaceChildren(h("p", { class: "placeholder" }, "选择一个协作"));
}

async function main() {
  for (const a of await api("GET", "/api/agents")) state.agents.set(a.id, a);
  window.addEventListener("hashchange", () => {
    state.error = "";
    void refresh();
  });
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  let pending = null;
  events.onmessage = () => {
    clearTimeout(pending);
    pending = setTimeout(() => void refresh(), 100);
  };
  await refresh();
}

void main();
