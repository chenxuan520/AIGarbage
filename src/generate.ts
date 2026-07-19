import { generateImageBytes, parseJsonLoose, runText } from "./ai";
import { getConfig, type GenConfig } from "./config";
import {
  buildClosingMessages,
  buildContinuationMessages,
  buildImagePromptMessages,
  buildReviewMessages,
  buildReviseMessages,
  buildSelectMessages,
  buildStoryMessages,
  buildWriteMessages,
} from "./prompts";
import { notifyLark } from "./notify";
import { fetchSourceContent, getSources } from "./sources";
import { getIndex, getPost, logRejection, replaceImages, savePost, slugify } from "./store";
import type { Env, NewsItem, Post, PostSource, TopicSelection } from "./types";

function countCjk(s: string): number {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function stripArtifacts(md: string): string {
  let out = md;
  const m = out.match(/<[^>]*end[\s_▁｜|]*of[\s_▁｜|]*think(?:ing)?[^>]*>/i);
  if (m && m.index !== undefined) out = out.slice(m.index + m[0].length);
  return out
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .trim();
}

// Plain-text summary (first sentence-ish) for listing pages.
function makeExcerpt(md: string): string {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/[>#*_`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 90);
}

// ---- topic de-duplication (avoid repeating recent topics) ----

/** Normalize a title for comparison: lowercase, strip punctuation/whitespace. */
function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigramSet(s: string): Set<string> {
  const n = normTitle(s);
  const set = new Set<string>();
  if (n.length <= 1) {
    if (n) set.add(n);
    return set;
  }
  for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
  return set;
}

/** Character-bigram Jaccard similarity (0..1). */
function similarity(a: string, b: string): number {
  const A = bigramSet(a);
  const B = bigramSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** True if `title` matches or is highly similar to any recent title. */
function isTooSimilar(title: string, recentTitles: string[]): boolean {
  const n = normTitle(title);
  if (!n) return false;
  for (const rt of recentTitles) {
    const r = normTitle(rt);
    if (!r) continue;
    if (r === n) return true;
    if (r.length >= 6 && (n.includes(r) || r.includes(n))) return true;
    if (similarity(title, rt) >= 0.6) return true;
  }
  return false;
}

interface RecentContext {
  titles: string[]; // recent article titles (for the avoid-list / similarity)
  usedKeys: Set<string>; // normalized article + source headlines already covered
}

/** Collect topics covered within the last `days` so we never repeat them. */
async function getRecentContext(env: Env, days = 30): Promise<RecentContext> {
  const index = await getIndex(env);
  const cutoff = Date.now() - days * 86400 * 1000;
  const titles: string[] = [];
  const usedKeys = new Set<string>();
  for (const m of index) {
    const t = Date.parse(m.date);
    if (!Number.isFinite(t) || t < cutoff) continue;
    titles.push(m.title);
    usedKeys.add(normTitle(m.title));
    if (m.source?.title) usedKeys.add(normTitle(m.source.title));
  }
  return { titles, usedKeys };
}

// Drop duplicate paragraphs — models sometimes loop and repeat a whole block.
function dedupeParagraphs(md: string): string {
  const blocks = md.split(/\n{2,}/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of blocks) {
    const norm = b.replace(/\s+/g, " ").trim();
    if (!norm) continue;
    if (norm.length >= 30) {
      if (seen.has(norm)) continue;
      seen.add(norm);
    }
    out.push(b.trim());
  }
  return out.join("\n\n");
}

function shortError(e: unknown): string {
  const err = e as Error;
  return String(err?.message || err).slice(0, 500);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTextForStage(
  env: Env,
  stage: string,
  model: string,
  messages: ReturnType<typeof buildWriteMessages>,
  maxTokens: number,
  cfg: GenConfig,
  attempts = 4,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await runText(env, model, messages, maxTokens, cfg);
    } catch (e) {
      const label = `${stage} attempt ${attempt + 1}/${attempts}`;
      if (attempt === attempts - 1) {
        console.error(`${label} failed permanently:`, e);
        throw new Error(`${stage} failed after ${attempts} attempts: ${shortError(e)}`);
      }
      console.warn(`${label} failed; retrying:`, e);
      await wait(1000 * (attempt + 1));
    }
  }
  throw new Error(`${stage} failed without an error`);
}

async function settleDraftParts(
  parts: Array<Promise<string>>,
  labels: string[],
): Promise<string[]> {
  const settled = await Promise.allSettled(parts);
  const failures = settled
    .map((r, i) => (r.status === "rejected" ? `${labels[i]}: ${shortError(r.reason)}` : ""))
    .filter(Boolean);
  if (failures.length) throw new Error(`正文生成失败: ${failures.join(" | ")}`);
  return settled.map((r) => (r as PromiseFulfilledResult<string>).value);
}

/** Fetch every enabled source in parallel and dedupe by title. */
async function collectCandidates(env: Env): Promise<NewsItem[]> {
  const sources = getSources(env);
  const results = await Promise.allSettled(sources.map((s) => s.fetch(env)));

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") {
      console.error("source failed:", r.reason);
      continue;
    }
    for (const it of r.value) {
      const key = it.title.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }
  return items;
}

// Style suffix: clean, photojournalistic look. NOTE on two past defects:
//  1) "text/words/letters" tokens make diffusion models scribble garbled glyphs,
//     so text is avoided by steering prompts away from text-bearing SUBJECTS
//     (handled in the prompt builder), not by negative phrasing here.
//  2) "cinematic" / "35mm" / film cues made the model add black letterbox bars,
//     so we ask for a full-frame photo filling the whole frame instead.
const IMAGE_STYLE =
  ", professional editorial press photograph, photorealistic, true-to-life natural colors, " +
  "soft natural daylight, sharp focus, clean uncluttered composition, " +
  "full-frame photo filling the entire frame";

function imageCount(cfg: GenConfig): number {
  return Math.min(Math.max(1, cfg.imageCount || 5), 6);
}

// Ensure we always have exactly `n` prompts, padding with generic exaggerated ones.
function padPrompts(prompts: string[], n: number, title: string): string[] {
  const out = prompts.filter(Boolean).slice(0, n);
  // Fallback only — keep these text-free and free of the (Chinese) headline so
  // the image model never tries to render glyphs, and avoid "cinematic" (it adds
  // letterbox bars).
  const generic = [
    "a candid documentary photograph of people reacting in a tense real-world moment, natural light",
    "a photorealistic close-up of a worried person's face, soft daylight, clean background",
    "a real-world environmental photograph of an empty workplace at dusk, no signage",
    "a professional press photograph of hands holding a meaningful object, shallow background",
  ];
  let i = 0;
  while (out.length < n) out.push(generic[i++ % generic.length]);
  return out;
}

function buildSelection(
  parsed: Record<string, unknown>,
  title: string,
  want: number,
): TopicSelection {
  const raw = Array.isArray(parsed.imagePrompts)
    ? (parsed.imagePrompts as unknown[]).map((x) => String(x))
    : parsed.imagePrompt
      ? [String(parsed.imagePrompt)]
      : [];
  return {
    chosenTitle: title,
    angle: parsed.angle ? String(parsed.angle) : "",
    keyPoints: Array.isArray(parsed.keyPoints)
      ? (parsed.keyPoints as unknown[]).map((x) => String(x))
      : [],
    imagePrompts: padPrompts(raw, want, title),
  };
}

/** Agent 1: pick a FRESH topic (not covered recently) + angle + image prompts. */
export async function selectTopic(
  env: Env,
  candidates: NewsItem[],
  cfg: GenConfig,
  recent: RecentContext,
): Promise<TopicSelection> {
  const want = imageCount(cfg);

  // Hard filter: drop headlines already covered in the last month so the model
  // can't even re-pick them. Fall back to the full set only if all are stale.
  const fresh = candidates.filter(
    (c) => !recent.usedKeys.has(normTitle(c.title)) && !isTooSimilar(c.title, recent.titles),
  );
  const pool = (fresh.length ? fresh : candidates).slice(0, 40);
  console.log(`select pool: ${pool.length} fresh of ${candidates.length} (recent=${recent.titles.length})`);

  // Ask the model, and retry once if it still returns a recent duplicate.
  const avoid = [...recent.titles];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await runText(env, cfg.modelSelect, buildSelectMessages(pool, avoid), 700, cfg);
    const parsed = parseJsonLoose<Record<string, unknown>>(text);
    const title = parsed?.chosenTitle ? String(parsed.chosenTitle).trim() : "";
    if (parsed && title) {
      if (!isTooSimilar(title, recent.titles)) return buildSelection(parsed, title, want);
      console.log(`select attempt ${attempt + 1}: "${title}" duplicates recent; retrying`);
      avoid.push(title); // forbid this one explicitly on the retry
    }
  }

  // Fallback: first fresh candidate that isn't a recent duplicate.
  const fallback = pool.find((c) => !isTooSimilar(c.title, recent.titles)) ?? pool[0];
  const title = fallback?.title ?? "今日热点观察";
  return {
    chosenTitle: title,
    angle: "",
    keyPoints: [],
    imagePrompts: padPrompts([], want, title),
  };
}

/** Agent 2: write the initial draft (grounded in the original article text). */
export async function writeArticle(
  env: Env,
  sel: TopicSelection,
  cfg: GenConfig,
  reference = "",
): Promise<string> {
  const md = await runTextForStage(
    env,
    "write:intro",
    cfg.modelWrite,
    buildWriteMessages(sel, reference),
    cfg.writeMaxTokens,
    cfg,
  );
  return stripArtifacts(md);
}

/** Writing agent: continue the article with new sections (for length). */
async function writeMore(
  env: Env,
  sel: TopicSelection,
  soFar: string,
  cfg: GenConfig,
  reference = "",
): Promise<string> {
  const tail = soFar.slice(-800);
  const md = await runTextForStage(
    env,
    "write:extension",
    cfg.modelWrite,
    buildContinuationMessages(sel, tail, reference),
    cfg.writeMaxTokens,
    cfg,
  );
  // Drop any stray top-level title the continuation might add.
  return stripArtifacts(md).replace(/^\s*#\s+[^\n]*\n?/, "").trim();
}

// Strip <think> blocks and any stray H1 (body fragments must not add a title).
function cleanFragment(md: string): string {
  return stripArtifacts(md).replace(/^\s*#\s+[^\n]*\n?/, "").trim();
}

/** Writing agent: the middle bizarre character story (~1500-1700字). */
async function writeStory(
  env: Env,
  sel: TopicSelection,
  cfg: GenConfig,
  reference = "",
): Promise<string> {
  const tokens = Math.max(cfg.writeMaxTokens, 5000);
  const md = await runTextForStage(
    env,
    "write:story",
    cfg.modelWrite,
    buildStoryMessages(sel, reference),
    tokens,
    cfg,
  );
  return cleanFragment(md);
}

/** Writing agent: the closing — a ~2000字 deep, resonant argument. Needs the
 *  biggest token budget of the three parts so it isn't cut off mid-sentence. */
async function writeClosing(
  env: Env,
  sel: TopicSelection,
  cfg: GenConfig,
  reference = "",
): Promise<string> {
  const tokens = Math.max(cfg.writeMaxTokens, 6000);
  const md = await runTextForStage(
    env,
    "write:closing",
    cfg.modelWrite,
    buildClosingMessages(sel, reference),
    tokens,
    cfg,
  );
  return cleanFragment(md);
}

interface Review {
  ok: boolean; // reviewer ran AND returned a parseable verdict
  score: number; // 0-100
  problems: string[];
  suggestion: string;
  wordCount: number;
}

/** Review/harness agent: score the draft (0-100). Returns ok=false if the
 *  reviewer call/parse failed (e.g. quota error) so callers can tell "didn't
 *  run" apart from "scored low". */
const clampScore = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

/**
 * Parse a reviewer reply into a verdict. Tries strict JSON first, then falls
 * back to field-by-field regex — reasoning models (GLM) often emit *almost*
 * valid JSON (e.g. closing the object early then appending "suggestion"
 * outside), which JSON.parse rejects but the gate still needs a score from.
 * Returns null only if no score can be found at all.
 */
export function parseReview(
  text: string,
  fallbackWordCount: number,
): { score: number; problems: string[]; suggestion: string; wordCount: number } | null {
  const p = parseJsonLoose<Record<string, unknown>>(text);
  if (p && typeof p.score === "number" && Number.isFinite(p.score as number)) {
    return {
      score: clampScore(p.score as number),
      problems: Array.isArray(p.problems) ? (p.problems as unknown[]).map(String) : [],
      suggestion: p.suggestion ? String(p.suggestion) : "",
      wordCount: typeof p.wordCount === "number" ? (p.wordCount as number) : fallbackWordCount,
    };
  }
  const sm = text.match(/"?score"?\s*:\s*(\d{1,3})/i);
  if (!sm) return null;
  let problems: string[] = [];
  const pm = text.match(/"?problems"?\s*:\s*(\[[\s\S]*?\])/i);
  if (pm) {
    try {
      const arr = JSON.parse(pm[1]) as unknown;
      if (Array.isArray(arr)) problems = arr.map(String);
    } catch {
      /* leave problems empty */
    }
  }
  const gm = text.match(/"?suggestion"?\s*:\s*"([\s\S]*?)"/i);
  const wm = text.match(/"?wordCount"?\s*:\s*(\d+)/i);
  return {
    score: clampScore(parseInt(sm[1], 10)),
    problems,
    suggestion: gm ? gm[1] : "",
    wordCount: wm ? parseInt(wm[1], 10) : fallbackWordCount,
  };
}

export async function reviewArticle(
  env: Env,
  markdown: string,
  cfg: GenConfig,
): Promise<Review> {
  const fallbackWc = countCjk(markdown);
  // Retry: a single transient Workers AI blip (4006/timeout) or an unparseable
  // reply used to silently drop the verdict and publish the article as 未审.
  // Try a few times — on BOTH a thrown error and a non-JSON reply — before
  // giving up, so only a real, repeated failure ends up unreviewed.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Budget must cover a reasoning model's hidden thinking PLUS the JSON it
      // emits afterwards; 600 starved GLM (all tokens went to reasoning -> empty
      // content). 2048 leaves ample room for the short verdict.
      const text = await runText(
        env,
        cfg.modelReview,
        buildReviewMessages(markdown, cfg.minChars),
        2048,
        cfg,
      );
      const r = parseReview(text, fallbackWc);
      if (r) return { ok: true, ...r };
      console.warn(
        `review attempt ${attempt + 1}/3 unparseable: ${text.slice(0, 100).replace(/\s+/g, " ")}`,
      );
    } catch (e) {
      console.error(`review attempt ${attempt + 1}/3 threw:`, e);
    }
  }
  return { ok: false, score: 0, problems: [], suggestion: "", wordCount: fallbackWc };
}

async function reviseArticle(
  env: Env,
  sel: TopicSelection,
  draft: string,
  review: Review,
  cfg: GenConfig,
): Promise<string> {
  const md = await runText(
    env,
    cfg.modelWrite,
    buildReviseMessages(sel, draft, review.problems, review.suggestion, cfg.minChars),
    cfg.writeMaxTokens,
    cfg,
  );
  return stripArtifacts(md);
}

/**
 * Write -> extend until long enough -> review (the harness) -> optional fix.
 * Returns the final markdown plus the reviewer verdict and char count.
 */
async function writeWithHarness(
  env: Env,
  sel: TopicSelection,
  cfg: GenConfig,
  reference = "",
): Promise<{ markdown: string; review: Review; chars: number }> {
  const min = cfg.minChars;

  // Three distinct parts generated in parallel; the human story sits in the
  // middle: 开头(钩子+背景+矛盾) -> 人物故事(~1500字) -> 结尾(影响+分析). This
  // fixed skeleton is what makes articles engaging AND kills the old
  // continuation-loop repetition (same sections written over and over).
  const [intro, story, closing] = await settleDraftParts(
    [
      writeArticle(env, sel, cfg, reference),
      writeStory(env, sel, cfg, reference),
      writeClosing(env, sel, cfg, reference),
    ],
    ["write:intro", "write:story", "write:closing"],
  );
  let md = dedupeParagraphs([intro, story, closing].filter(Boolean).join("\n\n"));
  console.log(
    `draft: intro=${countCjk(intro)} story=${countCjk(story)} closing=${countCjk(closing)} total=${countCjk(md)}`,
  );

  // Single, non-looping extension only if we're clearly under target.
  if (countCjk(md) < min) {
    const more = await writeMore(env, sel, md, cfg, reference);
    if (more) md = dedupeParagraphs(`${md}\n\n${more}`);
    console.log(`extended once: total=${countCjk(md)}`);
  }

  // A review hiccup (quota/parse error) must NEVER discard a written article;
  // catch it and mark the verdict as "not completed" instead.
  let review: Review;
  try {
    review = await reviewArticle(env, md, cfg);
  } catch (e) {
    console.error("review call threw:", e);
    review = { ok: false, score: 0, problems: [], suggestion: "", wordCount: countCjk(md) };
  }
  console.log(
    `review: ok=${review.ok} score=${review.score} chars=${countCjk(md)} problems=${review.problems.join("; ")}`,
  );

  return { markdown: md, review, chars: countCjk(md) };
}

/** Generate one image, best-effort with a retry (never throws). */
async function generateOne(env: Env, prompt: string, model: string): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await generateImageBytes(env, prompt + IMAGE_STYLE, model);
    } catch (e) {
      console.error(`image attempt ${attempt + 1} failed:`, e);
    }
  }
  return null;
}

/**
 * Derive image prompts from the FINISHED article so the pictures actually match
 * the content. Falls back to the (headline-time) selection prompts on failure.
 */
async function deriveImagePrompts(
  env: Env,
  sel: TopicSelection,
  body: string,
  cfg: GenConfig,
): Promise<string[]> {
  const want = imageCount(cfg);
  try {
    // Use the SELECT model (llama by default), NOT the write model: the writer
    // may be a reasoning model (GLM) whose hidden thinking starves a small token
    // budget and returns empty JSON -> we'd silently fall back to generic
    // prompts. A non-reasoning model returns the JSON reliably and cheaply.
    const text = await runText(
      env,
      cfg.modelSelect,
      buildImagePromptMessages(sel.chosenTitle, body, want),
      1200,
      cfg,
    );
    const parsed = parseJsonLoose<{ imagePrompts?: unknown }>(text);
    const arr = Array.isArray(parsed?.imagePrompts)
      ? (parsed?.imagePrompts as unknown[]).map((x) => String(x)).filter(Boolean)
      : [];
    if (arr.length) {
      console.log(`image prompts: ${arr.length} grounded in article`);
      return padPrompts(arr, want, sel.chosenTitle);
    }
  } catch (e) {
    console.error("derive image prompts failed; using selection prompts:", e);
  }
  return padPrompts(sel.imagePrompts ?? [], want, sel.chosenTitle);
}

/**
 * Re-illustrate an EXISTING post in place: derive fresh prompts from its stored
 * body and regenerate images with the current image model, overwriting the old
 * ones. Leaves the article text untouched. Returns the prompts used + count.
 */
export async function regenerateImagesForPost(
  env: Env,
  slug: string,
): Promise<{ count: number; prompts: string[] } | null> {
  const post = await getPost(env, slug);
  if (!post) return null;
  const cfg = await getConfig(env);
  const sel: TopicSelection = {
    chosenTitle: post.title,
    angle: "",
    keyPoints: [],
    imagePrompts: [],
  };
  const prompts = await deriveImagePrompts(env, sel, post.markdown, cfg);
  const images = await generateImages(env, prompts, cfg.modelImage);
  if (images.length) await replaceImages(env, slug, images);
  return { count: images.length, prompts };
}

/** Agent 3: generate several exaggerated images; returns only successful ones. */
export async function generateImages(
  env: Env,
  prompts: string[],
  model: string,
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const prompt of prompts) {
    const bytes = await generateOne(env, prompt, model);
    if (bytes) out.push(bytes);
  }
  return out;
}

function extractTitle(markdown: string, fallback: string): string {
  const firstLine = markdown.split("\n").find((l) => l.trim().length > 0) ?? "";
  const m = firstLine.match(/^#+\s*(.+?)\s*#*$/);
  return (m ? m[1] : fallback).trim() || fallback;
}

function matchSourceItem(candidates: NewsItem[], title: string): NewsItem | undefined {
  return (
    candidates.find((c) => c.title === title) ??
    candidates.find((c) => title.includes(c.title) || c.title.includes(title))
  );
}

function toPostSource(item: NewsItem | undefined): PostSource | undefined {
  return item ? { id: item.source ?? "", title: item.title, url: item.url } : undefined;
}

/** Outcome of one generation run (never throws to a null for the gated path). */
export type GenOutcome =
  | {
      kind: "published";
      slug: string;
      title: string;
      images: number;
      chars: number;
      score: number;
      reviewPass: boolean | null; // null = review didn't run (published anyway)
    }
  | { kind: "rejected"; title: string; score: number; threshold: number; problems: string[] }
  | { kind: "none"; reason: string };

/** Full pipeline: collect -> select -> write -> review/gate -> illustrate -> store. */
export async function runGeneration(env: Env): Promise<GenOutcome> {
  const cfg = await getConfig(env);
  const [candidates, recent] = await Promise.all([collectCandidates(env), getRecentContext(env, 30)]);
  if (candidates.length === 0) {
    console.error("no candidates from any source; aborting");
    return { kind: "none", reason: "无候选(数据源全部失败或为空)" };
  }

  const selection = await selectTopic(env, candidates, cfg, recent);

  // Pull the ORIGINAL article so the writer is grounded in real facts instead
  // of hallucinating from a headline. Per-source extractor; "" if unavailable.
  const sourceItem = matchSourceItem(candidates, selection.chosenTitle);
  const reference = sourceItem ? await fetchSourceContent(sourceItem.source ?? "", sourceItem.url) : "";
  console.log(
    `reference: ${reference ? `${reference.length} chars from ${sourceItem?.source}` : "none (headline-only)"}`,
  );

  // Write first: images must be grounded in the ACTUAL article body, and we
  // don't want to spend neurons illustrating a draft that fails the gate.
  const harness = await writeWithHarness(env, selection, cfg, reference);
  const markdown = harness.markdown;
  if (!markdown) {
    console.error("writer returned empty markdown; aborting");
    return { kind: "none", reason: "写作返回空内容" };
  }

  const title = extractTitle(markdown, selection.chosenTitle);

  // Final safety net: never store a post whose title duplicates a recent one
  // (guards against cron/manual runs racing on the same hot topic).
  if (isTooSimilar(title, recent.titles)) {
    console.warn(`skip save: "${title}" duplicates a recent topic`);
    return { kind: "none", reason: `选题与近期文章重复:${title}` };
  }

  const rv = harness.review;
  const threshold = cfg.reviewMinScore;

  // Quality gate. A genuinely low score blocks publishing. A review that did
  // NOT run (ok=false — e.g. the Workers AI quota glitch) must not silently
  // kill output, so we publish anyway and flag it as 未审 (reviewPass=null).
  if (rv.ok && rv.score < threshold) {
    console.warn(`rejected: "${title}" score=${rv.score} < ${threshold}`);
    await logRejection(env, {
      date: new Date().toISOString(),
      title,
      score: rv.score,
      problems: rv.problems,
      suggestion: rv.suggestion,
    });
    await notifyLark(
      env,
      `文章未过审 未发布（${rv.score}/${threshold}）`,
      `**标题**：${title}\n**评分**：${rv.score} / 阈值 ${threshold}\n**问题**：${
        rv.problems.length ? rv.problems.map((p) => `\n- ${p}`).join("") : "无"
      }${rv.suggestion ? `\n**建议**：${rv.suggestion}` : ""}`,
    );
    return { kind: "rejected", title, score: rv.score, threshold, problems: rv.problems };
  }

  const reviewPass = rv.ok ? true : null;

  // Cleared the gate — now spend neurons on illustration grounded in the body.
  const imgPrompts = await deriveImagePrompts(env, selection, markdown, cfg);
  const images = await generateImages(env, imgPrompts, cfg.modelImage);

  const slug = slugify(title);
  const post: Post = {
    slug,
    title,
    date: new Date().toISOString(),
    tags: [],
    hasCover: images.length >= 1,
    inlineImages: Math.max(0, images.length - 1),
    excerpt: makeExcerpt(markdown),
    chars: harness.chars,
    source: toPostSource(sourceItem),
    reviewPass,
    reviewScore: rv.ok ? rv.score : undefined,
    review: {
      ok: rv.ok,
      score: rv.score,
      pass: rv.ok ? rv.score >= threshold : false,
      wordCount: rv.wordCount,
      problems: rv.problems,
      suggestion: rv.suggestion,
    },
    markdown,
  };

  await savePost(env, post, images);
  console.log(
    `generated: ${slug} (chars=${harness.chars}, images=${images.length}, score=${rv.score}, reviewPass=${reviewPass})`,
  );

  // Review couldn't run but we published anyway — let the operator know.
  if (reviewPass === null) {
    await notifyLark(
      env,
      "审稿未运行 已照常发布",
      `**标题**：${title}\n审稿模型未返回有效评分（可能是额度异常），文章已照常发布，请留意质量。`,
    );
  }

  return {
    kind: "published",
    slug,
    title,
    images: images.length,
    chars: harness.chars,
    score: rv.score,
    reviewPass,
  };
}
