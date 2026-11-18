# 计划 1：私聊默认 10 轮、$10，最后一轮申请加轮

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `docs/decisions.md` 8o：私聊默认改成 10 轮、$10；发起方的提问开启最后一轮时，被问一方的主人收到弹框，能“加 10 轮”（问答同时加 $10），网页底部和 MCP 工具也能加。

**Architecture:** 规则只在 `RelayService` 一处：发起方的提问让 `roundsUsed + 1 === maxRounds` 时，在提问前面加一条系统消息“最后 1 轮”，并发出新事件 `thread.lastRound`（只给不同人的 AI 之间的协作）；`addRounds` 在原来的范围上加 `MORE_SCOPE`，进行中的协作，以及刚好用完轮数或花费而结束的协作都能加。接待进程收到 `thread.lastRound` 后，用 `dialog.ts` 里新的通用两个按钮弹框 `Chooser` 问主人；网页和 MCP 工具 `add_rounds` 都走同一个接口 `POST /api/threads/:id/rounds`。

**Tech Stack:** TypeScript（Node 22，`node:test` + tsx），SQLite（`node:sqlite`），原生 JS 网页（`web/app.js`），MCP SDK。

**部署顺序：** 先部署云端（新接口、新事件、系统消息），再发布电脑上的新版本。旧电脑收到 `thread.lastRound` 只会多排一次 `answer()`，`answer()` 自己去重，不会重复回答；新电脑遇到没部署的旧云端，`addRounds` 返回 404，弹框那里只记一行日志。

**开始之前：** 工作区里可能有别的会话没提交的改动（例如 `docs/ui.md`、`web/style.css`、`web/app.js`）。每个任务提交时只 `git add` 本任务的文件；碰到别人也改过的文件，用 `git add -p` 只加自己的那几块。

---

## 文件

| 文件 | 改什么 |
|---|---|
| `src/config.ts` | 本机默认范围改成 10 轮、$10 |
| `src/cloud/server.ts` | 云端默认范围改成 10 轮、$10 |
| `src/types.ts` | `MORE_SCOPE`；事件类型加 `thread.lastRound` |
| `src/relay/service.ts` | 最后一轮的系统消息和事件；`addRounds` |
| `src/relay/threads-api.ts` | `POST /api/threads/:id/rounds` |
| `src/client.ts` | `RelayClient.addRounds` |
| `src/asking.ts` | `lastRoundTitle`、`usageLine`：弹框的标题和范围行 |
| `src/sidecar/dialog.ts` | 把 macOS 弹框抽成 `macDialog`；新增 `ChoicePrompt`、`Chooser`、`desktopChoose` |
| `src/sidecar/sidecar.ts` | 选项 `choose`；收到 `thread.lastRound` 时 `offerMore` |
| `src/daemon.ts` | `Activity.chooser`，把 `desktopChoose` 接给两种模式的接待进程 |
| `src/mcp/server.ts` | 工具 `add_rounds` |
| `web/app.js`、`web/style.css` | 底部“加 10 轮”、最后一轮的红点 |
| `test/rounds.test.ts` | 新测试文件：本计划的全部新行为 |
| 若干旧测试 | 默认范围从 5 轮、$5 改成 10 轮、$10 后的断言 |
| `README.md`、`docs/ui.md` | 文案里的默认范围 |

---

### Task 1：默认范围改成 10 轮、$10

**Files:**
- Modify: `src/config.ts:89`
- Modify: `src/cloud/server.ts:64`
- Test: `test/config.test.ts`、`test/e2e.test.ts`、`test/do.test.ts`、`test/judge.test.ts`、`test/models.test.ts`

- [ ] **Step 1：先改测试里的期望值**

`test/config.test.ts`：

```ts
test("a new config keeps only what belongs to this computer", () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.defaults, { maxRounds: 10, budgetUsd: 10 });
```

```ts
  writeFileSync(configPath(), JSON.stringify({ ...stored(), defaults: { maxRounds: 5, budgetUsd: 1 } }));
  assert.equal(loadConfig().defaults.budgetUsd, 10);
```

```ts
  writeFileSync(configPath(), JSON.stringify({ ...stored(), defaults: { budgetUsd: 2 } }));
  assert.deepEqual(loadConfig().defaults, { maxRounds: 10, budgetUsd: 2 });
```

`test/e2e.test.ts` 第 239 行和第 331 行：

```ts
    assert.match(paused.messages.at(-1)!.body, /花费到了上限 \$10\.00/);
```

```ts
    assert.deepEqual(asked[0], { mode: "answer", title: "我的 Codex 想问你的 Claude", topic: "对话框同意", body: "怎么做的？", scope: "问答 · 10 轮 · $10.00" });
```

`test/do.test.ts` 第 61、66、71、153 行：

```ts
    assert.equal(approved.messages.at(-1)!.body, "已同意：动手 · 10 轮");
```

```ts
    assert.equal(asAnswer.messages.at(-1)!.body, "已同意：问答 · 10 轮 · $10.00");
```

```ts
    assert.equal(asDo.messages.at(-1)!.body, "已同意：动手 · 10 轮");
```

```ts
    assert.equal(prompt.scope, "动手 · 10 轮");
```

`test/judge.test.ts` 第 56、87 行：

```ts
    assert.equal(asAnswer.messages.at(-1)!.body, "已同意：问答 · 10 轮 · $10.00");
```

```ts
    assert.equal(judged.messages.at(-1)!.body, "改成动手 · 10 轮");
```

`test/models.test.ts` 第 168 行（“已同意：Opus · 高 · 问答 · 5 轮 · $5.00”那一句）：

```ts
    assert.equal(approved.messages.at(-1)!.body, "已同意：Opus · 高 · 问答 · 10 轮 · $10.00");
```

- [ ] **Step 2：跑测试，确认这些断言失败**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail` 不为 0，失败的是上面改过的断言（实际值还是 5 轮、$5.00）。

- [ ] **Step 3：改默认值**

`src/config.ts` 的 `defaultConfig()`：

```ts
    defaults: { maxRounds: 10, budgetUsd: 10 },
```

`src/cloud/server.ts` 的 `CLOUD_DEFAULTS`：

```ts
  defaults: { maxRounds: 10, budgetUsd: 10 },
```

- [ ] **Step 4：跑全部测试**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`。如果还有别的测试写死了“5 轮”或“$5.00”，照同样的办法把期望值改成 10 轮、$10.00（用 `grep -rn "5 轮\|\$5\.00" test/` 找）。

- [ ] **Step 5：提交**

```bash
git add src/config.ts src/cloud/server.ts test/config.test.ts test/e2e.test.ts test/do.test.ts test/judge.test.ts test/models.test.ts
git commit -m "feat: a conversation is allowed 10 rounds and \$10 by default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2：最后一轮的系统消息、事件和加轮接口

**Files:**
- Modify: `src/types.ts`（`RelayEventType`、新常量 `MORE_SCOPE`）
- Modify: `src/relay/service.ts`（`postMessage`、新方法 `addRounds`）
- Modify: `src/relay/threads-api.ts`（`case "rounds"`）
- Modify: `src/client.ts`（`addRounds`）
- Create: `test/rounds.test.ts`

- [ ] **Step 1：写会失败的测试**

新建 `test/rounds.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RelayEvent } from "../src/types.js";
import { CLAUDE, CODEX, startTestRelay } from "./helpers.js";

test("the asker's question that opens the last round says so, and the asked side's person adds ten more", async () => {
  const { relay, client } = await startTestRelay();
  const events: RelayEvent[] = [];
  const off = relay.service.onEvent((e) => events.push(e));
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    await client.postMessage(t.id, { from: CLAUDE, body: "先写分镜", costUsd: 0.1 });
    assert.equal(events.filter((e) => e.type === "thread.lastRound").length, 0, "rounds left");

    const last = await client.postMessage(t.id, { from: CODEX, body: "封面图怎么出的？" });
    assert.deepEqual(
      last.messages.slice(-2).map((m) => [m.kind, m.body]),
      [
        ["system", "最后 1 轮"],
        ["message", "封面图怎么出的？"],
      ],
    );
    const opened = events.filter((e) => e.type === "thread.lastRound");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].seq, last.messages.at(-1)!.seq);

    const more = await client.addRounds(t.id);
    assert.deepEqual(more.scope, { maxRounds: 12, budgetUsd: 11 });
    assert.equal(more.messages.at(-1)!.body, "加了 10 轮 · $10.00");

    const answered = await client.postMessage(t.id, { from: CLAUDE, body: "用 Midjourney 出的", costUsd: 0.1 });
    assert.equal(answered.status, "active", "more rounds, so it goes on");
    assert.equal(answered.roundsUsed, 2);
  } finally {
    off();
    await relay.close();
  }
});

test("rounds that just ran out can still be added; a thread waiting or stopped cannot; 动手 gets no money", async () => {
  const { relay, client } = await startTestRelay();
  try {
    const pending = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "还没批", message: "问题" });
    await assert.rejects(client.addRounds(pending.id), /进行中/);

    const ran = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "一轮就完", message: "问题" });
    await client.approve(ran.id, { maxRounds: 1, budgetUsd: 1 });
    const closed = await client.postMessage(ran.id, { from: CLAUDE, body: "答完了", costUsd: 0.1 });
    assert.equal(closed.status, "closed");
    const reopened = await client.addRounds(ran.id);
    assert.equal(reopened.status, "active");
    assert.equal(reopened.scope.maxRounds, 11);
    await client.postMessage(ran.id, { from: CODEX, body: "接着问" });
    assert.equal((await client.getThread(ran.id)).status, "active", "a question, not a request to go on");

    const stopped = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "停了", message: "问题" });
    await client.approve(stopped.id);
    await client.stop(stopped.id);
    await assert.rejects(client.addRounds(stopped.id), /进行中/);

    const doing = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "写脚本", message: "写一个", mode: "do" });
    await client.approve(doing.id);
    const more = await client.addRounds(doing.id);
    assert.deepEqual(more.scope, { maxRounds: 20, budgetUsd: 10 });
    assert.equal(more.messages.at(-1)!.body, "加了 10 轮");
  } finally {
    await relay.close();
  }
});
```

（`relay.service` 是 `startRelay` 返回的 `RunningRelay` 上的服务。如果 `RunningRelay` 没有暴露 `service`，就在 `src/relay/server.ts` 的 `RunningRelay` 接口和返回值里加上 `service: RelayService`，这是给测试用的唯一改动。`client.stop` 如果需要参数，照 `src/client.ts` 里 `stop` 的签名填。）

- [ ] **Step 2：跑测试，确认失败**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: FAIL，`client.addRounds is not a function`，或者最后两条消息里没有“最后 1 轮”。

- [ ] **Step 3：`src/types.ts`**

把 `RelayEventType` 改成：

```ts
// "thread.reminded": a request has waited for approval for hours.
// "thread.lastRound": the asker's question at `seq` opened the last round of a
// thread between two people's AIs; the asked side's person may give more.
export type RelayEventType = "thread.created" | "thread.updated" | "message.created" | "thread.reminded" | "thread.lastRound";
```

在 `Scope` 接口后面加：

```ts
// What “加 10 轮” gives a thread under way, on top of what it had; 问答 gets
// the money for them too. web/app.js writes the same number on its button.
export const MORE_SCOPE: Scope = { maxRounds: 10, budgetUsd: 10 };
```

- [ ] **Step 4：`src/relay/service.ts` 的 `postMessage`**

文件顶部从 `../types.js` 的导入里加上 `MORE_SCOPE`。

在 `postMessage` 里，`const now = this.stamp();` 的下一行加：

```ts
    // The asker's question that opens the last round: said in the thread, and
    // between two people's AIs, the asked side's person may give more.
    const opensLast = !fromResponder && !toPerson && !asks && thread.status === "active" && thread.roundsUsed + 1 === thread.scope.maxRounds;
```

把事务里第一句 `const msg = this.store.addMessage(` 前面加上：

```ts
      if (opensLast) this.store.addMessage(id, { sender: null, kind: "system", body: "最后 1 轮" }, now);
```

把事务后面的

```ts
    this.emit("message.created", result.thread, result.msg);
    if (closingNote) this.emit("thread.updated", result.thread);
```

改成

```ts
    this.emit("message.created", result.thread, result.msg);
    if (closingNote) this.emit("thread.updated", result.thread);
    if (opensLast && !thread.own) this.emit("thread.lastRound", result.thread, result.msg);
```

- [ ] **Step 5：`src/relay/service.ts` 的 `addRounds`**

在 `askMore` 方法后面加：

```ts
  // The asked side's person gives a thread more rounds: under way, before
  // they run out, or right after it ended because they or the money did.
  // Added on top of what it had, money too for 问答, and it goes on without
  // being approved again.
  addRounds(id: string): ThreadDetail {
    const thread = this.requireThread(id);
    const ranOut = thread.status === "closed" && this.spent(thread);
    if (thread.status !== "active" && !ranOut) throw new RelayError(409, "只有进行中、或者刚用完轮数的协作可以加轮数");
    const scope: Scope = {
      maxRounds: thread.scope.maxRounds + MORE_SCOPE.maxRounds,
      budgetUsd: thread.mode === "do" ? thread.scope.budgetUsd : Math.round((thread.scope.budgetUsd + MORE_SCOPE.budgetUsd) * 100) / 100,
    };
    const note = thread.mode === "do" ? `加了 ${MORE_SCOPE.maxRounds} 轮` : `加了 ${MORE_SCOPE.maxRounds} 轮 · $${MORE_SCOPE.budgetUsd.toFixed(2)}`;
    const now = this.stamp();
    const updated = this.store.transaction(() => {
      const t = this.store.updateThread(id, { status: "active", scope }, now);
      this.store.addMessage(id, { sender: null, kind: "system", body: note }, now);
      return t;
    });
    this.emit("thread.updated", updated);
    return this.getThread(id);
  }
```

- [ ] **Step 6：`src/relay/threads-api.ts`**

在 `switch (action)` 里 `case "more":` 那一段后面加：

```ts
    case "rounds":
      if (!viewer.approves || !viewer.sees(thread.to)) forbid("只有接收方的主人可以加轮数");
      send(res, 200, service.addRounds(id));
      return true;
```

- [ ] **Step 7：`src/client.ts`**

在 `approve(...)` 方法后面加：

```ts
  // Ten more rounds for a thread an AI here is asked in, money too for 问答.
  addRounds(id: string): Promise<ThreadDetail> {
    return this.call("POST", `/api/threads/${encodeURIComponent(id)}/rounds`, {});
  }
```

- [ ] **Step 8：跑测试**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: PASS（2 个测试）。

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`。

- [ ] **Step 9：提交**

```bash
git add src/types.ts src/relay/service.ts src/relay/threads-api.ts src/client.ts test/rounds.test.ts
git commit -m "feat: the last round says so, and the asked side's person can add ten more

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（如果 Step 1 里为了 `relay.service` 改了 `src/relay/server.ts`，一起 `git add`。）

---

### Task 3：弹框的标题和范围行，通用的两个按钮弹框

**Files:**
- Modify: `src/asking.ts`
- Modify: `src/sidecar/dialog.ts`
- Test: `test/rounds.test.ts`

- [ ] **Step 1：写会失败的测试**

在 `test/rounds.test.ts` 顶部的导入里加：

```ts
import { lastRoundTitle, usageLine } from "../src/asking.js";
```

文件末尾加：

```ts
test("the last-round dialog names both AIs and what was used", () => {
  assert.equal(lastRoundTitle("老王的 Codex", "你的 Claude"), "老王的 Codex 和你的 Claude 到最后 1 轮了");
  const t = { mode: "answer" as const, roundsUsed: 9, costUsd: 3.2, scope: { maxRounds: 10, budgetUsd: 10 } };
  assert.equal(usageLine(t), "问答 · 9 / 10 轮 · $3.20 / $10.00");
  assert.equal(usageLine({ ...t, mode: "do" }), "动手 · 9 / 10 轮");
});
```

- [ ] **Step 2：跑测试，确认失败**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: FAIL，`lastRoundTitle` 没有导出。

- [ ] **Step 3：`src/asking.ts`**

在 `scopeLine` 后面加：

```ts
// What a thread has used of what it was allowed, the same words as under
// the conversation on the web page: "问答 · 9 / 10 轮 · $3.20 / $10.00".
export function usageLine(t: Pick<Thread, "mode" | "roundsUsed" | "costUsd" | "scope">): string {
  const rounds = `${MODE_LABELS[t.mode]} · ${t.roundsUsed} / ${t.scope.maxRounds} 轮`;
  return t.mode === "do" ? rounds : `${rounds} · $${t.costUsd.toFixed(2)} / $${t.scope.budgetUsd.toFixed(2)}`;
}

// 老王的 Codex 和你的 Claude 到最后 1 轮了.
export function lastRoundTitle(from: string, to: string): string {
  return cjk(from, "和", to, "到最后 1 轮了");
}
```

- [ ] **Step 4：`src/sidecar/dialog.ts`：把 macOS 弹框抽出来，加两个按钮的弹框**

现在 `macAlert` 和 `desktopAlert` 各拼了一份 `display dialog` 脚本。把 `macAlert` 整个函数换成下面两个函数（`macDialog` 是三种弹框共用的一份；`dialogIcon` 是文件里已有的取图标函数）：

```ts
// A dialog with these buttons, left to right; the first is both the default
// and the way out, so pressing Return never does anything for the person.
// Resolves to the button pressed, or null when it went away.
function macDialog(title: string, text: string, icon: string | null, buttons: string[]): { answer: Promise<string | null>; close(): void } {
  const first = JSON.stringify(buttons[0]);
  const options = `buttons {${buttons.map((b) => JSON.stringify(b)).join(", ")}} default button ${first} cancel button ${first} giving up after ${WAIT_SECONDS}`;
  const show = icon
    ? `display dialog ((item 1 of argv) & return & return & (item 2 of argv)) with title "Achat" ${options} with icon (POSIX file (item 3 of argv))`
    : `display alert (item 1 of argv) message (item 2 of argv) ${options}`;
  const script = ["on run argv", "activate", show, "return button returned of result", "end run"];
  let child!: ChildProcess;
  const answer = new Promise<string | null>((resolve) => {
    child = execFile("osascript", [...script.flatMap((line) => ["-e", line]), title, text, ...(icon ? [icon] : [])], (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
  return { answer, close: () => child.kill() };
}

// "稍后" is the default button, so pressing Return while typing elsewhere
// never approves anything. A dialog takes an icon of its own; an alert, used
// when the icon is missing, shows the title larger.
function macAlert(p: ApprovalPrompt): Asking {
  const shown = macDialog(p.title, message(p), dialogIcon(p.mode), ["稍后", "拒绝", "同意"]);
  return { answer: shown.answer.then((b) => (b === "同意" ? "approve" : b === "拒绝" ? "decline" : "later")), close: shown.close };
}
```

`desktopAlert` 里 `if (os === "darwin") { ... }` 那一段（从 `const buttons = ...` 到 `execFile("osascript", ...)`）换成一行：

```ts
    macDialog(title, message, dialogIcon("app"), ["好"]);
```

在文件末尾（`desktopAsk` 后面）加：

```ts
// Two ways to go for something the person decides here, such as giving a
// conversation more rounds when its last one opens: `more` goes on, `stop`
// lets it run out and is the default, so Return never spends anything.
export interface ChoicePrompt {
  icon: ThreadMode;
  title: string; // 老王的 Codex 和你的 Claude 到最后 1 轮了
  body: string;
  more: string; // 加 10 轮
  stop: string; // 用完就停
}

export type Choice = "more" | "stop";

export interface Choosing {
  answer: Promise<Choice>;
  close(): void;
}

// Shows the choice, or returns null where this computer cannot.
export type Chooser = (prompt: ChoicePrompt) => Choosing | null;

function zenityChoose(p: ChoicePrompt): Choosing {
  let child!: ChildProcess;
  const answer = new Promise<Choice>((resolve) => {
    child = execFile(
      "zenity",
      ["--question", "--no-markup", "--default-cancel", "--title", p.title, "--text", `${p.title}\n\n${p.body}`, "--ok-label", p.more, "--cancel-label", p.stop, "--timeout", String(WAIT_SECONDS)],
      (err) => resolve(err ? "stop" : "more"),
    );
  });
  return { answer, close: () => child.kill() };
}

export const desktopChoose: Chooser = (p) => {
  const os = platform();
  if (os === "darwin") {
    const shown = macDialog(p.title, p.body, dialogIcon(p.icon), [p.stop, p.more]);
    return { answer: shown.answer.then((b) => (b === p.more ? "more" : "stop")), close: shown.close };
  }
  if (os === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("zenity")) return zenityChoose(p);
  return null;
};
```

- [ ] **Step 5：跑测试，并在 macOS 上手动看一眼弹框**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: PASS（3 个测试）。

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`（批准弹框的测试用的是假的 `ask`，`macAlert` 的改动靠下面手动看）。

在 macOS 上手动看批准弹框和新弹框各一次（按“稍后”“用完就停”关掉，不会改任何数据）：

Run: `node --no-warnings=ExperimentalWarning --import tsx -e 'import("./src/sidecar/dialog.ts").then(async (d) => { const a = d.desktopAsk({ mode: "answer", title: "老王的 Codex 想问你的 Claude", topic: "视频制作流程", body: "怎么做的？", scope: "问答 · 10 轮 · $10.00" }); console.log(await a.answer); const c = d.desktopChoose({ icon: "answer", title: "老王的 Codex 和你的 Claude 到最后 1 轮了", body: "视频制作流程\n\n问答 · 9 / 10 轮 · $3.20 / $10.00", more: "加 10 轮", stop: "用完就停" }); console.log(await c.answer); })'`
Expected: 先出现三个按钮的批准框（Achat 图标，角上是问答的蓝色问号），默认按钮是“稍后”，点“稍后”打印 `later`；再出现两个按钮的框，默认按钮是“用完就停”，点“加 10 轮”打印 `more`。再跑一次 `desktopAlert("你的 Claude 需要重新登录", "登录后会自动接着回答")`，确认“好”这个提醒框和原来一样。

- [ ] **Step 6：提交**

```bash
git add src/asking.ts src/sidecar/dialog.ts test/rounds.test.ts
git commit -m "feat: a two-button dialog on the computer, and the words for the last round

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4：接待进程在最后一轮弹框

**Files:**
- Modify: `src/sidecar/sidecar.ts`
- Modify: `src/daemon.ts`
- Test: `test/rounds.test.ts`

- [ ] **Step 1：写会失败的测试**

在 `test/rounds.test.ts` 顶部的导入里加：

```ts
import type { Choice, ChoicePrompt } from "../src/sidecar/dialog.js";
import type { RunInput, RunOutput } from "../src/sidecar/runners.js";
import { Sidecar } from "../src/sidecar/sidecar.js";
import { ScriptedRunner, until } from "./helpers.js";
```

（`CLAUDE, CODEX, startTestRelay` 已经从 `./helpers.js` 导入，把 `ScriptedRunner, until` 并进同一行。）

文件末尾加：

```ts
// Holds the second answer until the test lets it go, so the dialog is shown
// while the last round is still being answered.
class HeldRunner extends ScriptedRunner {
  private release!: () => void;
  private held = new Promise<void>((r) => (this.release = r));
  letGo(): void {
    this.release();
  }
  async run(input: RunInput): Promise<RunOutput> {
    if (this.calls.length === 1) await this.held;
    return super.run(input);
  }
}

test("the computer asks once, when the last round opens, and 加 10 轮 lets the thread go on", async () => {
  const { relay, client, config } = await startTestRelay();
  const asked: ChoicePrompt[] = [];
  const answers: ((c: Choice) => void)[] = [];
  const runner = new HeldRunner(["先写分镜", "用 Midjourney 出的"]);
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: runner },
    choose: (prompt) => {
      asked.push(prompt);
      let resolve!: (c: Choice) => void;
      const answer = new Promise<Choice>((r) => (resolve = r));
      answers.push(resolve);
      return { answer, close: () => resolve("stop") };
    },
    notify: () => {},
    webUrl: relay.url,
    log: () => {},
  });
  sidecar.start();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);
    assert.equal(asked.length, 0, "rounds left, nothing to ask");

    await client.postMessage(t.id, { from: CODEX, body: "封面图怎么出的？" });
    await until(async () => asked.length === 1);
    assert.deepEqual(asked[0], {
      icon: "answer",
      title: "我的 Codex 和你的 Claude 到最后 1 轮了",
      body: "视频制作流程\n\n问答 · 1 / 2 轮 · $0.05 / $1.00",
      more: "加 10 轮",
      stop: "用完就停",
    });
    answers[0]("more");
    await until(async () => (await client.getThread(t.id)).scope.maxRounds === 12);

    runner.letGo();
    const done = await until(async () => {
      const d = await client.getThread(t.id);
      return d.roundsUsed === 2 ? d : null;
    });
    assert.equal(done.status, "active");
    assert.equal(asked.length, 1, "asked once");
  } finally {
    sidecar.stop();
    await relay.close();
  }
});

test("where no dialog can be shown, a notification points to the conversation", async () => {
  const { relay, client, config } = await startTestRelay();
  const told: string[][] = [];
  const sidecar = new Sidecar({
    client,
    agents: config.agents,
    runners: { [CLAUDE]: new ScriptedRunner(["先写分镜", "用 Midjourney 出的"]) },
    choose: () => null,
    notify: (title, body, url) => told.push([title, body, url]),
    webUrl: relay.url,
    log: () => {},
  });
  sidecar.start();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    await until(async () => (await client.getThread(t.id)).roundsUsed === 1);
    await client.postMessage(t.id, { from: CODEX, body: "封面图怎么出的？" });
    await until(async () => told.some(([title]) => title.includes("最后 1 轮")));
    assert.deepEqual(
      told.find(([title]) => title.includes("最后 1 轮")),
      ["我的 Codex 和你的 Claude 到最后 1 轮了", "视频制作流程", `${relay.url}/#/t/${t.id}`],
    );
  } finally {
    sidecar.stop();
    await relay.close();
  }
});
```

- [ ] **Step 2：跑测试，确认失败**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: FAIL，TypeScript 报 `choose` 不是 `SidecarOptions` 的字段，或者 `asked.length` 一直是 0。

- [ ] **Step 3：`src/sidecar/sidecar.ts`**

导入改成：

```ts
import { lastRoundTitle, ownerOf, pendingMessage, requestReason, requestTitle, scopeLine, speaker, usageLine, withFileNames } from "../asking.js";
```

```ts
import { MODE_LABELS, MORE_SCOPE, waitingForAsker, type Message, type RelayEvent, type ThreadDetail, type ThreadMode } from "../types.js";
import type { Alerter, Asker, Asking, Chooser } from "./dialog.js";
```

`SidecarOptions` 里 `ask?: Asker;` 后面加：

```ts
  // Asks the person here to choose, such as whether to give a conversation
  // more rounds when its last one opens; where it cannot, or without one, a
  // notification points to the conversation, which has the same button.
  choose?: Chooser;
```

`private shown = new Map<string, number>();` 后面加：

```ts
  // Last rounds already put to the person, by thread and question.
  private offered = new Set<string>();
```

`onEvent` 里 `if (!this.mine(e.to)) return;` 的下一行加：

```ts
    if (e.type === "thread.lastRound") {
      void this.offerMore(e.threadId, e.seq ?? 0);
      return;
    }
```

在 `prompt(threadId)` 方法前面加：

```ts
  // The asker's question opened the last round of a thread with another
  // person's AI: the person here is asked, once for that question, whether
  // to give ten more before it runs out. The AI goes on answering meanwhile;
  // added right after the rounds ran out, the thread opens again.
  private async offerMore(threadId: string, seq: number): Promise<void> {
    const key = `${threadId}:${seq}`;
    if (this.offered.has(key)) return;
    this.offered.add(key);
    try {
      const t = await this.relay.getThread(threadId);
      const from = (await this.agent(t.from))?.name ?? t.from;
      const to = ((await this.agent(t.to))?.name ?? t.to).replace(/^我的/, "你的");
      const title = lastRoundTitle(from, to);
      const choosing = this.opts.choose?.({
        icon: t.mode,
        title,
        body: `${t.topic}\n\n${usageLine(t)}`,
        more: `加 ${MORE_SCOPE.maxRounds} 轮`,
        stop: "用完就停",
      });
      if (!choosing) {
        this.opts.notify(title, t.topic, `${this.opts.webUrl}/#/t/${threadId}`);
        return;
      }
      if ((await choosing.answer) === "more") await this.relay.addRounds(threadId);
    } catch (err) {
      if (!this.stopping.signal.aborted) this.log(`${threadId} 的加轮弹框：${(err as Error).message}`);
    }
  }
```

（`this.relay` 是 `RelayClient.patient(...)` 包出来的客户端；`addRounds` 在 Task 2 加到了 `RelayClient` 上。如果 `patient()` 返回的类型只挑了一部分方法，照它现有的写法把 `addRounds` 也加进去。）

- [ ] **Step 4：`src/daemon.ts`**

导入改成：

```ts
import { desktopAlert, desktopAsk, desktopChoose, type Asker, type Chooser } from "./sidecar/dialog.js";
```

`Activity` 类里 `asker(...)` 方法后面加：

```ts
  chooser(choose: Chooser): Chooser {
    return (prompt) => {
      const choosing = choose(prompt);
      if (!choosing) return null;
      this.begin();
      const end = (): void => this.end();
      choosing.answer.then(end, end);
      return choosing;
    };
  }
```

`const ask = activity.asker(desktopAsk);` 下一行加：

```ts
const choose = activity.chooser(desktopChoose);
```

`startLocal` 里的 `new Sidecar({...})` 在 `ask,` 后面加一行 `choose,`；`startCloudMode` 里那一行改成：

```ts
  const sidecar = new Sidecar({ client: conn.client, agents: [], runners, doers, offers, ask, choose, alert: desktopAlert, notify: desktopNotify, webUrl: conn.webUrl });
```

- [ ] **Step 5：跑测试**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: PASS（5 个测试）。

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`。

Run: `npm run build`
Expected: 没有类型错误。

- [ ] **Step 6：提交**

```bash
git add src/sidecar/sidecar.ts src/daemon.ts test/rounds.test.ts
git commit -m "feat: the computer asks whether to add ten rounds when the last one opens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5：MCP 工具 `add_rounds`

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `test/rounds.test.ts`

- [ ] **Step 1：写会失败的测试**

在 `test/rounds.test.ts` 顶部的导入里加：

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RelayClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp/server.js";
```

文件末尾加：

```ts
async function mcp(client: RelayClient, agentId: string, url: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ connection: () => ({ client, agentId, webUrl: url, mode: "local" }), waitSeconds: 5 }).connect(serverSide);
  const c = new Client({ name: "test", version: "1" });
  await c.connect(clientSide);
  return c;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

test("the asked AI adds ten rounds with add_rounds when its person says so", async () => {
  const { relay, client } = await startTestRelay();
  try {
    const t = await client.createRequest({ from: CODEX, to: CLAUDE, topic: "视频制作流程", message: "第一步怎么做？" });
    await client.approve(t.id, { maxRounds: 2, budgetUsd: 1 });
    const claude = await mcp(client, CLAUDE, relay.url);
    const added = await claude.callTool({ name: "add_rounds", arguments: { thread_id: t.id } });
    assert.equal(textOf(added), `协作 ${t.id} 加了 10 轮 · $10.00，现在最多 12 轮 · $11.00。`);

    const codex = await mcp(client, CODEX, relay.url);
    const refused = await codex.callTool({ name: "add_rounds", arguments: { thread_id: t.id } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /不是别人问你的协作/);
  } finally {
    await relay.close();
  }
});
```

- [ ] **Step 2：跑测试，确认失败**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: FAIL，`add_rounds` 工具不存在。

- [ ] **Step 3：`src/mcp/server.ts`**

导入改成：

```ts
import { isTerminal, MODE_LABELS, MORE_SCOPE, personWaiting, STATUS_LABELS, type Message, type ThreadDetail } from "../types.js";
```

在 `set_model` 那个 `server.registerTool(...)` 调用结束之后、同一个 `if (opts.review !== false) {` 块的 `}` 之前加：

```ts
    server.registerTool(
      "add_rounds",
      {
        title: "给协作加轮数",
        description:
          `别人的 AI 问主人的 AI 的那次协作，轮数快用完或刚用完时，再加 ${MORE_SCOPE.maxRounds} 轮（问答同时加 $${MORE_SCOPE.budgetUsd.toFixed(2)}），` +
          "协作接着进行，不用对方再申请。花的是主人的额度，只在主人说了时用。",
        inputSchema: { thread_id: z.string().describe("协作 id") },
      },
      guard(async ({ thread_id }: { thread_id: string }) => {
        const c = opts.connection();
        const thread = await c.client.getThread(thread_id);
        if (thread.to !== c.agentId) throw new Error(`协作 ${thread_id} 不是别人问你的协作，加不了轮数`);
        const t = await c.client.addRounds(thread_id);
        const added = t.mode === "do" ? `${MORE_SCOPE.maxRounds} 轮` : `${MORE_SCOPE.maxRounds} 轮 · $${MORE_SCOPE.budgetUsd.toFixed(2)}`;
        const now = t.mode === "do" ? `${t.scope.maxRounds} 轮` : `${t.scope.maxRounds} 轮 · $${t.scope.budgetUsd.toFixed(2)}`;
        return text(`协作 ${thread_id} 加了 ${added}，现在最多 ${now}。`);
      }),
    );
```

（`guard` 把抛出的错误变成 `isError: true` 的工具结果，和 `set_model` 一样。）

- [ ] **Step 4：跑测试**

Run: `node --no-warnings=ExperimentalWarning --import tsx --test test/rounds.test.ts`
Expected: PASS（6 个测试）。

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`。如果有测试列出了全部工具名（`grep -rn "set_model" test/` 找 `listTools` 的断言），把 `add_rounds` 加进期望的列表。

- [ ] **Step 5：提交**

```bash
git add src/mcp/server.ts test/rounds.test.ts
git commit -m "feat: add_rounds, for the asked AI when its person says to go on

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6：网页底部“加 10 轮”和最后一轮的红点

**Files:**
- Modify: `web/app.js`（`needsYou`、对话底部）
- Modify: `web/style.css`

网页没有单元测试，这个任务用浏览器手动验证。

- [ ] **Step 1：`web/app.js` 的两个判断**

把 `needsYou` 改成，并在它后面加 `canAddRounds`：

```js
// A conversation that has something new for the person, or waits on their
// approval, or another person's AI asks one of theirs its last round.
function needsYou(t) {
  return t.unread || (t.status === "pending" && isMine(t.to)) || (t.status === "active" && othersAsk(t) && t.scope.maxRounds - t.roundsUsed <= 1);
}

// Another person's AI asking one of the person's own.
function othersAsk(t) {
  return isMine(t.to) && !isMine(t.from) && !t.own;
}

// The person can give ten more rounds (MORE_SCOPE in src/types.ts) to a
// conversation in its last round, or right after its rounds ran out.
function canAddRounds(t) {
  const left = t.scope.maxRounds - t.roundsUsed;
  return othersAsk(t) && ((t.status === "active" && left <= 1) || (t.status === "closed" && left <= 0));
}
```

- [ ] **Step 2：`web/app.js` 的对话底部**

在对话页里 `const stop = t.status === "active" ? [...] : [];` 下一行加：

```js
    const more = canAddRounds(t)
      ? h("button", { type: "button", class: "text-btn", id: "add-rounds", onclick: () => act(() => api("POST", `/api/threads/${t.id}/rounds`, {})) }, "加 10 轮")
      : null;
```

把下一行的 `status` 改成（末尾多了 `more`）：

```js
    const status = h("span", { class: "muted usage" }, t.status === "active" ? usage : `${usage} · ${STATUS[t.status]}`, ran ? [" · ", ran] : null, more);
```

`writes` 为假、只显示一行灰字的那个分支（`foot = h("footer", { class: "main-foot" }, ...)`）不用改：被问一方的主人总能写，按钮总在 `writes` 分支里。

- [ ] **Step 3：`web/style.css`**

在 `.text-btn.danger { ... }` 后面加：

```css
.usage .text-btn { height: auto; margin-left: 8px; font-size: inherit; }
```

- [ ] **Step 4：在浏览器里验证**

开一个临时的本机 Achat，不碰平时用的 `~/.achat`，也不占平时那个 Achat 的 7330 端口。先让命令行生成临时目录里的 `config.json`，再把端口改成 7391：

```bash
npm run build
export ACHAT_HOME=$(mktemp -d)
node --no-warnings=ExperimentalWarning dist/cli.js status >/dev/null 2>&1 || true
node -e 'const fs=require("fs");const f=process.env.ACHAT_HOME+"/config.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));c.port=7391;fs.writeFileSync(f,JSON.stringify(c,null,2))'
node --no-warnings=ExperimentalWarning dist/cli.js start
```

Expected: 打印 `Achat 已启动：http://127.0.0.1:7391`。后台回答会真的调用这台电脑上的 `claude -p`，花一两毛钱。

另开一个终端（同样 `export ACHAT_HOME=` 刚才那个目录），发一个只有 2 轮的问答，答完第一轮再问一句：

```bash
BASE=http://127.0.0.1:7391; TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.ACHAT_HOME+"/config.json","utf8")).token)')
ID=$(curl -s -H "x-achat-token: $TOKEN" -H "content-type: application/json" -X POST $BASE/api/threads -d '{"from":"codex@local","to":"claude@local","topic":"视频制作流程","message":"第一步怎么做？"}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')
curl -s -H "x-achat-token: $TOKEN" -H "content-type: application/json" -X POST $BASE/api/threads/$ID/approve -d '{"maxRounds":2,"budgetUsd":1}' >/dev/null
```

等后台的 Claude 回完第一轮（网页上看得到回答），再发第二句：

```bash
curl -s -H "x-achat-token: $TOKEN" -H "content-type: application/json" -X POST $BASE/api/threads/$ID/messages -d '{"from":"codex@local","body":"封面图怎么出的？"}' >/dev/null
```

Expected:
- 电脑上弹出“我的 Codex 和你的 Claude 到最后 1 轮了”，按钮“用完就停”“加 10 轮”；先点“用完就停”。
- 网页上这段对话里多一行灰字“最后 1 轮”；列表里这段对话前面有红点，导航栏“消息”的数字加 1。
- 对话底部写“1 / 2 轮 · $… / $1.00”，后面是蓝色的“加 10 轮”；点它以后多一行“加了 10 轮 · $10.00”，底部变成“… / 12 轮 · $… / $11.00”，按钮消失。
- 浅色、深色（系统切到深色）、窄屏（浏览器窗口拉到 < 720px）各看一眼底部这一行：不换行错位、按钮看得清。

看完按 Ctrl+C 停掉临时的 Achat。

- [ ] **Step 5：提交**

```bash
git add -p web/app.js web/style.css
git commit -m "feat: 加 10 轮 under a conversation in its last round, and a red dot for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（`git add -p` 只选本任务的几块：这两个文件可能有别的会话没提交的改动。）

---

### Task 7：文档里的默认范围

**Files:**
- Modify: `README.md:30`
- Modify: `docs/ui.md:140`

- [ ] **Step 1：改文案**

`README.md` 第 30 行：

```markdown
每次协作默认最多 10 轮、花费上限 $10，批准时可以改；到最后一轮时，电脑会问你要不要再加 10 轮。
```

`docs/ui.md` 第 140 行“气泡”那一条里的例子：把“我的 Claude · 问答 · 5 轮 · $1.00”改成“我的 Claude · 问答 · 10 轮 · $10.00”。同一条末尾“同意、结束这类事件是居中的 12px 灰字。”后面加一句：

```markdown
进入最后一轮时，对话里多一行灰字“最后 1 轮”；被问一方的主人在底部轮数和花费后面看到文字按钮“加 10 轮”，刚用完轮数结束的对话也有。
```

- [ ] **Step 2：确认全部测试仍然通过**

Run: `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`。

- [ ] **Step 3：提交**

```bash
git add README.md
git add -p docs/ui.md
git commit -m "docs: 10 rounds and \$10 by default, and 加 10 轮 in the last round

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## 交付时的三句话

- **用户**：默认能聊 10 轮，聊到最后一轮时电脑直接问一句“加 10 轮”，点一下就接着聊，不用等对方申请、自己再批一次。
- **开发者**：加轮只有 `RelayService.addRounds` 一处，网页、弹框、MCP 工具都调同一个接口；macOS 弹框抽成了 `macDialog`，批准框、“好”提醒框和新的两个按钮弹框共用这一份。
- **AI Agent**：主人说“再给它 10 轮”，被问的 AI 用 `add_rounds` 就能加，工具返回加了多少、现在最多多少。

## 自查（写计划时做过）

- 8o 每一条都有任务：默认范围（Task 1）、最后一轮的弹框和灰字（Task 2、4）、加了怎样（Task 2）、不理照 8g（不改 8g 的代码，Task 2 的第二个测试确认刚用完时能加）、自己的 AI 之间不弹（Task 2 只对 `!thread.own` 发事件；网页 `othersAsk` 排除 `own`）、底部按钮和前台 AI（Task 5、6）。
- 和设计稿的一处差别：弹框和底部写“9 / 10 轮”（已经答完的轮数，和现有底部那一行的算法一致），设计稿上画的是“10 / 10 轮”。
- 刚用完轮数结束的协作也能加（`addRounds` 允许 `closed` 且 `spent`）：最后一轮的弹框常常在回答发出、协作已经结束之后才被点，不允许的话按钮就白点了。
