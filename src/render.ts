import { marked } from "marked";
import { getImage, getIndex, getPost } from "./store";
import type { Env, PostMeta } from "./types";

marked.setOptions({ gfm: true, breaks: false });

const PER_PAGE = 12;

// Neutral category label derived from the source outlet.
const CATEGORY: Record<string, string> = {
  huxiu: "商业",
  zhihu: "观点",
  "36kr": "科技",
  weibo: "社会",
  baidu: "热搜",
  toutiao: "热点",
  bilibili: "文化",
  douyin: "热点",
  ithome: "数码",
  wallstreetcn: "财经",
  cls: "财经",
  thepaper: "时事",
  hackernews: "科技",
  github: "开源",
};

function categoryOf(m: PostMeta): string {
  return (m.source && CATEGORY[m.source.id]) || "热点";
}

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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function stripLeadingH1(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n?/, "");
}

function inlineImgTag(slug: string, i: number): string {
  return `<img src="/img/${encodeURIComponent(slug)}?i=${i}" alt="" loading="lazy">`;
}

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

const CSS = `
:root{
  --bg:#ffffff;--bg2:#f6f7f9;--fg:#16181d;--ink:#222;--ink2:#374151;--muted:#6b7280;
  --line:#e6e8ec;--header:rgba(255,255,255,.92);--accent:#d7282f;--link:#1a56db;color-scheme:light;
}
:root[data-theme="dark"]{
  --bg:#0f1115;--bg2:#171a21;--fg:#eceef2;--ink:#d7dbe2;--ink2:#aab2bf;--muted:#8b94a3;
  --line:#262a33;--header:rgba(15,17,21,.9);--accent:#ff5a5f;--link:#7aa2ff;color-scheme:dark;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);transition:background .2s ease,color .2s ease;
  font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block}
.topbar{height:3px;background:var(--accent)}
.site-header{position:sticky;top:0;z-index:30;background:var(--header);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.hwrap{max-width:1080px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px}
.brand{display:flex;align-items:baseline;gap:9px}
.brand .name{font-size:25px;font-weight:900;letter-spacing:2px;color:var(--fg)}
.brand .name b{color:var(--accent)}
.brand .en{font-size:11px;color:var(--muted);letter-spacing:3px}
.nav{display:flex;align-items:center}
.nav a{color:var(--ink2);margin-left:22px;font-size:14.5px;font-weight:600}
.nav a:hover{color:var(--accent)}
.theme-toggle{margin-left:20px;width:36px;height:36px;border:1px solid var(--line);background:transparent;color:var(--fg);
  border-radius:9px;cursor:pointer;font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.theme-toggle:hover{border-color:var(--accent)}
.theme-toggle .ti-sun{display:none}
.theme-toggle .ti-moon{display:inline}
:root[data-theme="dark"] .theme-toggle .ti-sun{display:inline}
:root[data-theme="dark"] .theme-toggle .ti-moon{display:none}
.masthead{max-width:1080px;margin:0 auto;padding:22px 20px 0;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.masthead .tagline{color:var(--ink2);font-size:15px;font-weight:600}
.masthead .date{color:var(--muted);font-size:13px}
.container{max-width:1080px;margin:0 auto;padding:14px 20px 40px}
.section-title{font-size:15px;font-weight:800;color:var(--fg);margin:14px 0 18px;padding-bottom:10px;border-bottom:2px solid var(--fg);letter-spacing:1px}
.lead{display:grid;grid-template-columns:1.5fr 1fr;gap:26px;align-items:center;margin-bottom:30px;padding-bottom:30px;border-bottom:1px solid var(--line)}
.lead .cover{aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:var(--bg2);border:1px solid var(--line)}
.lead .cover img{width:100%;height:100%;object-fit:cover}
.lead .cat{color:var(--accent);font-weight:800;font-size:12px;letter-spacing:1px}
.lead h2{font-size:clamp(22px,3.2vw,31px);line-height:1.3;font-weight:900;margin:8px 0 12px}
.lead a:hover h2{color:var(--accent)}
.lead .excerpt{color:var(--ink2);font-size:15.5px;line-height:1.85}
.lead .pmeta{margin-top:14px;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:28px}
.card .cover{aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--bg2);border:1px solid var(--line)}
.card .cover img{width:100%;height:100%;object-fit:cover;transition:transform .35s ease}
.card:hover .cover img{transform:scale(1.04)}
.card .cat{color:var(--accent);font-weight:800;font-size:12px;letter-spacing:1px;margin:12px 0 4px;display:block}
.card h3{font-size:18px;line-height:1.5;font-weight:800;margin:2px 0 10px;color:var(--fg)}
.card:hover h3{color:var(--accent)}
.card .pmeta{color:var(--muted);font-size:13px}
.article-wrap{max-width:760px;margin:0 auto;padding:8px 20px 56px}
.kicker{color:var(--accent);font-weight:800;font-size:13px;letter-spacing:2px;margin-top:20px}
.post-title{font-size:clamp(27px,5vw,42px);line-height:1.26;font-weight:900;margin:10px 0 16px;letter-spacing:.5px;color:var(--fg)}
.byline{display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:14px;padding-bottom:18px;border-bottom:1px solid var(--line)}
.byline .pub{font-weight:800;color:var(--fg)}
.cover-fig{margin:26px 0}
.cover-fig img{width:100%;border-radius:12px;border:1px solid var(--line)}
.article{font-size:18px;line-height:2.05;color:var(--ink)}
.article h2{font-size:24px;font-weight:900;margin:38px 0 14px;padding-left:14px;border-left:4px solid var(--accent);color:var(--fg)}
.article h3{font-size:20px;font-weight:800;margin:28px 0 10px;color:var(--fg)}
.article p{margin:18px 0}
.article ul,.article ol{margin:16px 0;padding-left:24px}
.article li{margin:8px 0}
.article blockquote{margin:22px 0;padding:10px 18px;border-left:4px solid var(--accent);background:var(--bg2);color:var(--ink2);border-radius:0 8px 8px 0}
.article img{width:100%;border-radius:12px;margin:28px 0;border:1px solid var(--line)}
.article a{color:var(--link);border-bottom:1px solid rgba(26,86,219,.3)}
.article code{background:var(--bg2);border:1px solid var(--line);padding:2px 6px;border-radius:5px;font-size:.92em}
.article pre{background:#0d1117;color:#e6edf3;padding:14px;border-radius:10px;overflow:auto}
.article pre code{background:none;border:0;padding:0;color:inherit}
.src{margin-top:30px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
.back{display:inline-block;margin-top:26px;color:var(--accent);font-weight:700}
.pager{display:flex;gap:14px;justify-content:center;margin:38px 0 8px}
.pager a,.pager span{padding:9px 16px;border:1px solid var(--line);border-radius:8px;color:var(--ink2);font-weight:700}
.pager a:hover{border-color:var(--accent);color:var(--accent)}
.empty{text-align:center;color:var(--muted);padding:80px 16px}
.site-footer{border-top:1px solid var(--line);margin-top:44px;background:var(--bg2)}
.fwrap{max-width:1080px;margin:0 auto;padding:30px 20px;color:var(--muted);font-size:13px;text-align:center}
.fwrap .fbrand{font-weight:900;color:var(--fg);letter-spacing:1px}
.fwrap .note{margin-top:8px;font-size:12px;color:var(--muted);line-height:1.7}
@media(max-width:680px){.lead{grid-template-columns:1fr}}
`;

// Set the theme before paint to avoid a flash of the wrong colors.
const THEME_BOOT = `<script>(function(){try{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})();</script>`;
const THEME_TOGGLE = `<script>(function(){var b=document.getElementById('themeToggle');if(b)b.addEventListener('click',function(){var d=document.documentElement,n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('theme',n);}catch(e){}});})();</script>`;

// Brand favicon: red rounded tile + white "见" (matches the wordmark accent).
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5257"/><stop offset="1" stop-color="#c81e25"/></linearGradient></defs>
<rect x="3" y="3" width="58" height="58" rx="15" fill="url(#g)"/>
<rect x="3.75" y="3.75" width="56.5" height="56.5" rx="14.25" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="1.5"/>
<text x="32" y="35" text-anchor="middle" dominant-baseline="central" font-family="'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif" font-size="40" font-weight="800" fill="#ffffff">见</text>
</svg>`;

export function renderFavicon(): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=604800",
    },
  });
}

function brandMarkup(env: Env): string {
  const name = env.SITE_TITLE || "智见";
  const chars = [...name];
  const last = escHtml(chars.pop() ?? "");
  const rest = escHtml(chars.join(""));
  return `<span class="name">${rest}<b>${last}</b></span>`;
}

function layout(env: Env, title: string, body: string): string {
  const name = escHtml(env.SITE_TITLE || "智见");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${escHtml(env.SITE_DESC || "")}">
<title>${escHtml(title)}</title>
<link rel="alternate" type="application/rss+xml" href="/rss.xml" title="${name}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/favicon.svg">
${THEME_BOOT}
<style>${CSS}</style>
</head>
<body>
<div class="topbar"></div>
<header class="site-header">
  <div class="hwrap">
    <a class="brand" href="/">${brandMarkup(env)}<span class="en">INSIGHT</span></a>
    <nav class="nav"><a href="/">首页</a><a href="/rss.xml">订阅</a><button id="themeToggle" class="theme-toggle" type="button" aria-label="切换深浅色"><span class="ti-moon">🌙</span><span class="ti-sun">☀️</span></button></nav>
  </div>
</header>
${body}
<footer class="site-footer">
  <div class="fwrap">
    <div class="fbrand">${name}</div>
    <div class="note">${escHtml(env.SITE_DESC || "")}<br>&copy; ${new Date().getFullYear()} ${name}</div>
  </div>
</footer>
${THEME_TOGGLE}
</body>
</html>`;
}

function leadHtml(m: PostMeta): string {
  const cover = m.hasCover
    ? `<img src="/img/${encodeURIComponent(m.slug)}" alt="" loading="lazy">`
    : "";
  const excerpt = m.excerpt ? `<p class="excerpt">${escHtml(m.excerpt)}…</p>` : "";
  const href = `/post/${encodeURIComponent(m.slug)}`;
  return `<section class="lead">
  <a class="cover" href="${href}">${cover}</a>
  <div><a href="${href}"><span class="cat">${escHtml(categoryOf(m))}</span><h2>${escHtml(
    m.title,
  )}</h2></a>${excerpt}<div class="pmeta">${escHtml(m.date.slice(0, 10))}</div></div>
</section>`;
}

function cardHtml(m: PostMeta): string {
  const cover = m.hasCover
    ? `<div class="cover"><img src="/img/${encodeURIComponent(m.slug)}" alt="" loading="lazy"></div>`
    : `<div class="cover"></div>`;
  const href = `/post/${encodeURIComponent(m.slug)}`;
  return `<article class="card"><a href="${href}">${cover}<span class="cat">${escHtml(
    categoryOf(m),
  )}</span><h3>${escHtml(m.title)}</h3></a><div class="pmeta">${escHtml(m.date.slice(0, 10))}</div></article>`;
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
  const today = new Date().toISOString().slice(0, 10);

  const masthead =
    current === 1
      ? `<div class="masthead"><div class="tagline">${escHtml(
          env.SITE_DESC || "",
        )}</div><div class="date">${today}</div></div>`
      : "";

  let body: string;
  if (!slice.length) {
    body = `${masthead}<main class="container"><p class="empty">暂无报道，稍候将自动更新。</p></main>`;
  } else {
    const lead = current === 1 ? leadHtml(slice[0]) : "";
    const rest = current === 1 ? slice.slice(1) : slice;
    const grid = rest.length ? `<div class="grid">${rest.map(cardHtml).join("")}</div>` : "";
    body = `${masthead}<main class="container"><div class="section-title">最新报道</div>${lead}${grid}${pagerHtml(
      current,
      totalPages,
    )}</main>`;
  }

  return htmlResponse(layout(env, env.SITE_TITLE || "智见", body));
}

export async function renderPost(env: Env, slug: string): Promise<Response> {
  const post = await getPost(env, slug);
  if (!post) {
    return htmlResponse(
      layout(env, "404", `<main class="article-wrap"><p class="empty">未找到该文章。</p></main>`),
      404,
    );
  }

  const rendered = String(await marked.parse(stripLeadingH1(post.markdown)));
  const content = embedInlineImages(rendered, slug, post.inlineImages ?? 0);
  const cat = escHtml(categoryOf(post));
  const cover = post.hasCover
    ? `<figure class="cover-fig"><img src="/img/${encodeURIComponent(slug)}" alt=""></figure>`
    : "";
  const source = post.source?.url
    ? `<p class="src">信息来源:<a href="${escHtml(
        post.source.url,
      )}" rel="nofollow noopener" target="_blank">${escHtml(post.source.title)}</a></p>`
    : "";

  const body = `<main class="article-wrap">
  <div class="kicker">${cat}</div>
  <h1 class="post-title">${escHtml(post.title)}</h1>
  <div class="byline"><span class="pub">${escHtml(env.SITE_TITLE || "智见")} · AI 编辑部</span><span>${escHtml(
    post.date.slice(0, 10),
  )}</span></div>
  ${cover}
  <article class="article">${content}</article>
  ${source}
  <a class="back" href="/">&larr; 返回首页</a>
</main>`;

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
  const site = env.SITE_TITLE || "智见";
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
