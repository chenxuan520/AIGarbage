import { marked } from "marked";
import { getImage, getIndex, getPost } from "./store";
import type { Env, PostMeta } from "./types";

marked.setOptions({ gfm: true, breaks: false });

const PER_PAGE = 12;

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escXml(s: string): string {
  return escHtml(s).replace(/'/g, "&apos;");
}

// The title is already rendered by the template, so drop a leading level-1
// heading from the article body to avoid showing the title twice.
function stripLeadingH1(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n?/, "");
}

function inlineImgTag(slug: string, i: number): string {
  return `<img class="inline-img" src="/img/${encodeURIComponent(slug)}?i=${i}" alt="" loading="lazy">`;
}

// Spread the extra (non-cover) images across the article between paragraphs.
function embedInlineImages(html: string, slug: string, count: number): string {
  if (count <= 0) return html;
  const parts = html.split("</p>");
  if (parts.length <= 2) {
    let tail = "";
    for (let i = 1; i <= count; i++) tail += inlineImgTag(slug, i);
    return html + tail;
  }
  const breaks = parts.length - 1;
  const step = Math.max(1, Math.floor(breaks / (count + 1)));
  let out = "";
  let placed = 0;
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < parts.length - 1) {
      out += "</p>";
      if (placed < count && (i + 1) % step === 0) {
        placed += 1;
        out += inlineImgTag(slug, placed);
      }
    }
  }
  while (placed < count) {
    placed += 1;
    out += inlineImgTag(slug, placed);
  }
  return out;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--fg:#e8eaed;--muted:#9aa4b2;--accent:#6ea8fe;--border:#242832}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:inherit;text-decoration:none}
.site-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--border);background:rgba(15,17,21,.82);backdrop-filter:blur(10px)}
.brand{font-weight:800;font-size:20px;color:var(--accent);letter-spacing:.5px}
.site-header nav a{color:var(--muted);margin-left:16px;font-size:14px}
.container{max-width:960px;margin:0 auto;padding:28px 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:22px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:transform .15s ease,border-color .15s ease}
.card:hover{transform:translateY(-4px);border-color:var(--accent)}
.cover{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#0b0d11}
.cover.placeholder{background:linear-gradient(135deg,#1d2230,#3a3f4b)}
.card h2{font-size:17px;line-height:1.4;margin:13px 15px 6px}
.card time{display:block;color:var(--muted);font-size:13px;margin:0 15px 15px}
.post{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;padding-bottom:30px}
.post-cover{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
.post h1{font-size:30px;line-height:1.3;margin:26px 30px 8px}
.post>time{display:block;color:var(--muted);margin:0 30px 22px}
.post :is(h2,h3,h4,p,ul,ol,blockquote,pre,table){margin-left:30px;margin-right:30px}
.post h2{margin-top:28px;font-size:23px}
.post h3{margin-top:22px;font-size:19px}
.post img{max-width:calc(100% - 60px);margin:14px 30px;border-radius:10px}
.post .inline-img{width:calc(100% - 60px);height:auto;margin:22px 30px;border-radius:12px;display:block;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.post pre{background:#0b0d11;border:1px solid var(--border);padding:14px;border-radius:10px;overflow:auto}
.post code{background:#0b0d11;padding:2px 6px;border-radius:6px;font-size:.92em}
.post pre code{padding:0;background:none}
.post blockquote{border-left:3px solid var(--accent);color:var(--muted);padding:2px 0 2px 16px;margin-left:30px}
.src{color:var(--muted);font-size:14px;margin:24px 30px 0;border-top:1px dashed var(--border);padding-top:16px}
.empty{color:var(--muted);text-align:center;padding:60px 0}
.pager{display:flex;gap:14px;align-items:center;justify-content:center;margin:32px 0 8px}
.pager a,.pager span{padding:8px 14px;border:1px solid var(--border);border-radius:9px;color:var(--muted)}
.pager a:hover{border-color:var(--accent);color:var(--fg)}
.site-footer{text-align:center;color:var(--muted);font-size:13px;padding:34px 20px;border-top:1px solid var(--border);margin-top:48px}
`;

function layout(env: Env, title: string, body: string): string {
  const site = escHtml(env.SITE_TITLE || "AIGarbage");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${escHtml(env.SITE_DESC || "")}">
<title>${escHtml(title)}</title>
<link rel="alternate" type="application/rss+xml" href="/rss.xml" title="${site}">
<style>${CSS}</style>
</head>
<body>
<header class="site-header"><a class="brand" href="/">${site}</a><nav><a href="/rss.xml">RSS</a></nav></header>
<main class="container">${body}</main>
<footer class="site-footer">Powered by AI &amp; Cloudflare Workers &middot; ${site}</footer>
</body>
</html>`;
}

function cardHtml(m: PostMeta): string {
  const cover = m.hasCover
    ? `<img class="cover" src="/img/${encodeURIComponent(m.slug)}" alt="" loading="lazy">`
    : `<div class="cover placeholder"></div>`;
  return `<article class="card"><a href="/post/${encodeURIComponent(m.slug)}">${cover}<h2>${escHtml(
    m.title,
  )}</h2></a><time>${escHtml(m.date.slice(0, 10))}</time></article>`;
}

function pagerHtml(page: number, total: number): string {
  if (total <= 1) return "";
  const prev = page > 1 ? `<a href="/?page=${page - 1}">&larr; 上一页</a>` : "";
  const next = page < total ? `<a href="/?page=${page + 1}">下一页 &rarr;</a>` : "";
  return `<nav class="pager">${prev}<span>${page} / ${total}</span>${next}</nav>`;
}

export async function renderHome(env: Env, page = 1): Promise<Response> {
  const index = await getIndex(env);
  const totalPages = Math.max(1, Math.ceil(index.length / PER_PAGE));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * PER_PAGE;
  const slice = index.slice(start, start + PER_PAGE);

  const body = slice.length
    ? `<div class="grid">${slice.map(cardHtml).join("")}</div>${pagerHtml(current, totalPages)}`
    : `<p class="empty">还没有文章,等待第一次定时生成,或访问 /admin/generate 手动触发。</p>`;

  return htmlResponse(layout(env, env.SITE_TITLE || "AIGarbage", body));
}

export async function renderPost(env: Env, slug: string): Promise<Response> {
  const post = await getPost(env, slug);
  if (!post) return htmlResponse(layout(env, "404", `<p class="empty">文章不存在。</p>`), 404);

  const cover = post.hasCover
    ? `<img class="post-cover" src="/img/${encodeURIComponent(slug)}" alt="">`
    : "";
  const rendered = String(await marked.parse(stripLeadingH1(post.markdown)));
  const content = embedInlineImages(rendered, slug, post.inlineImages ?? 0);
  const source = post.source?.url
    ? `<p class="src">灵感来源:<a href="${escHtml(
        post.source.url,
      )}" rel="nofollow noopener" target="_blank">${escHtml(post.source.title)}</a></p>`
    : "";

  const body = `<article class="post">${cover}<h1>${escHtml(post.title)}</h1><time>${escHtml(
    post.date.slice(0, 10),
  )}</time>${content}${source}</article>`;

  return htmlResponse(layout(env, post.title, body));
}

export async function renderImage(env: Env, slug: string, idx = 0): Promise<Response> {
  const buf = await getImage(env, slug, idx);
  if (!buf) return new Response("Not found", { status: 404 });
  return new Response(buf, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export async function renderRss(env: Env, origin: string): Promise<Response> {
  const index = (await getIndex(env)).slice(0, 30);
  const site = env.SITE_TITLE || "AIGarbage";
  const items = index
    .map(
      (m) =>
        `<item><title>${escXml(m.title)}</title><link>${origin}/post/${encodeURIComponent(
          m.slug,
        )}</link><guid isPermaLink="false">${escXml(m.slug)}</guid><pubDate>${new Date(
          m.date,
        ).toUTCString()}</pubDate></item>`,
    )
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${escXml(site)}</title><link>${origin}/</link><description>${escXml(
    env.SITE_DESC || "",
  )}</description>${items}</channel></rss>`;
  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}

export async function renderSitemap(env: Env, origin: string): Promise<Response> {
  const index = await getIndex(env);
  const urls = [`${origin}/`, ...index.map((m) => `${origin}/post/${encodeURIComponent(m.slug)}`)]
    .map((u) => `<url><loc>${escXml(u)}</loc></url>`)
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
