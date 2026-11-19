// What the page works out without touching it, shared by web/app.js and
// web/groups.js: the words it writes, and whose an AI is.

// Pictures shown in a conversation; other files are cards to download.
export const SHOWN_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Joins text with a space only where a Latin word meets a Chinese one:
// "连接 Claude Code"、"连接豆包".
export function cjk(...parts) {
  const han = /[一-鿿]/;
  return parts.reduce((out, part) => {
    const a = out.at(-1) ?? "";
    const b = part[0] ?? "";
    const gap = (/[A-Za-z0-9]/.test(a) && han.test(b)) || (han.test(a) && /[A-Za-z0-9]/.test(b));
    return gap ? `${out} ${part}` : out + part;
  });
}

// Whose an AI is, by its name: "小林的 Codex" is 小林's.
export function ownerName(name) {
  return name.replace(/的.*$/, "");
}

// Whether an AI or a person's seat is the person's own: one in /api/agents, a
// member of a group and one picked all carry their account as `owner`. By
// that, never by its name, as a friend may be called 我爱罗, or even 我. On
// this computer there are no accounts (`me` and `owner` are absent), and
// every AI listed is the person's.
export function isOwn(agent, me) {
  return !!agent && (agent.owner ?? null) === (me ?? null);
}

// Whom an AI or a seat belongs to, by name, as its face and "等老王批准"
// show it: the person themself (`myName`) for theirs; a friend as 通讯录
// names them (`contacts`), or else as the AI's name says ("王闯的 Codex"),
// or the seat's. "" for one the page does not know.
export function ownerLabel(agent, { me, myName, contacts = [] }) {
  if (!agent) return "";
  if (isOwn(agent, me)) return myName;
  return contacts.find((c) => c.id === agent.owner)?.name ?? (agent.client === "person" ? agent.name : ownerName(agent.name));
}

// One of a thing for each key, made the first time it is asked for and the
// same one after, until dropped: the box each conversation is written in.
export function keeper() {
  const kept = new Map();
  return {
    get(key, make) {
      if (!kept.has(key)) kept.set(key, make());
      return kept.get(key);
    },
    drop(key) {
      kept.delete(key);
    },
  };
}

// The words of a message in a list: what it said, or what it sent.
export function messageText(m) {
  if (m.body || !m.files?.length) return m.body;
  return m.files.every((f) => SHOWN_TYPES.has(f.type)) ? "[图片]" : `[文件] ${m.files.find((f) => !SHOWN_TYPES.has(f.type)).name}`;
}
