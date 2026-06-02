import { marked } from "marked";
import { getImage, getIndex, getPost } from "./store";
import type { Env, Post, PostMeta } from "./types";

marked.setOptions({ gfm: true, breaks: false });

// Posts per page. Kept modest so the homepage stays tight and actually paginates
// at the current article volume (首页 = 1 篇头条 + 6 卡片，满了翻页).
const PER_PAGE = 7;

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

// Stable 32-bit hash so a post's "stats" never change between renders.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Stats {
  heat: number; // 0-100 trending score (recency-weighted)
  views: number;
  comments: number;
  readMins: number;
}

/**
 * Derive believable, *stable* engagement numbers for a post. Seeded from the
 * slug so they never jump around; heat additionally decays with age so the
 * "实时热榜" actually shifts over time.
 */
function postStats(m: PostMeta): Stats {
  const h = hashStr(m.slug);
  const ageH = Math.max(0, (Date.now() - Date.parse(m.date)) / 3.6e6);
  const recency = Math.max(0, 1 - ageH / 240); // fades over ~10 days
  const jitter = ((h >>> 9) % 1000) / 1000;
  const heat = Math.min(98, Math.max(34, Math.round(30 + recency * 30 + jitter * 38)));
  const views = 6400 + (h % 86000) + Math.round(recency * 34000);
  const comments = 16 + (h % 760);
  const chars = m.chars ?? Math.max(2200, (m.excerpt?.length ?? 80) * 42);
  const readMins = Math.max(3, Math.round(chars / 360));
  return { heat, views, comments, readMins };
}

function withCommas(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtCount(n: number): string {
  if (n >= 10000) {
    const v = n / 10000;
    return (v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "")) + "万";
  }
  return withCommas(n);
}

// Small flame glyph (inherits color via currentColor).
const FLAME = `<svg class="i-flame" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 2c1 3-1.4 4.6-3 6.7C7.4 10.8 7 12.4 7 14a5 5 0 0 0 10 0c0-2-.9-3.9-2.4-5.4C13 7 13 4 12 2Z"/></svg>`;

function heatMeter(heat: number): string {
  return `<span class="heatbar"><i style="width:${heat}%"></i></span><span class="heatval">${FLAME}${heat}</span>`;
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

// Escape text, then wrap occurrences of `q` (case-insensitive) in <mark>.
function highlight(text: string, q: string): string {
  const esc = escHtml(text);
  const eq = escHtml(q).trim();
  if (!eq) return esc;
  const re = new RegExp(eq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return esc.replace(re, (m) => `<mark>${m}</mark>`);
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

// Count CJK characters in markdown — fallback when a post predates the
// stored `chars` field (older posts would otherwise show 字数 0).
function countChars(md: string): number {
  const m = md.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

// Image cache-busting token. Images are served with a 1-year immutable cache,
// so regenerated pictures (same /img/<slug> URL) would otherwise stay stale in
// the browser forever. Appending ?v=<imgVer> changes the URL whenever images
// are (re)generated; older posts (no imgVer) fall back to their publish time so
// the URL still differs from the old no-version one and refreshes once.
function imgVerStr(m: { imgVer?: number; date: string }): string {
  const v = m.imgVer ?? Date.parse(m.date);
  return String(Number.isFinite(v) && v > 0 ? v : 1);
}

function coverSrc(m: PostMeta): string {
  return `/img/${encodeURIComponent(m.slug)}?v=${imgVerStr(m)}`;
}

function inlineImgTag(slug: string, i: number, ver: string): string {
  return `<img src="/img/${encodeURIComponent(slug)}?i=${i}&v=${ver}" alt="" loading="lazy">`;
}

function embedInlineImages(html: string, slug: string, count: number, ver: string): string {
  if (count <= 0) return html;
  const parts = html.split("</p>");
  if (parts.length <= 2) {
    let tail = "";
    for (let i = 1; i <= count; i++) tail += inlineImgTag(slug, i, ver);
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
        out += inlineImgTag(slug, placed, ver);
      }
    }
  }
  while (placed < count) {
    placed += 1;
    out += inlineImgTag(slug, placed, ver);
  }
  return out;
}

const CSS = `
:root{
  --bg:#ffffff;--bg2:#f6f7f9;--fg:#16181d;--ink:#222;--ink2:#374151;--muted:#6b7280;
  --line:#e6e8ec;--header:rgba(255,255,255,.92);--accent:#d7282f;--link:#1a56db;
  --chip:#eef0f3;--warm:#ff8a00;color-scheme:light;
}
:root[data-theme="dark"]{
  --bg:#0f1115;--bg2:#171a21;--fg:#eceef2;--ink:#d7dbe2;--ink2:#aab2bf;--muted:#8b94a3;
  --line:#262a33;--header:rgba(15,17,21,.9);--accent:#ff5a5f;--link:#7aa2ff;
  --chip:#1d212a;--warm:#ffab33;color-scheme:dark;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);transition:background .2s ease,color .2s ease;
  font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block}
.topbar{height:3px;background:var(--accent)}
.read-progress{position:fixed;top:0;left:0;height:3px;width:0;background:var(--accent);z-index:60;transition:width .08s linear}
.site-header{position:sticky;top:0;z-index:30;background:var(--header);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.hwrap{max-width:1240px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px}
.brand{display:flex;align-items:baseline;gap:9px}
.brand .name{font-size:25px;font-weight:900;letter-spacing:2px;color:var(--fg)}
.brand .name b{color:var(--accent)}
.brand .en{font-size:11px;color:var(--muted);letter-spacing:3px}
.hright{display:flex;align-items:center;gap:8px}
.search{display:flex;align-items:center;height:36px;background:var(--bg2);border:1px solid var(--line);border-radius:9px;overflow:hidden}
.search:focus-within{border-color:var(--accent)}
.search input{border:0;background:transparent;color:var(--fg);font:inherit;font-size:14px;padding:0 4px 0 12px;width:168px;outline:none}
.search input::placeholder{color:var(--muted)}
.search button{border:0;background:transparent;color:var(--muted);cursor:pointer;height:100%;padding:0 11px;display:inline-flex;align-items:center;font-size:15px}
.search button:hover{color:var(--accent)}
.nav{display:flex;align-items:center}
.nav a{color:var(--ink2);margin-left:20px;font-size:14.5px;font-weight:600}
.nav a:hover{color:var(--accent)}
.theme-toggle{margin-left:18px;width:36px;height:36px;border:1px solid var(--line);background:transparent;color:var(--fg);
  border-radius:9px;cursor:pointer;font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.theme-toggle:hover{border-color:var(--accent)}
.theme-toggle .ti-sun{display:none}
.theme-toggle .ti-moon{display:inline}
:root[data-theme="dark"] .theme-toggle .ti-sun{display:inline}
:root[data-theme="dark"] .theme-toggle .ti-moon{display:none}
.masthead{max-width:1240px;margin:0 auto;padding:22px 24px 0;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.masthead .tagline{color:var(--ink2);font-size:15px;font-weight:600}
.masthead .date{color:var(--muted);font-size:13px}

/* ---- three-column layout ---- */
.layout{max-width:1240px;margin:0 auto;padding:14px 24px 40px;display:grid;grid-template-columns:200px minmax(0,1fr) 300px;gap:32px;align-items:start}
.rail{position:sticky;top:74px;display:flex;flex-direction:column;gap:22px}
.main-col{min-width:0}
.container{max-width:1240px;margin:0 auto;padding:14px 24px 40px}

/* ---- sidebar widgets ---- */
.widget{border:1px solid var(--line);border-radius:12px;background:var(--bg);overflow:hidden}
.widget>h4{margin:0;padding:12px 15px;font-size:13.5px;font-weight:800;letter-spacing:1px;color:var(--fg);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
.widget>h4::before{content:"";width:3px;height:14px;background:var(--accent);border-radius:2px}
.widget .wbody{padding:13px 15px}
.catnav a{display:flex;justify-content:space-between;align-items:center;padding:10px 15px;font-size:14px;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--line)}
.catnav a:last-child{border-bottom:0}
.catnav a:hover{color:var(--accent);background:var(--bg2)}
.catnav a.on{color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.catnav .count{font-size:12px;color:var(--muted);font-weight:700;background:var(--chip);padding:1px 8px;border-radius:10px}
.ov{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}
.ov div{background:var(--bg);padding:14px 6px;text-align:center}
.ov b{display:block;font-size:21px;font-weight:900;color:var(--fg);line-height:1.2}
.ov span{font-size:12px;color:var(--muted)}
.rank{list-style:none;margin:0;padding:0}
.rank li{padding:11px 15px;border-bottom:1px solid var(--line)}
.rank li:last-child{border-bottom:0}
.rank a{display:grid;grid-template-columns:20px 1fr;gap:11px;align-items:start}
.rank .n{font-size:15px;font-weight:900;font-style:italic;color:var(--muted);text-align:center}
.rank li:nth-child(1) .n,.rank li:nth-child(2) .n,.rank li:nth-child(3) .n{color:var(--accent)}
.rank .t{font-size:13.5px;line-height:1.55;font-weight:600;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rank a:hover .t{color:var(--accent)}
.rank .hb{grid-column:2;margin-top:7px;display:flex;align-items:center;gap:7px}
.heatbar{flex:1;height:4px;border-radius:3px;background:var(--chip);overflow:hidden}
.heatbar>i{display:block;height:100%;background:linear-gradient(90deg,var(--warm),var(--accent))}
.heatval{font-size:11px;font-weight:800;color:var(--accent);display:inline-flex;align-items:center;gap:2px;white-space:nowrap}
.i-flame{fill:currentColor;flex:none}
.minilist a{display:grid;grid-template-columns:66px 1fr;gap:11px;align-items:center;padding:11px 15px;border-bottom:1px solid var(--line)}
.minilist a:last-child{border-bottom:0}
.minilist a.notrim{grid-template-columns:1fr}
.minilist .mt{aspect-ratio:16/10;border-radius:7px;overflow:hidden;background:var(--bg2);border:1px solid var(--line)}
.minilist .mt img{width:100%;height:100%;object-fit:cover}
.minilist .mx{font-size:13px;line-height:1.5;font-weight:600;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.minilist a:hover .mx{color:var(--accent)}
.minilist .md{font-size:11.5px;color:var(--muted);margin-top:4px}
.about{font-size:13px;line-height:1.85;color:var(--ink2)}
.about .meta{margin-top:9px;color:var(--muted);font-size:12px}
.share{display:flex;flex-direction:column;gap:8px}
.share a,.share button{font:inherit;font-size:13px;font-weight:700;color:var(--ink2);border:1px solid var(--line);background:var(--bg);border-radius:9px;padding:9px 12px;cursor:pointer;text-align:center;display:block;width:100%}
.share a:hover,.share button:hover{border-color:var(--accent);color:var(--accent)}
.sharegrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.sbtn{font:inherit;font-size:13px;font-weight:700;color:var(--ink2);border:1px solid var(--line);background:var(--bg);border-radius:9px;padding:9px 8px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px}
.sbtn::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--c,var(--muted))}
.sbtn:hover{border-color:var(--c,var(--accent));color:var(--c,var(--accent))}
.sbtn.wb{--c:#e6162d}.sbtn.wx{--c:#07c160}.sbtn.zh{--c:#0a6cff}.sbtn.xhs{--c:#ff2442}
.toast{position:fixed;left:50%;bottom:38px;transform:translateX(-50%) translateY(20px);background:var(--fg);color:var(--bg);font-size:13.5px;font-weight:700;padding:11px 20px;border-radius:10px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;z-index:80;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.modal[hidden]{display:none}
.modal{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:20px}
.modal-bg{position:absolute;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(2px)}
.modal-card{position:relative;background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:24px;text-align:center;max-width:300px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.modal-card h4{margin:0 0 14px;font-size:15px;color:var(--fg)}
.modal-card .wxqr{width:200px;height:200px;border-radius:10px;border:1px solid var(--line);background:#fff;margin:0 auto;display:block}
.modal-x{position:absolute;top:10px;right:12px;border:0;background:transparent;color:var(--muted);font-size:22px;line-height:1;cursor:pointer}
.modal-x:hover{color:var(--accent)}
.adata{display:flex;flex-direction:column;gap:11px;font-size:13px}
.adata .row{display:flex;justify-content:space-between;align-items:center;color:var(--muted)}
.adata .row b{color:var(--fg);font-weight:800}
.adata .row .hot{color:var(--accent)}
.adata .heatbar{width:80px;flex:none}

/* ---- stat chips on cards / lead ---- */
.stats{display:flex;flex-wrap:wrap;gap:9px;align-items:center;color:var(--muted);font-size:12.5px;margin-top:9px}
.stats .sep{color:var(--line)}
.stats .hot{color:var(--accent);font-weight:800;display:inline-flex;align-items:center;gap:3px}

/* ---- feed ---- */
.section-title{display:flex;align-items:center;justify-content:space-between;font-size:15px;font-weight:800;color:var(--fg);margin:6px 0 18px;padding-bottom:10px;border-bottom:2px solid var(--fg);letter-spacing:1px}
.section-title .live{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:0}
.section-title .live i{width:7px;height:7px;border-radius:50%;background:#16a34a;box-shadow:0 0 0 0 rgba(22,163,74,.5);animation:pulse 1.8s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(22,163,74,.5)}70%{box-shadow:0 0 0 7px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}
.lead{display:grid;grid-template-columns:1.45fr 1fr;gap:26px;align-items:center;margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid var(--line)}
.lead .cover{aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:var(--bg2);border:1px solid var(--line)}
.lead .cover img{width:100%;height:100%;object-fit:cover}
.lead .cat{color:var(--accent);font-weight:800;font-size:12px;letter-spacing:1px}
.lead h2{font-size:clamp(22px,2.6vw,29px);line-height:1.3;font-weight:900;margin:8px 0 12px}
.lead a:hover h2{color:var(--accent)}
.lead .excerpt{color:var(--ink2);font-size:15px;line-height:1.85}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:26px}
.card .cover{aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--bg2);border:1px solid var(--line)}
.card .cover img{width:100%;height:100%;object-fit:cover;transition:transform .35s ease}
.card:hover .cover img{transform:scale(1.04)}
.card .cat{color:var(--accent);font-weight:800;font-size:12px;letter-spacing:1px;margin:12px 0 4px;display:block}
.card h3{font-size:17.5px;line-height:1.5;font-weight:800;margin:2px 0 6px;color:var(--fg)}
.card:hover h3{color:var(--accent)}

/* ---- article ---- */
.kicker{color:var(--accent);font-weight:800;font-size:13px;letter-spacing:2px}
.post-title{font-size:clamp(26px,3.6vw,38px);line-height:1.28;font-weight:900;margin:10px 0 16px;letter-spacing:.5px;color:var(--fg)}
.byline{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:14px;padding-bottom:18px;border-bottom:1px solid var(--line)}
.byline .pub{font-weight:800;color:var(--fg)}
.byline .sep{color:var(--line)}
.byline .hot{color:var(--accent);font-weight:800;display:inline-flex;align-items:center;gap:3px}
.cover-fig{margin:24px 0}
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
.fwrap{max-width:1240px;margin:0 auto;padding:30px 24px;color:var(--muted);font-size:13px;text-align:center}
.fwrap .fbrand{font-weight:900;color:var(--fg);letter-spacing:1px}
.fwrap .note{margin-top:8px;font-size:12px;color:var(--muted);line-height:1.7}

@media(max-width:1080px){
  .layout{grid-template-columns:1fr}
  .rail-left,.rail-right{display:none}
}
@media(max-width:680px){.lead{grid-template-columns:1fr}}
@media(max-width:560px){
  .search input{width:110px}
  .nav a{display:none}
}
.searchbox{margin:6px 0 4px}
.searchbox .hint{color:var(--muted);font-size:13.5px;margin-top:4px}
mark{background:rgba(215,40,47,.16);color:inherit;border-radius:3px;padding:0 2px}
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

// Search icon (magnifier).
const ICON_SEARCH = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>`;

function searchForm(q = ""): string {
  return `<form class="search" action="/search" method="get" role="search"><input name="q" type="search" placeholder="搜索报道…" value="${escHtml(
    q,
  )}" autocomplete="off" aria-label="搜索报道"><button type="submit" aria-label="搜索">${ICON_SEARCH}</button></form>`;
}

function layout(env: Env, title: string, body: string, q = ""): string {
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
    <div class="hright">
      ${searchForm(q)}
      <nav class="nav"><a href="/">首页</a><a href="/rss.xml">订阅</a><button id="themeToggle" class="theme-toggle" type="button" aria-label="切换深浅色"><span class="ti-moon">🌙</span><span class="ti-sun">☀️</span></button></nav>
    </div>
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

// Compact stat row shown on cards/lead: date · 阅读 · 热度.
function statsRow(m: PostMeta): string {
  const s = postStats(m);
  return `<div class="stats"><span>${escHtml(m.date.slice(0, 10))}</span><span class="sep">|</span><span>阅读 ${fmtCount(
    s.views,
  )}</span><span class="sep">|</span><span class="hot">${FLAME}${s.heat}</span></div>`;
}

function leadHtml(m: PostMeta): string {
  const cover = m.hasCover ? `<img src="${coverSrc(m)}" alt="" loading="lazy">` : "";
  const excerpt = m.excerpt ? `<p class="excerpt">${escHtml(m.excerpt)}…</p>` : "";
  const href = `/post/${encodeURIComponent(m.slug)}`;
  return `<section class="lead">
  <a class="cover" href="${href}">${cover}</a>
  <div><a href="${href}"><span class="cat">${escHtml(categoryOf(m))}</span><h2>${escHtml(
    m.title,
  )}</h2></a>${excerpt}${statsRow(m)}</div>
</section>`;
}

function cardHtml(m: PostMeta, q = ""): string {
  const cover = m.hasCover
    ? `<div class="cover"><img src="${coverSrc(m)}" alt="" loading="lazy"></div>`
    : `<div class="cover"></div>`;
  const href = `/post/${encodeURIComponent(m.slug)}`;
  const title = q ? highlight(m.title, q) : escHtml(m.title);
  return `<article class="card"><a href="${href}">${cover}<span class="cat">${escHtml(
    categoryOf(m),
  )}</span><h3>${title}</h3></a>${statsRow(m)}</article>`;
}

// ---- sidebar widgets ----

function widget(title: string, inner: string, padded = false): string {
  const body = padded ? `<div class="wbody">${inner}</div>` : inner;
  return `<section class="widget"><h4>${escHtml(title)}</h4>${body}</section>`;
}

// Category navigation with per-category counts; `active` highlights one.
function catNavWidget(index: PostMeta[], active?: string): string {
  const counts = new Map<string, number>();
  for (const m of index) {
    const c = categoryOf(m);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const rows = [
    `<a class="${active ? "" : "on"}" href="/">全部<span class="count">${index.length}</span></a>`,
    ...sorted.map(
      ([c, n]) =>
        `<a class="${active === c ? "on" : ""}" href="/?cat=${encodeURIComponent(
          c,
        )}">${escHtml(c)}<span class="count">${n}</span></a>`,
    ),
  ].join("");
  return `<section class="widget"><h4>栏目</h4><nav class="catnav">${rows}</nav></section>`;
}

function overviewWidget(index: PostMeta[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const todayN = index.filter((m) => m.date.slice(0, 10) === today).length;
  const cats = new Set(index.map(categoryOf)).size;
  const totalViews = index.reduce((a, m) => a + postStats(m).views, 0);
  const cell = (v: string | number, label: string) => `<div><b>${v}</b><span>${label}</span></div>`;
  return `<section class="widget"><h4>数据概览</h4><div class="ov">${cell(
    index.length,
    "累计报道",
  )}${cell(todayN, "今日更新")}${cell(cats, "栏目")}${cell(fmtCount(totalViews), "总阅读")}</div></section>`;
}

// "实时热榜": top posts by heat, numbered, with a heat meter.
function hotRankWidget(index: PostMeta[], excludeSlug?: string, n = 5): string {
  const ranked = index
    .filter((m) => m.slug !== excludeSlug)
    .map((m) => ({ m, s: postStats(m) }))
    .sort((a, b) => b.s.heat - a.s.heat || b.s.views - a.s.views)
    .slice(0, n);
  if (!ranked.length) return "";
  const items = ranked
    .map(
      ({ m, s }, i) =>
        `<li><a href="/post/${encodeURIComponent(m.slug)}"><span class="n">${i + 1}</span><span class="t">${escHtml(
          m.title,
        )}</span><span class="hb">${heatMeter(s.heat)}</span></a></li>`,
    )
    .join("");
  return `<section class="widget"><h4>实时热榜</h4><ol class="rank">${items}</ol></section>`;
}

// Compact list with optional thumbnails — used for "相关阅读".
function miniListWidget(title: string, items: PostMeta[]): string {
  if (!items.length) return "";
  const rows = items
    .map((m) => {
      const href = `/post/${encodeURIComponent(m.slug)}`;
      const s = postStats(m);
      const thumb = m.hasCover
        ? `<span class="mt"><img src="${coverSrc(m)}" alt="" loading="lazy"></span>`
        : "";
      return `<a class="${m.hasCover ? "" : "notrim"}" href="${href}">${thumb}<span><span class="mx">${escHtml(
        m.title,
      )}</span><span class="md">${escHtml(categoryOf(m))} · 阅读 ${fmtCount(s.views)}</span></span></a>`;
    })
    .join("");
  return `<section class="widget"><h4>${escHtml(title)}</h4><div class="minilist">${rows}</div></section>`;
}

function aboutWidget(env: Env): string {
  const name = escHtml(env.SITE_TITLE || "智见");
  const desc = escHtml(env.SITE_DESC || "");
  return `<section class="widget"><h4>关于${name}</h4><div class="wbody"><div class="about">${desc}。汇聚全网热点，提供独立观察与深度解读。<div class="meta"><a href="/rss.xml" style="color:var(--link)">RSS 订阅</a> · <a href="/sitemap.xml" style="color:var(--link)">网站地图</a></div></div></div></section>`;
}

function pagerHtml(page: number, total: number, href: (p: number) => string): string {
  if (total <= 1) return "";
  const prev = page > 1 ? `<a href="${href(page - 1)}">&larr; 上一页</a>` : "";
  const next = page < total ? `<a href="${href(page + 1)}">下一页 &rarr;</a>` : "";
  return `<nav class="pager">${prev}<span>${page} / ${total}</span>${next}</nav>`;
}

export async function renderHome(env: Env, page = 1, cat?: string): Promise<Response> {
  const index = await getIndex(env);
  const filtered = cat ? index.filter((m) => categoryOf(m) === cat) : index;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * PER_PAGE;
  const slice = filtered.slice(start, start + PER_PAGE);
  const today = new Date().toISOString().slice(0, 10);
  const firstView = current === 1 && !cat;

  const masthead = firstView
    ? `<div class="masthead"><div class="tagline">${escHtml(
        env.SITE_DESC || "",
      )}</div><div class="date">${today}</div></div>`
    : "";

  const heading = cat ? `栏目 · ${escHtml(cat)}` : "最新报道";
  const live = `<span class="live"><i></i>实时更新</span>`;

  let center: string;
  if (!slice.length) {
    center = `<div class="section-title">${heading}${live}</div><p class="empty">${
      cat ? "该栏目暂无报道。" : "暂无报道，敬请期待后续内容。"
    }</p>`;
  } else {
    const lead = firstView ? leadHtml(slice[0]) : "";
    const rest = firstView ? slice.slice(1) : slice;
    const grid = rest.length ? `<div class="grid">${rest.map((m) => cardHtml(m)).join("")}</div>` : "";
    const catQs = cat ? `&cat=${encodeURIComponent(cat)}` : "";
    center = `<div class="section-title">${heading}${live}</div>${lead}${grid}${pagerHtml(
      current,
      totalPages,
      (p) => `/?page=${p}${catQs}`,
    )}`;
  }

  const railLeft = `<aside class="rail rail-left">${catNavWidget(index, cat)}${overviewWidget(
    index,
  )}</aside>`;
  const railRight = `<aside class="rail rail-right">${hotRankWidget(index)}${aboutWidget(
    env,
  )}</aside>`;

  const body = `${masthead}<div class="layout">${railLeft}<main class="main-col">${center}</main>${railRight}</div>`;
  const title = cat ? `${cat} · ${env.SITE_TITLE || "智见"}` : env.SITE_TITLE || "智见";
  return htmlResponse(layout(env, title, body));
}

export async function renderSearch(env: Env, query: string, page = 1): Promise<Response> {
  const index = await getIndex(env);
  const q = (query || "").trim().slice(0, 60);
  const ql = q.toLowerCase();
  const results = q
    ? index.filter(
        (m) =>
          m.title.toLowerCase().includes(ql) ||
          (m.excerpt ?? "").toLowerCase().includes(ql) ||
          categoryOf(m).includes(q),
      )
    : [];

  const totalPages = Math.max(1, Math.ceil(results.length / PER_PAGE));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * PER_PAGE;
  const slice = results.slice(start, start + PER_PAGE);

  let center: string;
  if (!q) {
    center = `<div class="section-title">站内搜索</div><div class="searchbox">${searchForm(
      "",
    )}<div class="hint">输入关键词，检索报道标题、栏目与摘要。</div></div>`;
  } else if (!results.length) {
    center = `<div class="section-title">搜索 · “${escHtml(
      q,
    )}”</div><p class="empty">未找到与“${escHtml(q)}”相关的报道，换个关键词再试试。</p>`;
  } else {
    const grid = `<div class="grid">${slice.map((m) => cardHtml(m, q)).join("")}</div>`;
    center = `<div class="section-title">搜索 · “${escHtml(
      q,
    )}”<span class="live">共 ${results.length} 条结果</span></div>${grid}${pagerHtml(
      current,
      totalPages,
      (p) => `/search?q=${encodeURIComponent(q)}&page=${p}`,
    )}`;
  }

  const railLeft = `<aside class="rail rail-left">${catNavWidget(index)}${overviewWidget(
    index,
  )}</aside>`;
  const railRight = `<aside class="rail rail-right">${hotRankWidget(index)}${aboutWidget(
    env,
  )}</aside>`;
  const body = `<div class="layout">${railLeft}<main class="main-col">${center}</main>${railRight}</div>`;
  const title = q
    ? `搜索“${q}” · ${env.SITE_TITLE || "智见"}`
    : `站内搜索 · ${env.SITE_TITLE || "智见"}`;
  return htmlResponse(layout(env, title, body, q));
}

// Left rail on the article: per-article data card + share buttons.
function articleSidebarLeft(post: Post): string {
  const s = postStats(post);
  const dataCard = `<section class="widget"><h4>本文数据</h4><div class="wbody"><div class="adata">
    <div class="row"><span>热度</span><span style="display:flex;align-items:center;gap:7px">${heatMeter(
      s.heat,
    )}</span></div>
    <div class="row"><span>阅读量</span><b>${fmtCount(s.views)}</b></div>
    <div class="row"><span>评论</span><b>${fmtCount(s.comments)}</b></div>
    <div class="row"><span>字数</span><b>${withCommas(post.chars ?? 0)}</b></div>
    <div class="row"><span>阅读时长</span><b>${s.readMins} 分钟</b></div>
  </div></div></section>`;
  const share = `<section class="widget"><h4>分享</h4><div class="wbody">
    <div class="sharegrid">
      <a id="shWeibo" class="sbtn wb" href="#" rel="nofollow noopener" target="_blank">微博</a>
      <button id="shWechat" class="sbtn wx" type="button">微信</button>
      <button id="shZhihu" class="sbtn zh" type="button">知乎</button>
      <button id="shXhs" class="sbtn xhs" type="button">小红书</button>
    </div>
    <div class="share">
      <button id="shCopy" type="button">复制链接</button>
      <button id="shTop" type="button">回到顶部</button>
    </div>
  </div></section>`;
  return `<aside class="rail rail-left">${dataCard}${share}</aside>`;
}

const ARTICLE_SCRIPT = `<script>(function(){
  var bar=document.getElementById('rp');
  function up(){if(!bar)return;var h=document.documentElement,m=h.scrollHeight-h.clientHeight;bar.style.width=(m>0?(h.scrollTop/m*100):0)+'%';}
  addEventListener('scroll',up,{passive:true});up();
  var toastEl=document.getElementById('toast'),tmr;
  function toast(msg){if(!toastEl)return;toastEl.textContent=msg;toastEl.classList.add('show');clearTimeout(tmr);tmr=setTimeout(function(){toastEl.classList.remove('show');},2200);}
  function copy(){return navigator.clipboard?navigator.clipboard.writeText(location.href):Promise.reject();}
  var U=encodeURIComponent(location.href),T=encodeURIComponent(document.title);
  var w=document.getElementById('shWeibo');if(w)w.href='https://service.weibo.com/share/share.php?url='+U+'&title='+T;
  function on(id,fn){var e=document.getElementById(id);if(e)e.addEventListener('click',fn);}
  var modal=document.getElementById('wxModal'),qr=document.getElementById('wxQr');
  function closeWx(){if(modal)modal.hidden=true;}
  on('shWechat',function(){if(qr)qr.src='/qr?d='+U;if(modal)modal.hidden=false;});
  on('wxClose',closeWx);var bg=document.querySelector('#wxModal .modal-bg');if(bg)bg.addEventListener('click',closeWx);
  addEventListener('keydown',function(e){if(e.key==='Escape')closeWx();});
  on('shZhihu',function(){window.open('https://www.zhihu.com/','_blank');copy().then(function(){toast('链接已复制，去知乎粘贴分享');}).catch(function(){});});
  on('shXhs',function(){window.open('https://www.xiaohongshu.com/','_blank');copy().then(function(){toast('链接已复制，去小红书粘贴分享');}).catch(function(){});});
  on('shCopy',function(){copy().then(function(){toast('链接已复制到剪贴板');}).catch(function(){prompt('复制本文链接',location.href);});});
  on('shTop',function(){scrollTo({top:0,behavior:'smooth'});});
})();</script>`;

const SHARE_MODAL = `<div id="wxModal" class="modal" hidden><div class="modal-bg"></div><div class="modal-card"><button class="modal-x" id="wxClose" type="button" aria-label="关闭">&times;</button><h4>微信扫一扫，分享给好友</h4><img id="wxQr" class="wxqr" alt="二维码" width="200" height="200"><p class="note" style="margin:12px 0 0;color:var(--muted);font-size:12.5px">打开微信「扫一扫」即可分享本文</p></div></div><div id="toast" class="toast" role="status" aria-live="polite"></div>`;

export async function renderPost(env: Env, slug: string): Promise<Response> {
  const [post, index] = await Promise.all([getPost(env, slug), getIndex(env)]);
  if (!post) {
    return htmlResponse(
      layout(
        env,
        "404",
        `<div class="layout"><main class="main-col"><p class="empty">未找到该文章。</p></main></div>`,
      ),
      404,
    );
  }

  // Backfill char count for posts saved before the field existed.
  const chars = post.chars && post.chars > 0 ? post.chars : countChars(post.markdown);
  const fixed: Post = { ...post, chars };
  const ver = imgVerStr(fixed);
  const rendered = String(await marked.parse(stripLeadingH1(post.markdown)));
  const content = embedInlineImages(rendered, slug, post.inlineImages ?? 0, ver);
  const cat = categoryOf(post);
  const s = postStats(fixed);
  const cover = post.hasCover
    ? `<figure class="cover-fig"><img src="/img/${encodeURIComponent(slug)}?v=${ver}" alt=""></figure>`
    : "";

  // Related: same category first, then fill with latest.
  const sameCat = index.filter((m) => m.slug !== slug && categoryOf(m) === cat);
  const fill = index.filter((m) => m.slug !== slug && categoryOf(m) !== cat);
  const related = [...sameCat, ...fill].slice(0, 5);

  const main = `<main class="main-col">
  <div class="kicker">${escHtml(cat)}</div>
  <h1 class="post-title">${escHtml(post.title)}</h1>
  <div class="byline"><span class="pub">${escHtml(
    env.SITE_TITLE || "智见",
  )} · 编辑部</span><span class="sep">|</span><span>${escHtml(
    post.date.slice(0, 16).replace("T", " "),
  )}</span><span class="sep">|</span><span>阅读 ${s.readMins} 分钟</span><span class="sep">|</span><span class="hot">${FLAME}热度 ${
    s.heat
  }</span></div>
  ${cover}
  <article class="article">${content}</article>
  <a class="back" href="/">&larr; 返回首页</a>
</main>`;

  const railRight = `<aside class="rail rail-right">${hotRankWidget(index, slug)}${miniListWidget(
    "相关阅读",
    related,
  )}</aside>`;

  const body = `<div class="read-progress" id="rp"></div><div class="layout">${articleSidebarLeft(
    fixed,
  )}${main}${railRight}</div>${SHARE_MODAL}${ARTICLE_SCRIPT}`;

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
