// Per-source article extractors. Each site renders/protects its body
// differently, so every source gets its own strategy here, with a generic
// HTMLRewriter fallback. Everything is best-effort: any failure returns "" so
// generation falls back to headline-only writing.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// MIN_LEN guards HTML scraping against nav/boilerplate junk; MIN_RETURN is the
// floor for accepting clean structured content (e.g. short API news flashes).
const MIN_LEN = 150;
const MIN_RETURN = 60;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** A page that's really an anti-bot / verification wall, not the article. */
function isBlocked(html: string): boolean {
  return (
    html.length < 1500 ||
    /请进行验证|CF_APP_WAF|访问验证|滑动验证|verify you are human|captcha|access denied|cf-browser-verification/i.test(
      html,
    )
  );
}

async function fetchHtml(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "";
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  if (!res.ok) return "";
  const ct = res.headers.get("content-type") || "";
  if (ct && !/html|xml|text/i.test(ct)) return "";
  return res.text();
}

/** Collect text of all elements matching `selector`, one block per element. */
async function collectText(html: string, selector: string): Promise<string> {
  const parts: string[] = [];
  let cur = "";
  const rw = new HTMLRewriter().on(selector, {
    element(el) {
      el.onEndTag(() => {
        const s = cur.replace(/\s+/g, " ").trim();
        if (s.length > 1) parts.push(s);
        cur = "";
      });
    },
    text(t) {
      cur += t.text;
    },
  });
  await rw.transform(new Response(html)).arrayBuffer();
  const tail = cur.replace(/\s+/g, " ").trim();
  if (tail) parts.push(tail);
  // De-dupe repeated boilerplate lines, keep order.
  const seen = new Set<string>();
  return parts
    .filter((p) => (seen.has(p) ? false : (seen.add(p), true)))
    .join("\n")
    .trim();
}

/** Try selectors in order, return the first that yields enough text. */
async function viaSelectors(html: string, selectors: string[]): Promise<string> {
  for (const sel of selectors) {
    const t = await collectText(html, sel);
    if (t.length >= MIN_LEN) return t;
  }
  return "";
}

// ---- per-source extractors ----

/** IT之家: server-rendered, body in <div id="paragraph">. */
async function ithome(url: string): Promise<string> {
  const html = await fetchHtml(url);
  if (!html || isBlocked(html)) return "";
  return viaSelectors(html, ["#paragraph p", "#paragraph", ".post_content p"]);
}

/** 36氪: body shipped as a JSON-escaped `widgetContent` string in the page. */
async function kr36(url: string): Promise<string> {
  const html = await fetchHtml(url);
  if (!html) return "";
  const m = html.match(/"widgetContent":"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      return htmlToText(JSON.parse(`"${m[1]}"`));
    } catch {
      /* fall through */
    }
  }
  return viaSelectors(html, ["article p", ".article-content p"]);
}

/** 华尔街见闻: server HTML is a JS shell, but the JSON API returns clean text. */
async function wallstreetcn(url: string): Promise<string> {
  const m = url.match(/wallstreetcn\.com\/(livenews|articles)\/(\d+)/);
  if (!m) return generic(url);
  const kind = m[1] === "articles" ? "articles" : "lives";
  const res = await fetch(`https://api-one.wallstcn.com/apiv1/content/${kind}/${m[2]}`, {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!res.ok) return "";
  const json = (await res.json()) as { data?: { content_text?: string; content?: string } };
  const d = json.data || {};
  return (d.content_text || htmlToText(d.content || "")).trim();
}

/** Generic fallback: prefer real article paragraphs, then any <p>. */
async function generic(url: string): Promise<string> {
  const html = await fetchHtml(url);
  if (!html || isBlocked(html)) return "";
  const t = await viaSelectors(html, [
    "article p",
    "main p",
    ".article-content p",
    ".content p",
    "p",
  ]);
  if (t.length >= MIN_LEN) return t;
  const stripped = htmlToText(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
  return stripped.length >= MIN_LEN ? stripped : "";
}

// Sites that are JS-rendered or behind a bot wall (huxiu/zhihu/weibo/...) just
// use `generic`, which detects the wall and returns "" → headline-only writing.
const REGISTRY: Record<string, (url: string) => Promise<string>> = {
  ithome,
  "36kr": kr36,
  wallstreetcn,
};

/**
 * Fetch and clean the original article body for a given source. Returns "" on
 * any failure (blocked page, JS-only site, network error, too short).
 */
export async function fetchSourceContent(
  sourceId: string,
  url: string,
  maxChars = 4000,
): Promise<string> {
  try {
    const fn = REGISTRY[sourceId] ?? generic;
    const text = (await fn(url)) || "";
    return text.length >= MIN_RETURN ? text.slice(0, maxChars) : "";
  } catch (e) {
    console.error(`content extract failed [${sourceId}] ${url}:`, e);
    return "";
  }
}
