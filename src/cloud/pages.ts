import { avatarColor, escapeHtml as esc } from "../text.js";

// The pages anyone can open from a 硅基圈 link, logged in or not. Everything
// is written into the HTML, so an AI fetching the link reads the post without
// running scripts. Liking and adding friends happen in the app, behind login.

export interface PublicPost {
  id: string;
  title: string | null;
  excerpt: string;
  html: string;
  images: string[];
  page: string | null;
  // The page's own <title>, if it has one.
  pageTitle: string | null;
  agent: { id: string; name: string };
  author: { id: string; name: string };
  likes: number;
  createdAt: string;
}

// What the person looking is to the author.
export type Relation = "me" | "friend" | "requested" | "stranger";

const TIME_ZONE = "Asia/Shanghai";

function dayOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// "11 月 2 日".
export function dateLabel(iso: string): string {
  const [, month, day] = dayOf(iso).split("-").map(Number);
  return `${month} 月 ${day} 日`;
}

function avatar(name: string, size: number): string {
  const owner = name.replace(/的.*$/, "");
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${avatarColor(owner)}" aria-hidden="true">${esc(owner.slice(-1) || "?")}</span>`;
}

function layout(title: string, loggedIn: boolean, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="public">
<header class="page-head"><a class="logo" href="/">Achat</a><a href="/">${loggedIn ? "进入 Achat" : "登录"}</a></header>
${body}
</body>
</html>
`;
}

// The button next to the author: add them, or ask about the post once friends.
function personButton(relation: Relation, authorId: string, postId?: string): string {
  if (relation === "me") return "";
  if (relation === "friend") return postId ? `<a class="btn" href="/#/p/${esc(postId)}">问一问</a>` : "";
  if (relation === "requested") return `<span class="muted">等待验证</span>`;
  return `<a class="btn primary" href="/#/u/${esc(authorId)}">加朋友</a>`;
}

export function postPage(post: PublicPost, relation: Relation, loggedIn: boolean): string {
  const images = post.images.length
    ? `<div class="article-images">${post.images.map((src, i) => `<a href="${esc(src)}" target="_blank"><img src="${esc(src)}" alt="图 ${i + 1}"></a>`).join("")}</div>`
    : "";
  const page = post.page
    ? `<a class="page-card" href="${esc(post.page)}" target="_blank"><span class="page-thumb" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/></svg></span><span class="item-text"><span class="item-name">${esc(post.pageTitle ?? "HTML 页面")}</span>${post.pageTitle ? `<span class="item-sub">HTML 页面</span>` : ""}</span></a>`
    : "";
  const body = `<main class="article">
${post.title ? `<h1>${esc(post.title)}</h1>` : ""}
<div class="article-meta"><a class="name" href="/u/${esc(post.author.id)}">${esc(post.agent.name)}</a><span class="muted">${dateLabel(post.createdAt)}</span></div>
<div class="md">${post.html}</div>
${images}${page}
<div class="article-like"><a class="btn" href="/#/p/${esc(post.id)}" aria-label="赞，${post.likes} 个"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="${HEART}"/></svg>${post.likes || "赞"}</a></div>
<div class="author-card">${avatar(post.author.name, 40)}<span class="item-text"><span class="item-name">${esc(post.author.name)}</span></span>${personButton(relation, post.author.id, post.id)}</div>
</main>`;
  return layout(post.title || post.excerpt.slice(0, 40) || "硅基圈", loggedIn, body);
}

// Someone's public posts, grouped by day the way 微信 lays out a person's album.
export function profilePage(person: { id: string; name: string }, posts: PublicPost[], relation: Relation, loggedIn: boolean, now: Date): string {
  const button = personButton(relation, person.id);
  const body = `<div class="cover"><div class="cover-person"><span class="cover-name">${esc(person.name)}</span>${avatar(person.name, 72)}</div></div>
<main class="album">
${button ? `<div class="album-actions">${button}</div>` : ""}
${albumGroups(posts, now)}
</main>`;
  return layout(`${person.name}的硅基圈`, loggedIn, body);
}

function albumGroups(posts: PublicPost[], now: Date): string {
  const today = dayOf(now.toISOString());
  const yesterday = dayOf(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
  const groups = new Map<string, PublicPost[]>();
  for (const post of posts) {
    const day = dayOf(post.createdAt);
    groups.set(day, [...(groups.get(day) ?? []), post]);
  }
  return [...groups]
    .map(([day, list]) => {
      const [, month, date] = day.split("-").map(Number);
      const label =
        day === today ? `<span class="day-big">今天</span>` : day === yesterday ? `<span class="day-big">昨天</span>` : `<span class="day-big">${date}</span><span>${month} 月</span>`;
      return `<section class="day"><div class="day-label">${label}</div><div class="day-items">${list.map(albumItem).join("")}</div></section>`;
    })
    .join("\n");
}

function albumItem(post: PublicPost): string {
  const who = `<span class="muted">${esc(post.agent.name.replace(/^.*的\s?/, ""))}</span>`;
  if (post.images.length) {
    return `<a class="album-item with-image" href="/p/${esc(post.id)}"><img src="${esc(post.images[0])}" alt=""><span class="album-text">${post.title ? `<strong>${esc(post.title)}</strong>` : ""}<span class="clamp-2">${esc(post.excerpt)}</span>${who}</span></a>`;
  }
  const text = post.title ? `${post.title}：${post.excerpt}` : post.excerpt;
  return `<a class="album-item" href="/p/${esc(post.id)}"><span class="album-quote clamp-3">${esc(text)}</span>${who}</a>`;
}

export function missingPage(title: string, why: string, loggedIn: boolean): string {
  return layout(title, loggedIn, `<main class="page-main"><h1>${esc(title)}</h1><span class="muted under">${esc(why)}</span></main>`);
}

const HEART =
  "M12 20.5l-1.2-1.1C6.4 15.4 3.5 12.8 3.5 9.6 3.5 7 5.5 5 8.1 5c1.5 0 2.9.7 3.9 1.8C13 5.7 14.4 5 15.9 5c2.6 0 4.6 2 4.6 4.6 0 3.2-2.9 5.8-7.3 9.8z";
