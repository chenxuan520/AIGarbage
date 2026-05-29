import { generateImageBytes, parseJsonLoose, runText } from "./ai";
import { getConfig, type GenConfig } from "./config";
import {
  buildContinuationMessages,
  buildReviewMessages,
  buildReviseMessages,
  buildSelectMessages,
  buildWriteMessages,
} from "./prompts";
import { getSources } from "./sources";
import { getIndex, savePost, slugify } from "./store";
import type { Env, NewsItem, Post, PostSource, TopicSelection } from "./types";

function countCjk(s: string): number {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function stripArtifacts(md: string): string {
  return md.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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

// Style suffix: clean, professional, photojournalistic — and aggressively
// text-free (diffusion models love to scribble garbled letters otherwise).
const IMAGE_STYLE =
  ", professional editorial news photography, realistic, clean composition, " +
  "natural lighting, high detail, high quality, " +
  "no text, no words, no letters, no numbers, no captions, no watermark, no logo, no signage";

function imageCount(cfg: GenConfig): number {
  return Math.min(Math.max(1, cfg.imageCount || 5), 6);
}

// Ensure we always have exactly `n` prompts, padding with generic exaggerated ones.
function padPrompts(prompts: string[], n: number, title: string): string[] {
  const out = prompts.filter(Boolean).slice(0, n);
  const generic = [
    `a realistic professional editorial photo illustrating "${title}", no text`,
    `a clean documentary-style scene related to "${title}", no text`,
    `a professional news illustration about "${title}", no text`,
    `a realistic depiction of the topic "${title}", no text`,
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

/** Agent 2: write the initial draft. */
export async function writeArticle(
  env: Env,
  sel: TopicSelection,
  cfg: GenConfig,
): Promise<string> {
  const md = await runText(env, cfg.modelWrite, buildWriteMessages(sel), cfg.writeMaxTokens, cfg);
  return stripArtifacts(md);
}

/** Writing agent: continue the article with new sections (for length). */
async function writeMore(
  env: Env,
  sel: TopicSelection,
  soFar: string,
  cfg: GenConfig,
): Promise<string> {
  const tail = soFar.slice(-800);
  const md = await runText(
    env,
    cfg.modelWrite,
    buildContinuationMessages(sel, tail),
    cfg.writeMaxTokens,
    cfg,
  );
  // Drop any stray top-level title the continuation might add.
  return stripArtifacts(md).replace(/^\s*#\s+[^\n]*\n?/, "").trim();
}

interface Review {
  pass: boolean;
  problems: string[];
  suggestion: string;
  wordCount: number;
}

/** Review/harness agent: audit the draft. */
export async function reviewArticle(
  env: Env,
  markdown: string,
  cfg: GenConfig,
): Promise<Review> {
  const text = await runText(
    env,
    cfg.modelReview,
    buildReviewMessages(markdown, cfg.minChars),
    600,
    cfg,
  );
  const p = parseJsonLoose<Record<string, unknown>>(text) ?? {};
  return {
    pass: p.pass === true,
    problems: Array.isArray(p.problems) ? (p.problems as unknown[]).map(String) : [],
    suggestion: p.suggestion ? String(p.suggestion) : "",
    wordCount: typeof p.wordCount === "number" ? (p.wordCount as number) : 0,
  };
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
): Promise<{ markdown: string; review: Review; chars: number }> {
  const min = cfg.minChars;
  const maxRounds = parseInt(env.REVIEW_MAX_REVISIONS || "6", 10);

  let md = dedupeParagraphs(await writeArticle(env, sel, cfg));

  // 1) Keep continuing until we reach the minimum *unique* length.
  for (let round = 0; round < maxRounds && countCjk(md) < min; round++) {
    const prev = countCjk(md);
    const more = await writeMore(env, sel, md, cfg);
    if (!more) break;
    md = dedupeParagraphs(`${md}\n\n${more}`);
    const now = countCjk(md);
    console.log(`extend round ${round + 1}: chars=${now}`);
    // Model added (almost) nothing new -> it is looping; stop.
    if (now <= prev + 60) {
      console.log("continuation added little new content; stopping");
      break;
    }
  }

  // 2) Reviewer audit. Length is already enforced via continuation above; we
  // deliberately do NOT auto-rewrite (a full rewrite of a long article is slow
  // and rarely worth it). The verdict is logged/returned for visibility.
  const review = await reviewArticle(env, md, cfg);
  console.log(`review: pass=${review.pass} chars=${countCjk(md)} problems=${review.problems.join("; ")}`);

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

function matchSource(candidates: NewsItem[], title: string): PostSource | undefined {
  const hit =
    candidates.find((c) => c.title === title) ??
    candidates.find((c) => title.includes(c.title) || c.title.includes(title));
  return hit ? { id: hit.source ?? "", title: hit.title, url: hit.url } : undefined;
}

/** Full pipeline: collect -> select -> write -> illustrate -> store. */
export async function runGeneration(env: Env): Promise<{
  slug: string;
  title: string;
  images: number;
  chars: number;
  reviewPass: boolean;
} | null> {
  const cfg = await getConfig(env);
  const [candidates, recent] = await Promise.all([collectCandidates(env), getRecentContext(env, 30)]);
  if (candidates.length === 0) {
    console.error("no candidates from any source; aborting");
    return null;
  }

  const selection = await selectTopic(env, candidates, cfg, recent);

  // Images only depend on the selection (not the article body), so generate
  // them concurrently with the (slow) write+review+extend harness.
  const [harness, images] = await Promise.all([
    writeWithHarness(env, selection, cfg),
    generateImages(env, selection.imagePrompts, cfg.modelImage),
  ]);

  const markdown = harness.markdown;
  if (!markdown) {
    console.error("writer returned empty markdown; aborting");
    return null;
  }

  const title = extractTitle(markdown, selection.chosenTitle);

  // Final safety net: never store a post whose title duplicates a recent one
  // (guards against cron/manual runs racing on the same hot topic).
  if (isTooSimilar(title, recent.titles)) {
    console.warn(`skip save: "${title}" duplicates a recent topic`);
    return null;
  }

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
    source: matchSource(candidates, selection.chosenTitle),
    markdown,
  };

  await savePost(env, post, images);
  console.log(
    `generated: ${slug} (chars=${harness.chars}, images=${images.length}, pass=${harness.review.pass})`,
  );
  return {
    slug,
    title,
    images: images.length,
    chars: harness.chars,
    reviewPass: harness.review.pass,
  };
}
