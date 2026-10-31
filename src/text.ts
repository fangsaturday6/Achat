// Joins Chinese and Latin text with a space where a Latin word meets a
// Chinese one ("老王的 Codex 想问你的 Claude").
export function cjk(...parts: string[]): string {
  return parts.reduce((out, part) => (/[A-Za-z0-9]$/.test(out) || /^[A-Za-z0-9]/.test(part) ? `${out} ${part}` : out + part));
}
