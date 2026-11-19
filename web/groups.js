// What the group pages show, worked out without touching the page: web/app.js
// draws it, and test/web-groups.test.ts checks it in Node. Words and numbers
// that come from the relay are written here once; the tests keep them the
// same as src/types.ts and src/relay/groups.ts.
import { cjk, messageText } from "./text.js";

// "@所有人" in a message's mentions (ALL in src/types.ts).
export const ALL = "all";

// What became of an AI a message called on (RECEIPT_LABELS in src/types.ts).
export const RECEIPT_LABELS = {
  reading: "正在看",
  replied: "回复了",
  passed: "无需回复",
  offline: "不在线",
  quota: "额度用完了",
  cannot: "还不能接收",
  stopped: "已叫停",
  failed: "没答上",
};

// GROUP_STATUS_LABELS in src/types.ts.
export const GROUP_STATUS_LABELS = { open: "进行中", stopped: "已叫停", dissolved: "已解散" };

// 每天次数: the default and the most (GROUP_LIMITS in src/relay/groups.ts).
export const QUOTA = { perDay: 30, max: 500 };

// The second line of a group in 消息: an invite waiting on the person (shown
// after a red “[待加入]”), or who said the latest words.
export function groupPreview(g) {
  if (g.role === "invited") return { pending: true, text: cjk(g.myInvite?.invitedByName ?? "有人", "邀请你") };
  const m = g.lastMessage;
  if (!m) return { pending: false, text: "" };
  const said = messageText(m);
  return { pending: false, text: m.kind === "system" || !g.lastSender ? said : `${g.lastSender}：${said}` };
}

// The invites waiting on the person: they count on 消息, as 待批准 does. New
// words in a group only light its red dot.
export function invitesWaiting(groups) {
  return groups.filter((g) => g.role === "invited").length;
}

// A name as written in the group, from nobody's side, as the AIs read and
// write it ("@老方的 Claude"); the page names the person's own "我的 Claude".
export function plainName(name, myName) {
  if (name === "我") return myName;
  return name.startsWith("我的") ? `${myName}的${name.slice(2)}` : name;
}

// The @s a message makes, as written in it and as this person reads them,
// longest first. `me`: the person's name and seat (an AI may @ its person).
export function tagsOf(mentions, names, me) {
  const tags = [];
  for (const id of mentions) {
    if (id === ALL) tags.push({ find: "@所有人", show: "@所有人" });
    else if (id === me.seat) tags.push({ find: `@${me.name}`, show: `@${me.name}` });
    else if (names[id]) {
      const plain = plainName(names[id], me.name);
      tags.push({ find: `@${plain}`, show: `@${names[id]}` });
      // The person's own front AI may have written it from their side.
      if (plain !== names[id]) tags.push({ find: `@${names[id]}`, show: `@${names[id]}` });
    }
  }
  return tags.sort((a, b) => b.find.length - a.find.length);
}

// A message's words cut into plain text and @s; where two @s start at the
// same place, the longer one is taken.
export function segments(body, tags) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    let hit = null;
    for (const t of tags) {
      const at = body.indexOf(t.find, i);
      if (at >= 0 && (!hit || at < hit.at || (at === hit.at && t.find.length > hit.t.find.length))) hit = { at, t };
    }
    if (!hit) {
      out.push({ text: body.slice(i), at: false });
      break;
    }
    if (hit.at > i) out.push({ text: body.slice(i, hit.at), at: false });
    out.push({ text: hit.t.show, at: true });
    i = hit.at + hit.t.find.length;
  }
  return out;
}

// Where a time goes between messages: before the first, and after a quiet
// five minutes or more. Returns the seqs it goes before.
export function timeBreaks(messages, gapMs = 5 * 60_000) {
  const out = new Set();
  let last = null;
  for (const m of messages) {
    const at = Date.parse(m.createdAt);
    if (last === null || at - last >= gapMs) out.add(m.seq);
    last = at;
  }
  return out;
}

// The gray line under a message: the AIs it called on that did not reply,
// those in the same state together; null once every one replied. `open`: a
// click has more to show, for more than one AI or a reason.
export function receiptLine(receipts, names) {
  const items = receipts
    .filter((r) => r.state !== "replied")
    .map((r) => ({ agent: r.agent, name: names[r.agent] ?? "已移除的 AI", state: r.state, reason: r.reason }));
  if (!items.length) return null;
  const byState = new Map();
  for (const i of items) byState.set(i.state, [...(byState.get(i.state) ?? []), i.name]);
  const text = [...byState]
    .map(([state, who]) => {
      const named = who.length > 2 ? cjk(who[0], `等 ${who.length} 个 AI`) : who.join("、");
      return `${named} ${state === "reading" ? "正在看…" : RECEIPT_LABELS[state]}`;
    })
    .join(" · ");
  return { text, reading: byState.has("reading"), open: items.length > 1 || items.some((i) => i.reason), items };
}
