// Filters sensitive values out of text an agent is about to send to another
// agent. It is a best-effort pattern filter, not a guarantee; the count is
// shown to people next to the message.

interface Rule {
  pattern: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "[已过滤：私钥]",
  },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, replace: "[已过滤：密钥]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "[已过滤：令牌]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[已过滤：令牌]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "[已过滤：令牌]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[已过滤：密钥]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, replace: "Bearer [已过滤：令牌]" },
  {
    pattern: /\b(api[_-]?key|secret|token|password|passwd)(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi,
    replace: (_m, name: string, sep: string, quote: string) =>
      `${name}${sep}${quote}[已过滤]${quote}`,
  },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: "[已过滤：邮箱]" },
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replace: "[已过滤：手机号]" },
  { pattern: /\/Users\/[^/\s]+/g, replace: "~" },
  { pattern: /\/home\/[^/\s]+/g, replace: "~" },
  { pattern: /[A-Za-z]:\\Users\\[^\\\s]+/g, replace: "~" },
];

export interface RedactResult {
  text: string;
  count: number;
}

export function redact(input: string): RedactResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      const match = args[0] as string;
      if (typeof rule.replace === "string") return rule.replace;
      const groups = args.slice(1, -2) as string[];
      return rule.replace(match, ...groups);
    });
  }
  return { text, count };
}
