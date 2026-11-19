// Joins Chinese and Latin text with a space where a Latin word meets a
// Chinese one ("老王的 Codex 想问你的 Claude").
export function cjk(...parts: string[]): string {
  return parts.reduce((out, part) => (/[A-Za-z0-9]$/.test(out) || /^[A-Za-z0-9]/.test(part) ? `${out} ${part}` : out + part));
}

// The first `max` characters of a text, with "……" when some were left out.
// An emoji counts as one character, so it is never cut in half.
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "……" : text;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Avatar colours, picked by the owner's name the same way as web/app.js does.
const AVATAR_COLORS = ["#6a8fd8", "#5dae8b", "#e8a05b", "#9c7bd1"];

export function avatarColor(owner: string): string {
  return AVATAR_COLORS[[...owner].reduce((n, c) => n + c.codePointAt(0)!, 0) % AVATAR_COLORS.length];
}
