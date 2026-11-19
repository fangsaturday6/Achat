// What the group pages show, worked out without touching the page: web/app.js
// draws it, and test/web-groups.test.ts checks it in Node. Words and numbers
// that come from the relay are written here once; the tests keep them the
// same as src/types.ts and src/relay/groups.ts.
import { cjk, isOwn, messageText, ownerName } from "./text.js";

// "@所有人" in a message's mentions (ALL in src/types.ts), and as it is written.
export const ALL = "all";
const EVERYONE = "所有人";

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

// 消息's number, the conversations that need the person and the invites
// waiting on them, and the label that says which.
export function messagesBadge(conversations, invites) {
  const what = [conversations ? `${conversations} 个对话` : null, invites ? `${invites} 个进群邀请` : null].filter(Boolean);
  return { count: conversations + invites, label: what.length ? `消息，${what.join("、")}等你看` : "消息" };
}

// A group's address in /api/groups, and its parts after: an action ("leave"),
// or an invite and what is done with it. No group: /api/groups itself.
export function groupPath(...parts) {
  return ["/api/groups", ...parts.map(encodeURIComponent)].join("/");
}

// What 消息 and the open group show once /api/groups and the group's own
// address (`wanted`, if one is open) answer, each as Promise.allSettled
// gives it. What failed keeps what `before` showed, the open group only if
// it is the same one; a group the person cannot open (404: removed from it,
// left it, or a wrong link) is `gone`, and the page goes back to 消息.
export function loadedGroups(before, wanted, list, one) {
  const groups = list.status === "fulfilled" ? list.value : before.groups;
  if (!wanted) return { groups, group: null, gone: false };
  if (one.status === "fulfilled") return { groups, group: one.value, gone: false };
  const gone = one.reason?.status === 404;
  return { groups, group: !gone && before.group?.id === wanted ? before.group : null, gone };
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

// Who the person can @, as the list under "@" shows them: 所有人 first, then
// the AIs that are on (others' before the person's own), then those whose
// computer is off, and last, grayed out, those that cannot answer yet.
// `me`: the person's account; `query`: what was typed after the @.
export function pickerOptions(members, me, query = "") {
  const rank = (m) => (!m.canReceive ? 3 : !m.online ? 2 : isOwn(m, me) ? 1 : 0);
  const ais = members
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => fits(m.name, query))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => ({ id: m.agent, name: m.name, note: !m.canReceive ? "还不能接收" : !m.online ? "不在线" : null, disabled: !m.canReceive }));
  const everyone = fits(EVERYONE, query) ? [{ id: ALL, name: EVERYONE, note: null, disabled: false }] : [];
  return [...everyone, ...ais];
}

// Whether the list under "@" shows `name` for what was typed after the @;
// 所有人 also for "all".
function fits(name, query) {
  const q = query.toLowerCase();
  return !q || name.toLowerCase().includes(q) || (name === EVERYONE && "all".startsWith(q));
}

// The @ being typed just before the caret, and what follows it; null when
// there is none, or the line or a space after a name ended it.
export function mentionAt(text, caret) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  return /\n|\s$/.test(query) || query.length > 30 ? null : { start: at, query };
}

// The box once `name` is picked from the list under "@": the @ being typed
// before the caret becomes "@名字 ", the caret after it. Worked out from where
// the caret is now, which a click or an arrow key may have moved since the
// list opened; null when no @ there is one `name` fits.
export function applyPick(value, caret, name) {
  const at = mentionAt(value, caret);
  if (!at || !fits(name, at.query)) return null;
  const tag = `@${name} `;
  return { value: value.slice(0, at.start) + tag + value.slice(caret), caret: at.start + tag.length };
}

// What the person wrote, as it goes into the group: the AIs it @s (所有人
// first, then in the order written), and each "@我的 Claude" written from
// nobody's side ("@老方的 Claude"), as the AIs write. Each AI is found by
// either name, in one pass, longer names first, so "@老王的 Codex（iMac）"
// is not also taken for "@老王的 Codex".
export function composeMessage(text, members, myName) {
  const byName = new Map();
  for (const m of members) byName.set(m.name, m);
  for (const m of members) {
    const plain = plainName(m.name, myName);
    if (!byName.has(plain)) byName.set(plain, m);
  }
  const names = [EVERYONE, ...byName.keys()].sort((a, b) => b.length - a.length);
  const tag = new RegExp(`@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  let all = false;
  const ais = [];
  const body = text.trim().replace(tag, (_, name) => {
    if (name === EVERYONE) {
      all = true;
      return `@${EVERYONE}`;
    }
    const m = byName.get(name);
    if (!ais.includes(m.agent)) ais.push(m.agent);
    return `@${plainName(m.name, myName)}`;
  });
  return { body, mentions: all ? [ALL, ...ais] : ais };
}

// The person's AI nearest its 每天次数, for the bottom of the group: "我的
// Claude 今天 12 / 30 次". Nearest is the fewest times left; of those, the
// one with more of its share used. `full` once it is used up. Null without one.
export function quotaLine(members, me) {
  const mine = members.filter((m) => isOwn(m, me));
  if (!mine.length) return null;
  const left = (m) => m.quota - m.usedToday;
  const nearer = (a, b) => left(b) < left(a) || (left(b) === left(a) && b.usedToday / b.quota > a.usedToday / a.quota);
  const m = mine.reduce((a, b) => (nearer(a, b) ? b : a));
  return { agent: m.agent, text: `${m.name} 今天 ${m.usedToday} / ${m.quota} 次`, full: m.usedToday >= m.quota };
}

// The AI or the person's seat behind a sender in a group, with the account it
// belongs to, as ownerLabel and isOwn in web/text.js take it: as `agents`
// (/api/agents: the person's and their friends') has it, else as the group
// does, an AI in it, or a person's seat ("p_" and their account). Null for one
// gone from both, known only by its name.
export function whoIn(id, g, agents) {
  const known = agents.get(id);
  if (known) return known;
  const member = g.members.find((m) => m.agent === id);
  if (member) return { name: member.name, owner: member.owner };
  if (id?.startsWith("p_")) return { name: g.names[id] ?? "", client: "person", owner: id.slice(2) };
  return null;
}

// Whether a message in the group is the person's own, shown on the right:
// from their seat, or from one of their AIs, by account (whoIn). One gone
// from the group and from /api/agents too goes by its name from the person's
// side, "我的 Claude", the one trace of it left.
export function sentByMe(sender, g, me, agents) {
  const who = whoIn(sender, g, agents);
  if (who) return isOwn(who, me);
  return (g.names[sender] ?? "").startsWith("我的");
}

// Some AI is reading a message right now: 叫停 shows.
export function isAnswering(g) {
  return g.status === "open" && g.messages.some((m) => m.receipts.some((r) => r.state === "reading"));
}

// What 群设置 shows the person `me`: 群名 to change and 解散群 for 群主,
// 邀请 and the 每天次数 of their AIs (`quotas`), all until the group is
// dissolved; 退出群 while an AI of theirs (`mine`) is in it.
export function settingsView(g, me) {
  const open = g.status !== "dissolved";
  const owner = g.owner === me;
  const mine = g.members.filter((m) => isOwn(m, me));
  return { rename: owner && open, invite: open, quotas: open ? mine : [], mine, leave: mine.length > 0, dissolve: owner && open };
}

// The members in 群设置: the AIs in the group (the person `me`'s own marked
// `mine`), then those invited, who show as 等加入. `id`: the AI, or the
// invite, with whom it is for and the AI it asks for by name, if one. `who`:
// whose face it has (ownerLabel in web/text.js), the AI's person or the one
// invited.
export function settingsTiles(g, me) {
  return [
    ...g.members.map((m) => ({ id: m.agent, name: m.name, waiting: false, mine: isOwn(m, me), who: { name: m.name, owner: m.owner } })),
    ...g.invites.map((i) => ({
      id: i.id,
      name: i.agentName ?? i.name,
      waiting: true,
      mine: false,
      account: i.account,
      agent: i.agent,
      who: { name: i.name, client: "person", owner: i.account },
    })),
  ];
}

// What a click on a member in 群设置 offers: the person's own AI may leave;
// 群主 may remove another's; an invite for another of the person's AIs, by
// name, they join or decline right there (they see no invite card once in).
// Nothing once dissolved.
export function tileActions(tile, g, me) {
  if (g.status === "dissolved") return [];
  if (tile.waiting) return tile.account === me && tile.agent ? ["join", "decline"] : [];
  if (tile.mine) return ["leave"];
  return g.owner === me ? ["remove"] : [];
}

// What leaving does, asked before it is done; `agents`: the person's AIs
// that leave. Their last one takes the person out: 群主 passes to the person
// whose AI joined first (drop in src/relay/groups.ts), and with nobody
// else's AI left the group ends.
export function leaveNote(g, me, agents) {
  if (g.status === "dissolved") return "退出后你就看不到这个群了。";
  const rest = g.members.filter((m) => !agents.includes(m.agent));
  if (rest.some((m) => isOwn(m, me))) return cjk(g.members.find((m) => m.agent === agents[0]).name, "退出后不会再被叫醒。");
  if (!rest.length) return "群里只剩你的 AI，退出后群会解散。";
  if (g.owner === me) return `退出后群主交给${ownerName(rest[0].name)}，你也看不到这个群了。`;
  return "退出后你的 AI 不会再被叫醒，你也看不到这个群了。";
}

// 每天次数 as typed, in half- or full-width digits, or null when it is not a
// whole number from 1 to the most.
export function quotaOf(text) {
  const digits = String(text)
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return n >= 1 && n <= QUOTA.max ? n : null;
}

// What is wrong with 每天次数 as typed, in the relay's words (checkQuota in
// src/relay/groups.ts); null when quotaOf takes it.
export function quotaProblem(text) {
  return quotaOf(text) === null ? `每天次数需要在 1 到 ${QUOTA.max} 之间` : null;
}

// What is picked in 发起群聊 and 邀请: people ({person, name}), who choose
// their AIs, and AIs ({agent, owner, name}). Picking a person drops their
// AIs picked one by one, and the other way round; picking again unpicks.
const pickKey = (p) => (p.person ? `person:${p.person}` : `agent:${p.agent}`);

export function isPicked(picked, item) {
  return picked.some((p) => pickKey(p) === pickKey(item));
}

export function togglePick(picked, item) {
  if (isPicked(picked, item)) return picked.filter((p) => pickKey(p) !== pickKey(item));
  const clash = item.person ? (p) => p.owner === item.person : (p) => p.person === item.owner;
  return [...picked.filter((p) => !clash(p)), item];
}

// What stops 完成: a new group needs one of the person's own AIs (as
// createGroup in src/relay/groups.ts checks); an invite (`group`) does not.
export function pickProblem(picked, me, group) {
  return !group && !picked.some((p) => isOwn(p, me)) ? "群里至少要有你自己的一个 AI" : null;
}

// The rows of 发起群聊 and 邀请: a heading, the person's own AIs, a heading,
// then each friend ({person, name}, who picks their AIs) with their AIs under
// them while the arrow (`toggle`) has them open. Searching (`query`) shows
// those that fit, opened, with no arrow. In 邀请 (`group`) an AI already in
// is left out; a friend with an AI in is not offered as a person again, only
// their AIs still out (nothing, once all are in); and a friend invited and
// not yet in, or an AI an invite asks for (the person's own too, answered on
// its tile in 群设置), shows 等加入 (`waiting`) and cannot be picked: one
// person, one invite card.
export function pickerRows({ me, agents, contacts, group = null, query = "", opened = new Set() }) {
  const q = query.toLowerCase();
  const fits = (...texts) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const inGroup = new Set((group?.members ?? []).map((m) => m.agent));
  const invitesOf = (account) => (group?.invites ?? []).filter((i) => i.account === account);
  const asked = (account, a) => invitesOf(account).some((i) => i.agent === null || i.agent === a.id);
  const ai = (a, owner, waiting, indent) => ({
    kind: "ai",
    item: { agent: a.id, owner, name: a.name, client: a.client, speaksOnly: a.canReceive === false },
    waiting,
    indent,
  });
  const own = agents.filter((a) => isOwn(a, me) && a.client !== "person" && !inGroup.has(a.id) && fits(a.name)).map((a) => ai(a, me, asked(me, a), false));
  const friends = contacts.flatMap((f) => {
    const out = f.agents.filter((a) => !inGroup.has(a.id));
    const isIn = (group?.members ?? []).some((m) => m.owner === f.id);
    const invites = invitesOf(f.id);
    const waits = (a) => (!isIn && invites.length > 0) || asked(f.id, a);
    if (isIn) return out.filter((a) => fits(a.name)).map((a) => ai(a, f.id, waits(a), false));
    if (!fits(f.name, ...out.map((a) => a.name))) return [];
    const open = !!q || opened.has(f.id);
    const person = { kind: "person", item: { person: f.id, name: f.name }, waiting: invites.length > 0, toggle: q || !out.length ? null : open ? "open" : "closed" };
    return [person, ...(open ? out.filter((a) => fits(a.name)).map((a) => ai(a, f.id, waits(a), true)) : [])];
  });
  return [
    ...(own.length ? [{ kind: "head", text: "我的 AI" }, ...own] : []),
    ...(friends.length ? [{ kind: "head", text: "朋友" }, ...friends] : []),
  ];
}

// What stops a new group's first words from going: "@所有人" alone, with no
// file, says nothing to discuss (createGroup takes it as no opening message).
export function openingProblem(text, files) {
  return !text.replaceAll(`@${EVERYONE}`, "").trim() && !files ? "写一句要讨论的事" : null;
}

// What 完成 sends, as /api/groups takes members: {"agent"} or {"account"}.
export function targetsOf(picked) {
  return picked.map((p) => (p.person ? { account: p.person } : { agent: p.agent }));
}

// The person's invite card is all their invites to the group (`invites`):
// one that lets them pick, or each AI asked for by name; 加入 and 拒绝
// answer them all.
//
// The AIs the person `me` may bring in with it: their own, of `agents`
// (/api/agents, which has their friends' too), those that can answer
// ticked; just those asked for by name, ticked and fixed. 豆包 and the like
// can join but only speak when told. `note`, gray on the right: 只能发言,
// or the computer it is on (`devices`, from /api/me), unless its name
// already says so, as with two Claudes: "我的 Claude（MacBook）".
export function inviteChoices(invites, agents, me, devices = []) {
  const named = invites.every((i) => i.agent) ? invites.map((i) => i.agent) : null;
  const mine = agents.filter((a) => isOwn(a, me) && a.client !== "person");
  const shown = named ? mine.filter((a) => named.includes(a.id)) : mine;
  return shown.map((a) => {
    const device = devices.find((d) => d.agents?.some((x) => x.id === a.id))?.name ?? null;
    const speaksOnly = a.canReceive === false;
    return {
      id: a.id,
      name: a.name,
      client: a.client,
      checked: !!named || !speaksOnly,
      locked: !!named,
      speaksOnly,
      note: speaksOnly ? "只能发言" : device && !a.name.includes(`（${device}）`) ? device : null,
    };
  });
}

// Why an invite card has nothing to bring in, so 加入 cannot be pressed: the
// AIs it asks for are gone, or the person has none yet (`connect`: the way
// to one). Null when there is something.
export function inviteEmpty(invites, choices) {
  if (choices.length) return null;
  if (invites.every((i) => i.agent)) return { text: cjk(invites.map((i) => i.agentName).filter(Boolean).join("、") || "这个 AI", "已移除"), connect: false };
  return { text: "先连接 AI", connect: true };
}
