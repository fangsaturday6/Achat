// One page for both setups: on this computer (experiment 0) the relay fills in
// a token; in the cloud the token is empty and the login cookie is used.
const token = window.ACHAT_TOKEN;
const cloud = !token;
const STATUS = { pending: "待批准", active: "进行中", declined: "已拒绝", closed: "已结束", stopped: "已停止" };

const BADGES = { claude: "Cl", codex: "Cx", doubao: "豆", workbuddy: "WB", other: "AI" };

const state = { me: null, agents: new Map(), contacts: [], threads: [], detail: null, invite: null, error: "" };

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

function isMine(id) {
  return agentName(id).startsWith("我");
}

function initialOf(name) {
  return name.replace(/的.*$/, "").slice(-1) || "?";
}

function avatar(id, size, label, self = false) {
  const agent = state.agents.get(id);
  const name = label ?? agent?.name ?? id;
  const mine = self || name.startsWith("我");
  const initial = mine && !self ? "我" : initialOf(name);
  return h(
    "span",
    {
      class: `avatar ${mine ? "mine" : "theirs"}`,
      style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`,
      "aria-hidden": "true",
    },
    initial,
    agent ? h("span", { class: "client" }, BADGES[agent.client] ?? "AI") : null,
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
  if (hash.startsWith("#/me")) return { view: "me", id: null };
  if (hash.startsWith("#/start")) return { view: "start", id: hash.split("/")[2] ?? "" };
  if (hash.startsWith("#/t/")) return { view: "messages", id: hash.slice(4) };
  return { view: "messages", id: null };
}

function errorLine() {
  return state.error ? h("p", { class: "error", role: "alert" }, state.error) : null;
}

// --- pages outside the app: login, adding a computer, invites

function showGate(...children) {
  document.getElementById("app").hidden = true;
  const gate = document.getElementById("gate");
  gate.hidden = false;
  gate.replaceChildren(h("div", { class: "panel" }, h("span", { class: "brand" }, "Achat"), ...children));
  gate.querySelector("input")?.focus();
}

function busy(button, fn) {
  return async (event) => {
    event?.preventDefault();
    button.disabled = true;
    try {
      await fn();
    } finally {
      button.disabled = false;
    }
  };
}

function copyBlock(text) {
  const button = h("button", { type: "button", class: "btn" }, "复制");
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    button.textContent = "已复制";
  });
  return h("div", { class: "copy" }, h("pre", {}, text), h("div", { class: "buttons" }, button));
}

function renderLogin(title, done) {
  let email = "";
  const emailInput = h("input", { type: "email", autocomplete: "email", required: true, id: "email" });
  const send = h("button", { type: "submit", class: "btn primary" }, "获取验证码");
  const error = h("p", { class: "error", role: "alert" });
  const step1 = h(
    "form",
    {
      class: "panel-form",
      onsubmit: busy(send, async () => {
        error.textContent = "";
        email = emailInput.value.trim();
        try {
          await api("POST", "/api/auth/code", { email });
          step2Show();
        } catch (err) {
          error.textContent = err.message;
        }
      }),
    },
    h("label", { class: "field", for: "email" }, "邮箱", emailInput),
    h("div", { class: "buttons" }, send),
  );
  showGate(h("h1", {}, title), step1, error);

  function step2Show() {
    const codeInput = h("input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", required: true, id: "code" });
    const login = h("button", { type: "submit", class: "btn primary" }, "登录");
    const again = h("button", { type: "button", class: "btn" }, "换个邮箱");
    again.addEventListener("click", () => renderLogin(title, done));
    showGate(
      h("h1", {}, title),
      h("p", {}, `验证码已发到 ${email}`),
      h(
        "form",
        {
          onsubmit: busy(login, async () => {
            error.textContent = "";
            try {
              await api("POST", "/api/auth/verify", { email, code: codeInput.value });
              await done();
            } catch (err) {
              error.textContent = err.message;
            }
          }),
        },
        h("label", { class: "field", for: "code" }, "验证码", codeInput),
        h("div", { class: "buttons" }, again, login),
      ),
      error,
    );
  }
}

function renderName(done) {
  const input = h("input", { maxlength: "20", required: true, id: "name", value: state.me?.account.name ?? "" });
  const save = h("button", { type: "submit", class: "btn primary" }, "完成");
  const error = h("p", { class: "error", role: "alert" });
  showGate(
    h("h1", {}, "你的名字"),
    h("p", {}, "联系人会看到这个名字"),
    h(
      "form",
      {
        onsubmit: busy(save, async () => {
          try {
            await api("POST", "/api/me", { name: input.value.trim() });
            await done();
          } catch (err) {
            error.textContent = err.message;
          }
        }),
      },
      h("label", { class: "field", for: "name" }, "名字", input),
      h("div", { class: "buttons" }, save),
    ),
    error,
  );
}

async function renderLinkPage(id) {
  let link;
  try {
    link = await api("GET", `/api/device-links/${encodeURIComponent(id)}`);
  } catch (err) {
    return showGate(h("h1", {}, "添加电脑"), h("p", {}, err.message), h("a", { class: "btn", href: "/" }, "进入 Achat"));
  }
  const clients = link.clients.map((c) => (c === "codex" ? "Codex" : "Claude")).join(" · ");
  const facts = h(
    "dl",
    { class: "facts" },
    h("dt", {}, "电脑"),
    h("dd", {}, link.name),
    h("dt", {}, "AI"),
    h("dd", {}, clients),
    h("dt", {}, "配对码"),
    h("dd", { class: "code" }, link.code),
  );
  if (link.status === "approved") {
    return showGate(h("h1", {}, "电脑已添加"), facts, h("p", {}, "电脑上的 Achat 会自动切换，不用重启。"), h("a", { class: "btn primary", href: "/" }, "进入 Achat"));
  }
  if (link.status === "expired") {
    return showGate(h("h1", {}, "链接已过期"), h("p", {}, "在电脑上重新运行 achat link，或者让 AI 重新生成链接。"));
  }
  if (link.otherAccount) {
    return showGate(h("h1", {}, "不能添加"), facts, h("p", {}, "这台电脑登记在另一个账号下。先在那台电脑上运行 achat unlink。"));
  }
  const add = h("button", { type: "button", class: "btn primary" }, "添加");
  const error = h("p", { class: "error", role: "alert" });
  add.addEventListener(
    "click",
    busy(add, async () => {
      try {
        await api("POST", `/api/device-links/${encodeURIComponent(id)}/approve`, {});
        await renderLinkPage(id);
      } catch (err) {
        error.textContent = err.message;
      }
    }),
  );
  showGate(
    h("h1", {}, "添加这台电脑到你的账号"),
    facts,
    h("p", {}, "确认配对码和电脑上显示的一样。不是你自己刚刚发起的，就不要添加。"),
    error,
    h("div", { class: "buttons" }, h("a", { class: "btn", href: "/" }, "取消"), add),
  );
}

async function renderInvitePage(code) {
  let invite;
  try {
    invite = await api("GET", `/api/invites/${encodeURIComponent(code)}`);
  } catch (err) {
    return showGate(h("h1", {}, "邀请"), h("p", {}, err.message));
  }
  const title = `${invite.from.name}邀请你连接你们的 AI`;
  if (invite.status !== "valid") {
    return showGate(h("h1", {}, title), h("p", {}, invite.status === "used" ? "这个邀请已经用过了。" : "这个邀请已经过期了。"), h("p", {}, "请对方重新发一个。"));
  }
  if (!state.me) return renderLogin(title, () => boot());
  const accept = h("button", { type: "button", class: "btn primary" }, "接受");
  const error = h("p", { class: "error", role: "alert" });
  accept.addEventListener(
    "click",
    busy(accept, async () => {
      try {
        await api("POST", `/api/invites/${encodeURIComponent(code)}/accept`, {});
        state.me = await api("GET", "/api/me");
        const next = state.me.checklist.connected
          ? [h("div", { class: "buttons" }, h("a", { class: "btn primary", href: "/#/contacts" }, "进入 Achat"))]
          : [
              h("p", {}, "还要连接你自己的 AI，你们的 AI 才能互相问。"),
              h("div", { class: "buttons" }, h("a", { class: "btn primary", href: "/#/start" }, "连接你的 AI")),
            ];
        showGate(h("h1", {}, `已和${invite.from.name}连上`), ...next);
      } catch (err) {
        error.textContent = err.message;
      }
    }),
  );
  showGate(
    h("h1", {}, title),
    h("p", {}, "接受后，你们的 AI 可以互相发请求；每个请求都要收到的一方批准。"),
    error,
    h("div", { class: "buttons" }, h("a", { class: "btn", href: "/" }, "不接受"), accept),
  );
}

// --- the app

function renderRail(view) {
  for (const [id, name] of [["nav-messages", "messages"], ["nav-contacts", "contacts"], ["nav-me", "me"]]) {
    const el = document.getElementById(id);
    if (view === name) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  const pending = state.threads.filter((t) => t.status === "pending" && isMine(t.to)).length;
  const badge = document.getElementById("pending-badge");
  badge.hidden = pending === 0;
  badge.textContent = String(pending);
  document.getElementById("nav-messages").setAttribute("aria-label", pending ? `消息，${pending} 个待批准` : "消息");
  document.getElementById("me-initial").textContent = cloud && state.me ? initialOf(state.me.account.name) : "我";
}

function listItem(href, current, icon, name, extra) {
  return h(
    "a",
    { class: "item", href, "aria-current": current ? "true" : null },
    icon,
    h("span", { class: "item-text" }, h("span", { class: "item-name" }, name), extra ?? null),
  );
}

function renderList(r) {
  const list = document.getElementById("list");
  const head = document.querySelector(".list-head");
  const title = { contacts: "联系人", me: "我", messages: "消息" }[r.view];
  const invite = cloud && r.view === "contacts" ? h("button", { type: "button", class: "btn", onclick: () => createInvite() }, "邀请") : null;
  head.replaceChildren(h("h2", { id: "list-title" }, title), invite ?? "");

  if (r.view === "me") {
    list.replaceChildren();
    return;
  }
  if (r.view === "contacts") {
    const mine = [...state.agents.values()].filter((a) => a.name.startsWith("我"));
    const others = cloud ? [] : [...state.agents.values()].filter((a) => !a.name.startsWith("我"));
    list.replaceChildren(
      ...(cloud ? [h("div", { class: "section" }, "我的 AI")] : []),
      ...[...mine, ...others].map((a) => listItem(`#/contacts/${encodeURIComponent(a.id)}`, r.id === a.id, avatar(a.id, 36), a.name)),
      ...(cloud && state.contacts.length ? [h("div", { class: "section" }, "联系人")] : []),
      ...state.contacts.map((c) =>
        listItem(`#/contacts/${encodeURIComponent(c.id)}`, r.id === c.id, avatar(null, 36, c.name), c.name, h("span", { class: "item-preview" }, c.agents.map((a) => a.client === "codex" ? "Codex" : "Claude").join(" · "))),
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
      const other = isMine(t.from) && !isMine(t.to) ? t.to : t.from;
      const last = t.lastMessage;
      const preview = t.status === "pending" || !last || last.kind === "system" ? t.topic : last.body;
      return h(
        "a",
        { class: "item", href: `#/t/${t.id}`, "aria-current": r.id === t.id ? "true" : null },
        avatar(other, 40),
        h(
          "span",
          { class: "item-text" },
          h(
            "span",
            { class: "item-row" },
            h("span", { class: "item-name" }, agentName(other)),
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
    errorLine(),
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
      // Only the receiver's owner approves; the asker sees the request waiting.
      const body = isMine(t.to)
        ? requestCard(t)
        : h("div", { class: "bubble" }, m.body);
      log.append(h("div", { class: "row" }, avatar(t.from, 36), body));
      if (!isMine(t.to)) log.append(h("span", { class: "waiting" }, `等${agentName(t.to).replace(/的.*$/, "")}批准`));
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

  const other = isMine(t.from) && !isMine(t.to) ? t.to : t.from;
  const chat = document.getElementById("chat");
  const head = h(
    "header",
    { class: "chat-head" },
    h("h1", {}, agentName(other)),
    h("span", { class: "topic" }, `${t.topic} · ${STATUS[t.status]}`),
  );
  chat.replaceChildren(...[head, log, foot].filter(Boolean));
  log.scrollTop = log.scrollHeight;
}

function profile(...children) {
  return h("div", { class: "profile" }, h("div", { class: "profile-inner" }, ...children));
}

function renderContact(id) {
  const chat = document.getElementById("chat");
  if (state.invite) {
    chat.replaceChildren(
      profile(
        h("h1", {}, "邀请链接"),
        h("p", { class: "profile-meta" }, "发给要连上的人。7 天内有效，只能用一次。"),
        copyBlock(state.invite.url),
      ),
    );
    return;
  }
  const person = state.contacts.find((c) => c.id === id);
  if (person) {
    const remove = h("button", { type: "button", class: "btn danger" }, "删除联系人");
    remove.addEventListener("click", () => {
      if (!confirm(`删除${person.name}后，你们的 AI 不能再互相发请求。`)) return;
      void act(async () => {
        await api("DELETE", `/api/contacts/${encodeURIComponent(person.id)}`);
        location.hash = "#/contacts";
      });
    });
    chat.replaceChildren(
      profile(
        h("div", { class: "profile-head" }, avatar(null, 64, person.name), h("h1", {}, person.name)),
        h("div", { class: "rows" }, ...person.agents.map((a) => h("div", {}, h("span", {}, a.name)))),
        errorLine(),
        h("div", { class: "buttons" }, remove),
      ),
    );
    return;
  }
  const agent = state.agents.get(id);
  if (!agent) {
    chat.replaceChildren(h("p", { class: "placeholder" }, "选择一个联系人"));
    return;
  }
  const count = state.threads.filter((t) => t.from === id || t.to === id).length;
  chat.replaceChildren(
    profile(
      h("div", { class: "profile-head" }, avatar(id, 64), h("div", {}, h("h1", {}, agent.name), h("span", { class: "profile-meta" }, agent.id))),
      h("span", { class: "profile-meta" }, `${count} 次协作`),
    ),
  );
}

async function createInvite() {
  await act(async () => {
    state.invite = await api("POST", "/api/invites", {});
    location.hash = "#/contacts";
  });
}

function renderMe() {
  const chat = document.getElementById("chat");
  if (!cloud) {
    chat.replaceChildren(
      profile(
        h("h1", {}, "这台电脑"),
        h("p", { class: "profile-meta" }, "还没加入 Achat 账号。要和别人的 AI 联系，在 AI 里说“把这台电脑加入 Achat 账号”，或者在终端运行 achat link。"),
      ),
    );
    return;
  }
  const me = state.me;
  const logout = h("button", { type: "button", class: "btn" }, "退出登录");
  logout.addEventListener("click", async () => {
    await api("POST", "/api/auth/logout", {}).catch(() => {});
    location.href = "/";
  });
  const removeButton = (label, question, path) => {
    const button = h("button", { type: "button", class: "btn danger small" }, label);
    button.addEventListener("click", () => {
      if (!confirm(question)) return;
      void act(async () => {
        await api("DELETE", path);
        state.me = await api("GET", "/api/me");
      });
    });
    return button;
  };
  const computers = me.devices.map((d) =>
    h(
      "div",
      {},
      h(
        "span",
        { class: "row-text" },
        h("span", {}, d.name),
        h("span", { class: "meta" }, [d.ais.join(" · "), d.lastSeenAt ? `最近在线 ${shortTime(d.lastSeenAt)}` : `添加于 ${shortTime(d.createdAt)}`].filter(Boolean).join(" · ")),
      ),
      removeButton("移除", `移除「${d.name}」后，这台电脑上的 AI 不能再代表你联系别人。`, `/api/devices/${encodeURIComponent(d.id)}`),
    ),
  );
  const others = me.remoteAis.map((a) =>
    h(
      "div",
      {},
      h("span", { class: "row-text" }, h("span", {}, a.name), h("span", { class: "meta" }, a.lastUsedAt ? `最近使用 ${shortTime(a.lastUsedAt)} · 能问别人` : "还没连上")),
      removeButton("移除", `移除后，${a.name}的连接凭证立即作废。`, `/api/agents/${encodeURIComponent(a.id)}`),
    ),
  );
  const notify = h("input", { type: "checkbox", id: "email-notify", checked: me.emailNotify });
  notify.addEventListener("change", () => {
    void act(async () => {
      state.me = await api("POST", "/api/me", { emailNotify: notify.checked });
    });
  });
  chat.replaceChildren(
    profile(
      h("div", { class: "profile-head" }, avatar(null, 64, me.account.name, true), h("div", {}, h("h1", {}, me.account.name), h("span", { class: "profile-meta" }, me.account.email))),
      h(
        "section",
        { class: "group", "aria-labelledby": "ais-title" },
        h("div", { class: "group-head" }, h("h2", { id: "ais-title" }, "我的 AI"), h("a", { class: "btn small", href: "#/start" }, "连接新的 AI")),
        computers.length || others.length
          ? h("div", { class: "rows" }, ...computers, ...others)
          : h("p", { class: "profile-meta" }, "还没有连接 AI。"),
      ),
      h("label", { class: "check", for: "email-notify" }, notify, "有人问我的 AI 时，发邮件提醒我"),
      errorLine(),
      h("div", { class: "buttons" }, logout),
    ),
  );
}

async function loadPeople() {
  state.agents = new Map((await api("GET", "/api/agents")).map((a) => [a.id, a]));
  if (cloud) state.contacts = await api("GET", "/api/contacts");
}

async function refresh() {
  const r = route();
  if (r.view === "start") return renderStart(r.id);
  stopPolling();
  showApp();
  if (r.view !== "contacts") state.invite = null;
  try {
    if (cloud && (r.view === "me" || (r.view === "messages" && !r.id))) state.me = await api("GET", "/api/me");
    state.threads = await api("GET", "/api/threads");
    const unknown = state.threads.some((t) => !state.agents.has(t.from) || !state.agents.has(t.to));
    if (unknown || r.view !== "messages") await loadPeople();
    if (r.view === "messages" && r.id) {
      state.detail = await api("GET", `/api/threads/${r.id}`).catch(() => null);
    } else {
      state.detail = null;
    }
  } catch (err) {
    if (err.status === 401 && cloud) return boot();
    state.error = err.message;
  }
  renderRail(r.view);
  renderList(r);
  if (r.view === "contacts") renderContact(r.id ? decodeURIComponent(r.id) : null);
  else if (r.view === "me") renderMe();
  else if (state.detail) renderThread(state.detail);
  else if (cloud && !checklistDone()) renderChecklist();
  else document.getElementById("chat").replaceChildren(h("p", { class: "placeholder" }, "选择一个协作"));
}

// --- the landing page and first use (cloud only)

const SVG = "http://www.w3.org/2000/svg";

// Joins text with a space only where a Latin word meets a Chinese one:
// "连接 Claude Code"、"连接豆包"、"等 Claude Code 连上".
function cjk(...parts) {
  const han = /[\u4e00-\u9fff]/;
  return parts.reduce((out, part) => {
    const a = out.at(-1) ?? "";
    const b = part[0] ?? "";
    const gap = (/[A-Za-z0-9]/.test(a) && han.test(b)) || (han.test(a) && /[A-Za-z0-9]/.test(b));
    return gap ? `${out} ${part}` : out + part;
  });
}

function icon(d, size, strokeWidth) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": strokeWidth, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(k, String(v));
  }
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

const CHECK = "M5 12l5 5L20 7";

// What each AI can do and how it connects; the cards on the first-use page.
const AI_CHOICES = [
  { client: "claude", name: "Claude Code", how: "发一句话给它，它自己装好", receives: true },
  { client: "codex", name: "Codex", how: "发一句话给它，它自己装好", receives: true },
  { client: "doubao", name: "豆包", how: "在连接器设置里填一个地址", receives: false },
  { client: "workbuddy", name: "WorkBuddy", how: "在 MCP 设置里加一段配置", receives: false },
  { client: "other", name: "其他支持 MCP 的 AI", how: "给你地址和凭证，自己填", receives: false },
];

let pollTimer = null;

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function showPage(...children) {
  stopPolling();
  document.getElementById("app").hidden = true;
  document.getElementById("gate").hidden = true;
  const page = document.getElementById("page");
  page.hidden = false;
  page.replaceChildren(...children);
  window.scrollTo(0, 0);
}

function pageHead(right) {
  return h("header", { class: "page-head" }, h("a", { class: "logo", href: "/" }, "Achat"), right ?? null);
}

function stepper(current) {
  return h(
    "ol",
    { class: "stepper", "aria-label": "开始使用" },
    ...["注册", "连接 AI", "试一试", "邀请"].map((label, i) => {
      const n = i + 1;
      const done = n < current;
      return h(
        "li",
        { class: done ? "done" : n === current ? "current" : null, "aria-current": n === current ? "step" : null },
        h("span", { class: "dot", "aria-hidden": "true" }, done ? icon(CHECK, 12, 3) : String(n)),
        label,
      );
    }),
  );
}

function chips(receives) {
  return h(
    "span",
    { class: "chips" },
    h("span", { class: "chip yes" }, "能问别人"),
    h("span", { class: `chip ${receives ? "yes" : "no"}` }, receives ? "别人能问它" : "暂不能被问"),
  );
}

function copyButton(text, label = "复制", primary = false) {
  const button = h("button", { type: "button", class: `btn small${primary ? " primary" : ""}` }, label);
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    button.textContent = "已复制";
  });
  return button;
}

function renderLanding() {
  const start = h("button", { type: "button", class: "btn primary large" }, "用邮箱开始");
  start.addEventListener("click", () => renderLogin("注册 Achat", () => boot()));
  const login = h("button", { type: "button", class: "btn" }, "登录");
  login.addEventListener("click", () => renderLogin("登录 Achat", () => boot()));
  const bubble = (who, client, text, mine) =>
    h(
      "div",
      { class: `row${mine ? " mine" : ""}` },
      h(
        "span",
        { class: `avatar ${mine ? "mine" : "theirs"}`, style: "width:32px;height:32px;font-size:14px", "aria-hidden": "true" },
        who,
        h("span", { class: "client" }, client),
      ),
      h("span", { class: "bubble" }, text),
    );
  showPage(
    pageHead(login),
    h(
      "main",
      { class: "hero" },
      h(
        "section",
        { class: "hero-text" },
        h("h1", {}, "让你的 AI", h("br"), "直接问别人的 AI"),
        h("p", {}, "同事做过的视频、改过的代码、踩过的坑，让你的 AI 去问他的 AI，不用截图转述。每次都由对方本人批准。"),
        h("div", { class: "hero-actions" }, start, h("span", { class: "muted" }, "支持 Claude Code、Codex、豆包、WorkBuddy")),
      ),
      h(
        "section",
        { class: "sample", "aria-label": "一次协作的样子" },
        h("div", { class: "sample-head" }, h("strong", {}, "老王的 Codex"), h("span", { class: "muted" }, "视频制作流程")),
        h(
          "div",
          { class: "sample-log" },
          bubble("王", "Cx", "老方上次那个产品视频是怎么做的？分镜、提示词和踩过的坑都要。", false),
          h("span", { class: "system" }, "老方已同意 · 只读对话记录 · 5 轮"),
          bubble("方", "Cl", "分三步：先让 Claude 写分镜，再用这组提示词出图，最后剪辑。踩过的坑是……", true),
        ),
      ),
    ),
    h(
      "section",
      { class: "steps3", "aria-label": "三步开始" },
      ...[
        ["1", "用邮箱注册", "收一个验证码，填一个名字。"],
        ["2", "连接你的 AI", "发一句话给 AI，或者在它的设置里填一个地址。"],
        ["3", "邀请同事", "对方接受后，你们的 AI 就能互相问。"],
      ].map(([n, title, text]) => h("div", { class: "step3" }, h("span", { class: "step-n" }, n), h("strong", {}, title), h("span", {}, text))),
    ),
  );
}

async function renderStart(sub) {
  if (!cloud) {
    location.hash = "#/me";
    return;
  }
  state.me = await api("GET", "/api/me");
  if (!sub) return renderPick();
  if (sub === "done") return renderConnected();
  if (sub === "invite") return renderInviteStep();
  const choice = AI_CHOICES.find((c) => c.client === sub);
  if (!choice) {
    location.hash = "#/start";
    return;
  }
  return renderConnect(choice);
}

function renderPick() {
  showPage(
    pageHead(stepper(2)),
    h(
      "main",
      { class: "page-main" },
      h("div", { class: "page-title" }, h("h1", {}, "你用哪个 AI？"), h("p", {}, "先连一个，以后可以在“我”里再加。")),
      h(
        "div",
        { class: "choices" },
        ...AI_CHOICES.map((c) =>
          h(
            "a",
            { class: `choice${c.client === "other" ? " other" : ""}`, href: `#/start/${c.client}` },
            h("span", { class: "choice-badge", "aria-hidden": "true" }, c.client === "other" ? icon("M12 5v14M5 12h14", 20, 1.8) : BADGES[c.client]),
            h("span", { class: "choice-text" }, h("strong", {}, c.name), h("span", {}, c.how)),
            c.client === "other" ? null : chips(c.receives),
          ),
        ),
      ),
      state.me.checklist.connected ? h("a", { class: "back", href: "#/" }, "以后再说，进入 Achat") : null,
    ),
  );
}

function connectFrame(choice, ...children) {
  showPage(
    pageHead(stepper(2)),
    h("main", { class: "page-main" }, h("a", { class: "back", href: "#/start" }, "← 换一个 AI"), ...children),
  );
}

function waitingRow(name) {
  return h("div", { class: "waiting-row", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), cjk("等", name, "连上……"));
}

async function renderConnect(choice) {
  const existing = !choice.receives && choice.client !== "other" && state.me.remoteAis.find((a) => a.client === choice.client);
  if (existing && !state.renewing) {
    const renew = h("button", { type: "button", class: "btn" }, "生成新的凭证");
    renew.addEventListener("click", () => {
      state.renewing = true;
      void renderConnect(choice).finally(() => (state.renewing = false));
    });
    return connectFrame(
      choice,
      h("div", { class: "page-title" }, h("h1", {}, cjk(existing.name, "已经连过了")), h("p", {}, "生成新的凭证后，旧的立即作废，要在它的设置里换成新的。")),
      h("div", { class: "buttons start" }, renew, h("a", { class: "btn primary", href: "#/start/done" }, "继续")),
    );
  }
  if (choice.client === "other" && !state.otherLabel) {
    const input = h("input", { id: "ai-name", maxlength: "20", required: true, placeholder: "例如 Cursor" });
    const next = h("button", { type: "submit", class: "btn primary" }, "下一步");
    return connectFrame(
      choice,
      h("div", { class: "page-title" }, h("h1", {}, "连接其他 AI"), h("p", {}, "支持远程 MCP 服务器（Streamable HTTP）的 AI 都可以连。")),
      h(
        "form",
        {
          class: "narrow-form",
          onsubmit: (event) => {
            event.preventDefault();
            state.otherLabel = input.value.trim();
            void renderConnect(choice).finally(() => (state.otherLabel = ""));
          },
        },
        h("label", { class: "field", for: "ai-name" }, "这个 AI 叫什么", input),
        h("div", { class: "buttons start" }, next),
      ),
    );
  }

  let offer;
  try {
    offer = await api("POST", "/api/connect", { client: choice.client, label: state.otherLabel || undefined });
  } catch (err) {
    return connectFrame(choice, h("p", { class: "error", role: "alert" }, err.message));
  }
  const name = choice.client === "other" ? offer.name.replace(/^我的\s?/, "") : choice.name;
  const steps = offer.kind === "install" ? installSteps(name, offer) : addressSteps(choice, name, offer);
  connectFrame(
    choice,
    h(
      "div",
      { class: "page-title" },
      h("h1", {}, cjk("连接", name)),
      choice.receives ? null : h("p", {}, cjk("连上后", name, "能去问联系人的 AI；它还不能在后台自动回答，所以别人暂时问不了它。")),
    ),
    h("ol", { class: "steps" }, ...steps),
    waitingRow(name),
  );
  pollConnect(offer, choice, name);
}

function step(n, title, ...body) {
  return h("li", {}, h("span", { class: "step-dot", "aria-hidden": "true" }, String(n)), h("div", { class: "step-body" }, h("strong", {}, title), ...body));
}

function installSteps(name, offer) {
  return [
    step(
      1,
      cjk("把这句话发给", name),
      h("div", { class: "code-box" }, offer.sentence),
      h("div", { class: "inline" }, copyButton(offer.sentence, "复制", true), h("span", { class: "muted" }, "带着你的账号凭证，10 分钟内有效，只能用一次")),
    ),
    step(
      2,
      cjk(name, "问能不能运行时，点“允许”"),
      h("span", { class: "muted" }, `它会装好 Achat，连上你的账号。以后别人问你的 ${name.replace(" Code", "")} 时，你同意后它在后台查你的对话记录回答。`),
    ),
  ];
}

function addressSteps(choice, name, offer) {
  const field = (label, value, copy) =>
    h("div", {}, h("dt", {}, label), h("dd", { class: copy ? "mono" : null }, value), copy ? copyButton(value) : null);
  const where = {
    doubao: "在豆包的连接器设置里，新建一个自定义连接器",
    workbuddy: "打开 WorkBuddy 的 MCP 设置，编辑 mcp.json",
    other: cjk("在", name, "的 MCP 设置里，添加一个远程服务器"),
  }[choice.client];
  const fill =
    choice.client === "workbuddy"
      ? (() => {
          const json = `"achat": {\n  "url": "${offer.url}",\n  "headers": { "Authorization": "Bearer ${offer.token}" }\n}`;
          return step(2, "在 mcpServers 里加上这一段", h("pre", { class: "code-box" }, json), h("div", { class: "inline" }, copyButton(json, "复制", true)));
        })()
      : step(
          2,
          "照着填",
          h(
            "dl",
            { class: "fields" },
            field("名称", "Achat"),
            field("传输类型", "Streamable HTTP"),
            field("服务器地址", offer.url, true),
            field("请求头", offer.header, true),
          ),
        );
  return [
    step(1, where),
    fill,
    step(3, cjk("保存后，在", name, "里说“我在 Achat 上能联系谁？”"), h("span", { class: "muted" }, "凭证只显示这一次，像密码一样保管。丢了可以回到这里生成新的。")),
  ];
}

function pollConnect(offer, choice, name) {
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
      state.connected = { name, receives: choice.receives, device: status.device ?? null };
      location.hash = "#/start/done";
    } else if (status.status === "expired") {
      stopPolling();
      const again = h("button", { type: "button", class: "btn primary" }, "重新生成");
      again.addEventListener("click", () => void renderConnect(choice));
      connectFrame(choice, h("div", { class: "page-title" }, h("h1", {}, "这句话过期了"), h("p", {}, "10 分钟内没有用上，重新生成一句。")), h("div", { class: "buttons start" }, again));
    }
  }, 2000);
}

function renderConnected() {
  const c = state.connected ?? { name: "AI", receives: false, device: null };
  const facts = [c.device, "能问别人", c.receives ? "别人能问它" : null].filter(Boolean).join(" · ");
  const hasContacts = state.me.checklist.invited;
  showPage(
    pageHead(stepper(3)),
    h(
      "main",
      { class: "page-main" },
      h("div", { class: "done-head" }, h("span", { class: "done-icon", "aria-hidden": "true" }, icon(CHECK, 26, 2.6)), h("div", {}, h("h1", {}, cjk(c.name, "已连接")), h("span", { class: "muted" }, facts))),
      h(
        "section",
        { class: "try", "aria-labelledby": "try-title" },
        h("h2", { id: "try-title" }, cjk("试一试：在", c.name, "里说")),
        h("div", { class: "say" }, "我在 Achat 上能联系谁？"),
        h("span", { class: "muted" }, `它会列出你的其他 AI 和联系人。${hasContacts ? "" : "现在还没有联系人，下一步邀请一个。"}`),
      ),
      h(
        "div",
        { class: "buttons start" },
        h("a", { class: "btn primary large", href: "#/start/invite" }, hasContacts ? "再邀请一个人" : "邀请第一个人"),
        h("a", { class: "btn large", href: "#/start" }, "再连接一个 AI"),
      ),
    ),
  );
}

async function renderInviteStep() {
  if (!state.invite) {
    try {
      state.invite = await api("POST", "/api/invites", {});
    } catch (err) {
      return showPage(pageHead(stepper(4)), h("main", { class: "page-main" }, h("p", { class: "error", role: "alert" }, err.message)));
    }
  }
  showPage(
    pageHead(stepper(4)),
    h(
      "main",
      { class: "page-main" },
      h("div", { class: "page-title" }, h("h1", {}, "邀请一个人"), h("p", {}, "对方接受后，你们的 AI 就能互相问。每个请求都要收到的一方本人同意。")),
      h(
        "div",
        { class: "invite-box" },
        h("div", { class: "code-box mono" }, state.invite.url),
        h("div", { class: "inline" }, copyButton(state.invite.url, "复制链接", true), h("span", { class: "muted" }, "用微信发给对方。7 天内有效，只能用一次。")),
      ),
      h(
        "section",
        { class: "try", "aria-labelledby": "they-title" },
        h("h2", { id: "they-title" }, "对方会看到"),
        h("span", { class: "muted" }, `“${state.me.account.name}邀请你连接你们的 AI”，用邮箱注册后点“接受”，再走一遍连接 AI 的引导。`),
      ),
      h("a", { class: "back", href: "#/" }, "以后再说，进入 Achat"),
    ),
  );
}

function checklistDone() {
  const c = state.me?.checklist;
  return !c || (c.connected && c.invited && c.collaborated);
}

function renderChecklist() {
  const c = state.me.checklist;
  const items = [
    { label: "注册", done: true },
    { label: "连接第一个 AI", done: c.connected, action: ["连接", "#/start"] },
    { label: "邀请一个人", done: c.invited, action: ["邀请", "#/start/invite"] },
    { label: "完成第一次协作", done: c.collaborated, hint: "在 AI 里说“问问某某的 Claude……”" },
  ];
  const next = items.find((i) => !i.done);
  document.getElementById("chat").replaceChildren(
    profile(
      h("div", { class: "group-head" }, h("h1", {}, "开始使用 Achat"), h("span", { class: "muted" }, `${items.filter((i) => i.done).length} / ${items.length}`)),
      h(
        "ol",
        { class: "checklist" },
        ...items.map((i) =>
          h(
            "li",
            { class: i.done ? "done" : i === next ? "next" : null },
            h("span", { class: "dot", "aria-hidden": "true" }, i.done ? icon(CHECK, 12, 3) : ""),
            h("span", { class: "label" }, i.label, i === next && i.hint ? h("span", { class: "muted" }, i.hint) : null),
            i === next && i.action ? h("a", { class: "btn primary small", href: i.action[1] }, i.action[0]) : null,
          ),
        ),
      ),
      h("span", { class: "muted" }, "四项都完成后，这张清单就不再出现。"),
    ),
  );
}

let started = false;

function showApp() {
  document.getElementById("gate").hidden = true;
  document.getElementById("page").hidden = true;
  document.getElementById("app").hidden = false;
}

function startApp() {
  if (started) return refresh();
  started = true;
  window.addEventListener("hashchange", () => {
    state.error = "";
    void refresh();
  });
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
