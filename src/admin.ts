import {
  adminUser,
  checkCredentials,
  clearCookie,
  makeSession,
  sessionCookie,
  siteKey,
  verifyTurnstile,
} from "./auth";
import { getConfig, saveConfig, type GenConfig } from "./config";
import { deletePost, getIndex, getPost, getRejections, updatePost } from "./store";
import type { Env } from "./types";

// Curated Workers AI model ids offered as quick-switch suggestions.
// Verified available on this account (/ai/models/search). Cheapest-first;
// the 70B is highest quality but heavy on the free 10k-neuron/day allocation.
const CF_TEXT_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
];
const CF_IMAGE_MODELS = [
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "@cf/bytedance/stable-diffusion-xl-lightning",
  "@cf/lykon/dreamshaper-8-lcm",
];

function countCjk(s: string): number {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ADMIN_CSS = `
:root{--bg:#f3f4f6;--card:#fff;--fg:#16181d;--ink2:#374151;--muted:#6b7280;--line:#e3e6ea;--accent:#d7282f;--ok:#16a34a;color-scheme:light}
:root[data-theme="dark"]{--bg:#0c0e12;--card:#161922;--fg:#eceef2;--ink2:#aab2bf;--muted:#8b94a3;--line:#262b35;--accent:#ff5a5f;--ok:#34d058;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
.wrap{max-width:760px;margin:0 auto;padding:28px 20px 60px}
.brand{display:flex;align-items:center;gap:10px;font-weight:900;font-size:20px;letter-spacing:1px}
.brand b{color:var(--accent)}
.brand .tag{font-size:12px;font-weight:700;color:var(--muted);letter-spacing:2px;border:1px solid var(--line);padding:2px 8px;border-radius:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-top:20px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.card h2{margin:0 0 4px;font-size:17px}
.card .desc{color:var(--muted);font-size:13px;margin-bottom:16px}
label{display:block;font-size:13px;font-weight:700;color:var(--ink2);margin:14px 0 6px}
label .hint{font-weight:400;color:var(--muted);margin-left:6px}
input,select,textarea{width:100%;font:inherit;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:10px 12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
textarea{min-height:420px;line-height:1.7;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-weight:800;font-size:14px;border:0;border-radius:10px;padding:11px 18px;cursor:pointer;background:var(--accent);color:#fff}
.btn:hover{filter:brightness(1.05)}
.btn.ghost{background:transparent;color:var(--ink2);border:1px solid var(--line)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent)}
.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:22px}
.note{font-size:12.5px;color:var(--muted)}
.flash{padding:10px 14px;border-radius:9px;font-size:13.5px;font-weight:700;margin-bottom:4px}
.flash.ok{background:rgba(22,163,74,.12);color:var(--ok)}
.flash.err{background:rgba(215,40,47,.12);color:var(--accent)}
.stat{display:flex;gap:22px;flex-wrap:wrap;color:var(--muted);font-size:13px}
.stat b{color:var(--fg);font-size:18px;display:block}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login .card{width:100%;max-width:380px;margin:0}
.center{text-align:center}
.muted-link{color:var(--muted);font-size:12.5px}
.cf-turnstile{margin:16px 0 4px}
.postlist{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.prow{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}
.prow:last-child{border-bottom:0}
.prow .pt{flex:1;min-width:0;font-weight:700;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prow .pt:hover{color:var(--accent)}
.prow .pd{color:var(--muted);font-size:12px;white-space:nowrap}
.prow form{margin:0}
.mini{font:inherit;font-size:12.5px;font-weight:700;border:1px solid var(--line);background:var(--bg);color:var(--ink2);border-radius:7px;padding:5px 11px;cursor:pointer;white-space:nowrap}
.mini:hover{border-color:var(--accent);color:var(--accent)}
.mini.del:hover{border-color:var(--accent);color:#fff;background:var(--accent)}
.rv{font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;white-space:nowrap}
.rv.ok{background:rgba(22,163,74,.14);color:var(--ok)}
.rv.no{background:rgba(215,40,47,.14);color:var(--accent)}
.rv.na{background:var(--bg);color:var(--muted);border:1px solid var(--line)}
.review{margin:0 0 4px;padding:14px 16px;border-radius:10px;border:1px solid var(--line);background:var(--bg)}
.review h3{margin:0 0 8px;font-size:14px;display:flex;align-items:center;gap:8px}
.review ul{margin:8px 0 0;padding-left:18px}
.review li{margin:3px 0;color:var(--ink2);font-size:13px}
.review .sg{margin-top:8px;font-size:13px;color:var(--muted)}
.rejlist{display:flex;flex-direction:column;gap:10px}
.rj{border:1px solid var(--line);border-radius:10px;padding:11px 13px;background:var(--bg)}
.rj-h{display:flex;align-items:center;gap:10px}
.rj-t{flex:1;min-width:0;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rj-p{margin-top:7px;font-size:12.5px;color:var(--ink2);line-height:1.7}
.rj-s{margin-top:6px;font-size:12.5px;color:var(--muted)}
.more-link{display:inline-block;margin-top:12px;font-size:13px;color:var(--muted)}
`;

const THEME_BOOT = `<script>(function(){try{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})();</script>`;

function shell(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${THEME_BOOT}<style>${ADMIN_CSS}</style>${head}</head><body>${body}</body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { Location: location };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 302, headers });
}

// 3-state reviewer verdict badge for list views (shows the score when known).
function reviewBadge(pass: boolean | null | undefined, score?: number): string {
  const s = typeof score === "number" ? `${score} 分` : "";
  if (pass === true) return `<span class="rv ok">${s || "通过"}</span>`;
  if (pass === false) return `<span class="rv no">${s || "未过"}</span>`;
  return `<span class="rv na" title="审稿未完成（出错/未运行/无法解析）">未审</span>`;
}

// ---- login ----

export function renderLogin(env: Env, error?: string): Response {
  const flash = error ? `<div class="flash err">${esc(error)}</div>` : "";
  const body = `<div class="login"><form class="card" method="post" action="/admin/login">
  <div class="brand center" style="justify-content:center">${esc(
    env.SITE_TITLE || "智见",
  )}<span class="tag">CONSOLE</span></div>
  <p class="desc center">后台管理 · 请登录</p>
  ${flash}
  <label>账号</label>
  <input name="username" autocomplete="username" placeholder="用户名" required>
  <label>密码</label>
  <input name="password" type="password" autocomplete="current-password" placeholder="密码" required>
  <div class="cf-turnstile" data-sitekey="${esc(siteKey(env))}" data-theme="auto"></div>
  <div class="actions"><button class="btn" type="submit" style="width:100%">登 录</button></div>
  <p class="center" style="margin:14px 0 0"><a class="muted-link" href="/">← 返回网站首页</a></p>
</form></div>`;
  return html(
    shell(
      "登录 · 后台管理",
      body,
      `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`,
    ),
  );
}

export async function handleLogin(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const user = String(form.get("username") || "");
  const pass = String(form.get("password") || "");
  const token = String(form.get("cf-turnstile-response") || "");
  const ip = request.headers.get("cf-connecting-ip");

  if (!(await verifyTurnstile(env, token, ip))) {
    return renderLogin(env, "人机验证未通过，请重试。");
  }
  if (!checkCredentials(env, user, pass)) {
    return renderLogin(env, "账号或密码错误。");
  }
  return redirect("/admin", sessionCookie(await makeSession(env)));
}

export function handleLogout(): Response {
  return redirect("/admin/login", clearCookie());
}

// ---- dashboard ----

function textField(
  name: string,
  label: string,
  value: string,
  hint = "",
  type = "text",
  placeholder = "",
  list = "",
): string {
  const attrs =
    (type === "password" ? ' autocomplete="off"' : "") + (list ? ` list="${list}"` : "");
  return `<label>${esc(label)}${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</label>
<input name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}"${attrs}>`;
}

export async function renderDashboard(env: Env, request: Request): Promise<Response> {
  const cfg = await getConfig(env);
  const index = await getIndex(env);
  const rejections = await getRejections(env);
  const url = new URL(request.url);
  const flag = (k: string) => url.searchParams.get(k) === "1";
  const flash = flag("saved")
    ? `<div class="flash ok">配置已保存，将在下次生成时生效。</div>`
    : url.searchParams.get("gen") === "ok"
      ? `<div class="flash ok">已触发生成，文章稍后出现在首页。</div>`
      : url.searchParams.get("gen") === "err"
        ? `<div class="flash err">生成失败，请检查模型配置或查看日志。</div>`
        : flag("deleted")
          ? `<div class="flash ok">文章已删除。</div>`
          : "";

  const recent = index.slice(0, 40);
  const postRows = recent
    .map((m) => {
      const slug = encodeURIComponent(m.slug);
      return `<div class="prow"><a class="pt" href="/post/${slug}" target="_blank">${esc(
        m.title,
      )}</a>${reviewBadge(m.reviewPass, m.reviewScore)}<span class="pd">${esc(
        m.date.slice(0, 10),
      )}</span><a class="mini" href="/admin/edit?slug=${slug}">编辑</a><form method="post" action="/admin/delete" onsubmit="return confirm('确定删除这篇文章？删除后不可恢复。')"><input type="hidden" name="slug" value="${esc(
        m.slug,
      )}"><button class="mini del" type="submit">删除</button></form></div>`;
    })
    .join("");
  const manager = `<div class="card">
    <h2>文章管理</h2>
    <p class="desc">编辑或删除已发布文章（共 ${index.length} 篇${
      index.length > recent.length ? `，显示最近 ${recent.length} 篇` : ""
    }）。徽章为审稿评分。</p>
    ${index.length ? `<div class="postlist">${postRows}</div>` : `<p class="note">还没有文章。</p>`}
  </div>`;

  const rejRows = rejections
    .slice(0, 20)
    .map((r) => {
      const probs = r.problems?.length
        ? `<div class="rj-p">${r.problems.map((p) => `· ${esc(p)}`).join("<br>")}</div>`
        : "";
      return `<div class="rj"><div class="rj-h"><span class="rv no">${r.score} 分</span><span class="rj-t">${esc(
        r.title,
      )}</span><span class="pd">${esc(r.date.slice(0, 10))}</span></div>${probs}${
        r.suggestion ? `<div class="rj-s">建议：${esc(r.suggestion)}</div>` : ""
      }</div>`;
    })
    .join("");
  const rejected = `<div class="card">
    <h2>未过审 · 未发布</h2>
    <p class="desc">评分低于阈值（${cfg.reviewMinScore} 分）被拦截、未发布的文章，连同评分与问题记录在此。</p>
    ${rejections.length ? `<div class="rejlist">${rejRows}</div>` : `<p class="note">暂无未过审记录。</p>`}
  </div>`;

  const isOpenAI = cfg.provider === "openai";
  const opt = (v: string, label: string) =>
    `<option value="${v}"${cfg.provider === v ? " selected" : ""}>${label}</option>`;

  const body = `<div class="wrap">
  <div class="brand">${esc(env.SITE_TITLE || "智见")}<span class="tag">CONSOLE</span>
    <span style="flex:1"></span>
    <a class="muted-link" href="/" target="_blank">查看网站 ↗</a>
    <a class="muted-link" href="/admin/logout" style="margin-left:14px">退出</a>
  </div>

  <div class="card">
    <h2>运行概览</h2>
    <div class="stat" style="margin-top:12px">
      <div><b>${index.length}</b>累计文章</div>
      <div><b>${esc(adminUser(env))}</b>当前账号</div>
      <div><b>${esc((env.SOURCES || "").split(",").filter(Boolean).length.toString())}</b>数据源</div>
      <div><b>${isOpenAI ? "自定义模型" : "Workers AI"}</b>生成方式</div>
    </div>
  </div>

  ${flash}
  <form class="card" method="post" action="/admin/save">
    <h2>文章生成模型</h2>
    <p class="desc">可使用内置 Workers AI，或填入任意 OpenAI 兼容接口（如 OpenAI、DeepSeek、自建网关）。</p>

    <label>生成方式</label>
    <select name="provider" id="provider">${opt("workers-ai", "Workers AI（内置免费）")}${opt(
      "openai",
      "自定义 OpenAI 兼容接口",
    )}</select>

    <div id="openaiFields" style="${isOpenAI ? "" : "opacity:.5"}">
      ${textField(
        "apiBaseUrl",
        "接口地址 Base URL",
        cfg.apiBaseUrl,
        "OpenAI 兼容，自动追加 /chat/completions",
        "text",
        "https://api.openai.com/v1",
      )}
      ${textField("apiKey", "API Key", cfg.apiKey, "仅保存在你自己的 KV 中", "password", "sk-...")}
    </div>

    <div class="row2">
      ${textField("modelSelect", "选题模型", cfg.modelSelect, "可选 CF 模型或自定义", "text", "", "cfTextModels")}
      ${textField("modelWrite", "写作模型", cfg.modelWrite, "", "text", "", "cfTextModels")}
    </div>
    <div class="row2">
      ${textField("modelReview", "审稿模型", cfg.modelReview, "", "text", "", "cfTextModels")}
      ${textField("modelImage", "配图模型", cfg.modelImage, "始终走 Workers AI", "text", "", "cfImageModels")}
    </div>
    <datalist id="cfTextModels">${CF_TEXT_MODELS.map((m) => `<option value="${m}">`).join(
      "",
    )}</datalist>
    <datalist id="cfImageModels">${CF_IMAGE_MODELS.map((m) => `<option value="${m}">`).join(
      "",
    )}</datalist>

    <div class="row3">
      ${textField("minChars", "最少字数", String(cfg.minChars), "", "number")}
      ${textField("imageCount", "配图数量", String(cfg.imageCount), "1-6", "number")}
      ${textField("writeMaxTokens", "单次 max_tokens", String(cfg.writeMaxTokens), "", "number")}
    </div>
    ${textField(
      "reviewMinScore",
      "审稿通过分",
      String(cfg.reviewMinScore),
      "0-100，审稿员评分低于此分则不发布，并推送飞书告警",
      "number",
    )}

    <div class="actions">
      <button class="btn" type="submit">保存配置</button>
      <span class="note">配置保存于 KV，无需重新部署。</span>
    </div>
  </form>

  <form class="card" method="post" action="/admin/generate">
    <h2>立即生成</h2>
    <p class="desc">用当前配置立刻采写一篇（约需 1-3 分钟，完成后刷新首页可见）。</p>
    <div class="actions"><button class="btn ghost" type="submit">立即生成一篇</button></div>
  </form>

  ${manager}

  ${rejected}
</div>
<script>
(function(){var p=document.getElementById('provider'),f=document.getElementById('openaiFields');
function sync(){f.style.opacity=p.value==='openai'?'1':'.5';}
p.addEventListener('change',sync);sync();})();
</script>`;
  return html(shell("控制台 · 后台管理", body));
}

export async function handleSave(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const int = (k: string, d: number) => {
    const n = parseInt(str(k), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const patch: Partial<GenConfig> = {
    provider: str("provider") === "openai" ? "openai" : "workers-ai",
    apiBaseUrl: str("apiBaseUrl"),
    apiKey: str("apiKey"),
    modelSelect: str("modelSelect"),
    modelWrite: str("modelWrite"),
    modelReview: str("modelReview"),
    modelImage: str("modelImage"),
    minChars: int("minChars", 4000),
    imageCount: Math.min(6, Math.max(1, int("imageCount", 5))),
    writeMaxTokens: int("writeMaxTokens", 4096),
    reviewMinScore: Math.min(100, Math.max(0, int("reviewMinScore", 90))),
  };
  await saveConfig(env, patch);
  return redirect("/admin?saved=1");
}

// ---- edit / delete ----

export async function renderEdit(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug") || "";
  const post = await getPost(env, slug);
  if (!post) {
    return html(
      shell(
        "未找到文章",
        `<div class="wrap"><div class="card"><h2>未找到文章</h2><p class="desc">slug: ${esc(
          slug,
        )}</p><a class="btn ghost" href="/admin">← 返回控制台</a></div></div>`,
      ),
      404,
    );
  }
  const flash =
    url.searchParams.get("saved") === "1" ? `<div class="flash ok">已保存修改。</div>` : "";
  const slugEnc = encodeURIComponent(slug);

  const rv = post.review;
  let reviewBox = "";
  if (rv) {
    const sc = typeof rv.score === "number" ? `${rv.score} 分` : "";
    const status = !rv.ok
      ? `<span class="rv na">未审</span> 审稿未完成（出错/未运行）`
      : rv.pass
        ? `<span class="rv ok">${sc || "通过"}</span> 达标已发布`
        : `<span class="rv no">${sc || "未过"}</span> 未达标`;
    const probs = rv.problems?.length
      ? `<ul>${rv.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
      : "";
    const sg = rv.suggestion ? `<div class="sg">建议：${esc(rv.suggestion)}</div>` : "";
    const wc = rv.wordCount ? `<div class="sg">审稿员估计字数：${rv.wordCount}</div>` : "";
    reviewBox = `<div class="review"><h3>审稿结论 ${status}</h3>${probs}${sg}${wc}</div>`;
  }
  const body = `<div class="wrap">
  <div class="brand">${esc(env.SITE_TITLE || "智见")}<span class="tag">CONSOLE</span>
    <span style="flex:1"></span>
    <a class="muted-link" href="/post/${slugEnc}" target="_blank">预览 ↗</a>
    <a class="muted-link" href="/admin" style="margin-left:14px">← 返回控制台</a>
  </div>
  ${flash}
  <form class="card" method="post" action="/admin/edit">
    <input type="hidden" name="slug" value="${esc(slug)}">
    <h2>编辑文章</h2>
    <p class="desc">slug: ${esc(slug)}</p>
    ${reviewBox}
    ${textField("title", "标题", post.title)}
    ${textField("excerpt", "摘要", post.excerpt || "", "列表页与首页展示")}
    <label>正文 Markdown</label>
    <textarea name="markdown" spellcheck="false">${esc(post.markdown)}</textarea>
    <div class="actions">
      <button class="btn" type="submit">保存修改</button>
      <a class="btn ghost" href="/admin">取消</a>
    </div>
  </form>
</div>`;
  return html(shell("编辑文章 · 后台管理", body));
}

export async function handleEdit(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const slug = String(form.get("slug") || "");
  if (!slug) return redirect("/admin");
  const title = String(form.get("title") || "").trim() || "(无标题)";
  const excerpt = String(form.get("excerpt") || "").trim();
  const markdown = String(form.get("markdown") || "");
  await updatePost(env, slug, { title, excerpt, markdown, chars: countCjk(markdown) });
  return redirect(`/admin/edit?slug=${encodeURIComponent(slug)}&saved=1`);
}

export async function handleDelete(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const slug = String(form.get("slug") || "");
  if (slug) await deletePost(env, slug);
  return redirect("/admin?deleted=1");
}
