// One page for both setups: on this computer (experiment 0) the relay fills in
// a token; in the cloud the token is empty and the login cookie is used.
const token = window.ACHAT_TOKEN;
const cloud = !token;
const STATUS = { pending: "待批准", active: "进行中", declined: "已拒绝", closed: "已结束", stopped: "已停止" };
const INSTALL_REPO = "https://github.com/fangsaturday6/Achat";

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
    agent ? h("span", { class: "client" }, agent.client === "codex" ? "Cx" : "Cl") : null,
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

function installSentence() {
  return (
    `帮我安装 Achat：克隆 ${INSTALL_REPO} ，切到 claude/achat-decisions 分支，运行 npm install 和 npm run build，` +
    `再运行 node dist/cli.js setup；然后运行 node dist/cli.js link ${location.origin} ，把这台电脑加入我的 Achat 账号。`
  );
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
        const next = state.me.devices.length
          ? [h("a", { class: "btn primary", href: "/#/contacts" }, "进入 Achat")]
          : [
              h("p", {}, "还要把你的电脑加入 Achat。把下面这段话发给你的 Claude 或 Codex："),
              copyBlock(installSentence()),
              h("div", { class: "buttons" }, h("a", { class: "btn", href: "/" }, "进入 Achat")),
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
  const devices = me.devices.length
    ? h(
        "div",
        { class: "rows" },
        ...me.devices.map((d) => {
          const remove = h("button", { type: "button", class: "btn danger" }, "移除");
          remove.addEventListener("click", () => {
            if (!confirm(`移除「${d.name}」后，这台电脑上的 AI 不能再代表你联系别人。`)) return;
            void act(async () => {
              await api("DELETE", `/api/devices/${encodeURIComponent(d.id)}`);
              state.me = await api("GET", "/api/me");
            });
          });
          return h(
            "div",
            {},
            h("span", {}, h("div", {}, d.name), h("div", { class: "meta" }, d.lastSeenAt ? `最近在线 ${shortTime(d.lastSeenAt)}` : `添加于 ${shortTime(d.createdAt)}`)),
            remove,
          );
        }),
      )
    : copyBlock(installSentence());
  chat.replaceChildren(
    profile(
      h("div", { class: "profile-head" }, avatar(null, 64, me.account.name, true), h("div", {}, h("h1", {}, me.account.name), h("span", { class: "profile-meta" }, me.account.email))),
      h("h2", { class: "section", style: "padding:0" }, me.devices.length ? "登录设备" : "还没有电脑加入。把这段话发给你的 Claude 或 Codex："),
      devices,
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
  if (r.view !== "contacts") state.invite = null;
  try {
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
  else document.getElementById("chat").replaceChildren(h("p", { class: "placeholder" }, "选择一个协作"));
}

let started = false;

function startApp() {
  document.getElementById("gate").hidden = true;
  document.getElementById("app").hidden = false;
  if (started) return refresh();
  started = true;
  window.addEventListener("hashchange", () => {
    state.error = "";
    void refresh();
  });
  const events = new EventSource(cloud ? "/api/events" : `/api/events?token=${encodeURIComponent(token)}`);
  let pending = null;
  events.onmessage = () => {
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
  if (!state.me) return renderLogin(page === "link" ? "登录后添加这台电脑" : "登录 Achat", () => boot());
  if (state.me.needsName) return renderName(() => boot());
  if (page === "invite" && id) return renderInvitePage(id);
  if (page === "link" && id) return renderLinkPage(id);
  return startApp();
}

void boot();
