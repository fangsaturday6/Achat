// Emails the cloud sends. Each has a plain-text version and an HTML version
// built from tables and inline styles, which is what mail clients render.

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// Single quotes: these go inside style="..." attributes.
const FONT = `-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif`;
const MONO = `'SF Mono',Menlo,Consolas,'Courier New',monospace`;

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function loginCodeEmail(to: string, code: string, site: string): Email {
  const host = new URL(site).host;
  const text = [
    `你的 Achat 登录验证码：${code}`,
    "",
    "10 分钟内有效，只能用一次。只在登录页面输入，不要告诉任何人。",
    "",
    "不是你本人在登录的话，忽略这封邮件即可，账号不会有任何变化。",
    "",
    `Achat · ${host}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Achat 验证码</title>
</head>
<body style="margin:0;padding:0;background:#f7f8fa;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">验证码 ${escape(code)}，10 分钟内有效</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f8fa;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;background:#ffffff;border:1px solid #e2e2e0;border-radius:12px;font-family:${FONT};">
<tr><td style="padding:32px 32px 6px;font-size:14px;line-height:20px;font-weight:600;color:#2a5fe0;">Achat</td></tr>
<tr><td style="padding:0 32px;font-size:20px;line-height:28px;font-weight:600;color:#191919;">登录验证码</td></tr>
<tr><td style="padding:20px 32px 0;">
<div style="background:#eef3ff;border-radius:8px;padding:18px 8px;text-align:center;font-family:${MONO};font-size:36px;line-height:44px;font-weight:700;letter-spacing:10px;color:#191919;">${escape(code)}</div>
</td></tr>
<tr><td style="padding:16px 32px 0;font-size:14px;line-height:22px;color:#5f5f5f;">10 分钟内有效，只能用一次。只在登录页面输入，不要告诉任何人。</td></tr>
<tr><td style="padding:24px 32px 28px;">
<div style="border-top:1px solid #ececea;padding-top:16px;font-size:12px;line-height:18px;color:#9a9a97;">不是你本人在登录的话，忽略这封邮件即可，账号不会有任何变化。</div>
</td></tr>
</table>
<div style="padding-top:16px;font-family:${FONT};font-size:12px;line-height:18px;color:#9a9a97;">Achat · ${escape(host)}</div>
</td></tr>
</table>
</body>
</html>
`;
  return { to, subject: `${code} 是你的 Achat 验证码`, text, html };
}
