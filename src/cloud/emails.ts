// Emails the cloud sends. Each has a plain-text version and an HTML version
// built from tables and inline styles, which is what mail clients render.
// They follow docs/ui.md: a title, the one thing to act on, a button.

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// Single quotes: these go inside style="..." attributes.
const FONT = `-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif`;
const MONO = `'SF Mono',Menlo,Consolas,'Courier New',monospace`;
const ACCENT = "#2a5fe0";
// Avatar colours, picked by name the same way as web/app.js does.
const AVATAR_COLORS = ["#6a8fd8", "#5dae8b", "#e8a05b", "#9c7bd1"];

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Joins Chinese and Latin text with a space where a Latin word meets a
// Chinese one ("老王的 Codex 想问你的 Claude").
function cjk(...parts: string[]): string {
  return parts.reduce((out, part) => (/[A-Za-z0-9]$/.test(out) || /^[A-Za-z0-9]/.test(part) ? `${out} ${part}` : out + part));
}

function avatar(name: string): string {
  const owner = name.replace(/的.*$/, "");
  const letter = owner.slice(-1) || "?";
  const color = AVATAR_COLORS[[...owner].reduce((n, c) => n + c.codePointAt(0)!, 0) % AVATAR_COLORS.length];
  return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td width="56" height="56" align="center" style="width:56px;height:56px;border-radius:4px;background:${color};font-size:24px;line-height:56px;font-weight:500;color:#ffffff;">${escape(letter)}</td></tr></table>`;
}

function button(href: string, label: string): string {
  return `<a href="${escape(href)}" style="display:block;background:${ACCENT};border-radius:4px;padding:10px 0;text-align:center;font-size:15px;line-height:20px;color:#ffffff;text-decoration:none;">${escape(label)}</a>`;
}

// The card every email is drawn in. `rows` are <tr> elements.
function layout(title: string, preheader: string, rows: string[]): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escape(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;background:#ffffff;border:1px solid #e7e7e7;border-radius:8px;font-family:${FONT};">
<tr><td style="padding:28px 32px 0;font-size:14px;line-height:20px;font-weight:500;color:${ACCENT};">Achat</td></tr>
${rows.join("\n")}
<tr><td style="padding:0 0 28px;"></td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

function heading(text: string): string {
  return `<tr><td align="center" style="padding:16px 32px 0;font-size:18px;line-height:26px;font-weight:500;color:#191919;">${escape(text)}</td></tr>`;
}

function cell(html: string, top = 20): string {
  return `<tr><td style="padding:${top}px 32px 0;">${html}</td></tr>`;
}

export function loginCodeEmail(to: string, code: string, site: string): Email {
  const host = new URL(site).host;
  const text = [`你的 Achat 登录验证码：${code}`, "", "10 分钟内有效，不要告诉任何人。", "", `Achat · ${host}`].join("\n");
  const html = layout("Achat 验证码", `验证码 ${code}，10 分钟内有效`, [
    heading("登录验证码"),
    cell(
      `<div style="background:#f2f2f2;border-radius:8px;padding:18px 8px;text-align:center;font-family:${MONO};font-size:36px;line-height:44px;font-weight:500;letter-spacing:10px;color:#191919;">${escape(code)}</div>`,
    ),
    `<tr><td align="center" style="padding:16px 32px 0;font-size:13px;line-height:20px;color:#6b6b6b;">10 分钟内有效，不要告诉任何人。</td></tr>`,
    `<tr><td align="center" style="padding:12px 32px 0;font-size:12px;line-height:17px;color:#6b6b6b;">${escape(host)}</td></tr>`,
  ]);
  return { to, subject: `${code} 是你的 Achat 验证码`, text, html };
}

export interface RequestNotice {
  fromName: string; // 老王的 Codex
  toName: string; // 你的 Claude
  topic: string;
  question: string;
  link: string;
  settingsLink: string;
}

// Tells a person that someone's AI is asking one of theirs, with a button to
// the request; the approval itself happens on the page.
export function requestEmail(to: string, n: RequestNotice): Email {
  const question = n.question.length > 300 ? n.question.slice(0, 300) + "……" : n.question;
  const title = cjk(n.fromName, "想问", n.toName);
  const text = [`${title}：${n.topic}`, "", question, "", `查看：${n.link}`, "", `关闭邮件提醒：${n.settingsLink}`].join("\n");
  const html = layout(title, `${n.topic}：${question.slice(0, 60)}`, [
    cell(avatar(n.fromName)),
    heading(title),
    cell(
      `<div style="background:#f2f2f2;border-radius:8px;padding:14px 16px;">
<div style="font-size:14px;line-height:22px;font-weight:500;color:#191919;">${escape(n.topic)}</div>
<div style="padding-top:4px;font-size:14px;line-height:22px;color:#191919;white-space:pre-wrap;">${escape(question)}</div>
</div>`,
    ),
    cell(button(n.link, "查看")),
    `<tr><td align="center" style="padding:16px 32px 0;font-size:12px;line-height:17px;"><a href="${escape(n.settingsLink)}" style="color:#6b6b6b;">关闭邮件提醒</a></td></tr>`,
  ]);
  return { to, subject: `${title}：${n.topic}`, text, html };
}

// An invite sent to an email. Someone already on Achat sees it as a friend
// request; someone new is asked to join.
export function inviteEmail(to: string, n: { fromName: string; link: string; joined: boolean }): Email {
  const title = n.joined ? cjk(n.fromName, "想加你为 Achat 朋友") : cjk(n.fromName, "邀请你加入 Achat");
  const text = [title, "", `接受邀请：${n.link}`, "", "7 天内有效。"].join("\n");
  const html = layout(title, "7 天内有效", [cell(avatar(n.fromName)), heading(title), cell(button(n.link, "接受邀请"))]);
  return { to, subject: title, text, html };
}

// Tells the inviter that the other person accepted.
export function acceptedEmail(to: string, n: { name: string; link: string }): Email {
  const subject = cjk(n.name, "接受了你的邀请");
  const title = cjk(n.name, "已成为你的朋友");
  const text = [title, "", `打开 Achat：${n.link}`].join("\n");
  const html = layout(subject, title, [cell(avatar(n.name)), heading(title), cell(button(n.link, "打开 Achat"))]);
  return { to, subject, text, html };
}
