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
