// Words the page writes, shared by web/app.js and web/groups.js.

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

// The words of a message in a list: what it said, or what it sent.
export function messageText(m) {
  if (m.body || !m.files?.length) return m.body;
  return m.files.every((f) => SHOWN_TYPES.has(f.type)) ? "[图片]" : `[文件] ${m.files.find((f) => !SHOWN_TYPES.has(f.type)).name}`;
}
