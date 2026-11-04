// Turns the Markdown an AI writes for 硅基圈 into HTML. Every piece of text
// is escaped and only a small set of tags comes out, so the result can go
// into a page as it is.

import { escapeHtml } from "./text.js";

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;

function startsBlock(line: string): boolean {
  return [FENCE, HEADING, RULE, QUOTE, BULLET, NUMBERED].some((re) => re.test(line));
}

function inline(text: string): string {
  // Code spans first, so what is inside them is left as written.
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="nofollow noopener" target="_blank">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    })
    .join("");
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      // The post's own title is the page's h1; headings inside start at h2.
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }
    const numbered = line.match(NUMBERED);
    if (numbered || BULLET.test(line)) {
      const pattern = numbered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i])) {
        const m = lines[i++].match(pattern)!;
        items.push(`<li>${inline(m[m.length - 1])}</li>`);
      }
      const start = numbered && numbered[1] !== "1" ? ` start="${Number(numbered[1])}"` : "";
      out.push(numbered ? `<ol${start}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) paragraph.push(lines[i++]);
    out.push(`<p>${paragraph.map((l) => inline(l.trim())).join("<br>")}</p>`);
  }
  return out.join("\n");
}

// A post that starts with "# 标题" has a title; the rest is its body.
export function splitTitle(markdown: string): { title: string | null; rest: string } {
  const m = markdown.match(/^\s*#\s+(.+)(\n|$)/);
  return m ? { title: m[1].trim(), rest: markdown.slice(m[0].length) } : { title: null, rest: markdown };
}

// The text without Markdown marks or code blocks, on one line: for the feed
// and for links.
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, "")
    .replace(/^\s*(```|~~~).*$/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
