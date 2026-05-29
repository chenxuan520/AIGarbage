import { generateImageBytes, parseJsonLoose, runText } from "./ai";
import {
  buildContinuationMessages,
  buildReviewMessages,
  buildReviseMessages,
  buildSelectMessages,
  buildWriteMessages,
} from "./prompts";
import { getSources } from "./sources";
import { savePost, slugify } from "./store";
import type { Env, NewsItem, Post, PostSource, TopicSelection } from "./types";

function countCjk(s: string): number {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function stripArtifacts(md: string): string {
  return md.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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

// Style suffix that pushes every image toward an exaggerated, tabloid look.
const IMAGE_STYLE =
  ", dramatic exaggerated sensational tabloid editorial illustration, " +
  "bold dramatic lighting, high contrast, cinematic, eye-catching, no text, no watermark";

function imageCount(env: Env): number {
  const n = parseInt(env.IMAGE_COUNT || "5", 10);
  return Math.min(Math.max(1, Number.isNaN(n) ? 5 : n), 6);
}

// Ensure we always have exactly `n` prompts, padding with generic exaggerated ones.
function padPrompts(prompts: string[], n: number, title: string): string[] {
  const out = prompts.filter(Boolean).slice(0, n);
  const generic = [
    `a shocked crowd reacting to "${title}"`,
    `a dramatic exaggerated scene illustrating "${title}"`,
    `a bold over-the-top symbolic depiction of "${title}"`,
    `an explosive eye-catching illustration about "${title}"`,
  ];
  let i = 0;
  while (out.length < n) out.push(generic[i++ % generic.length]);
  return out;
}

/** Agent 1: pick a topic + angle + several exaggerated image prompts. */
export async function selectTopic(env: Env, candidates: NewsItem[]): Promise<TopicSelection> {
  const sample = candidates.slice(0, 40);
  const text = await runText(env, env.AI_MODEL_SELECT, buildSelectMessages(sample), 700);
  const parsed = parseJsonLoose<Record<string, unknown>>(text);
  const want = imageCount(env);

  if (parsed && parsed.chosenTitle) {
    const title = String(parsed.chosenTitle).trim();
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

  // Fallback: just take the hottest item.
  const fallback = sample[0];
  const title = fallback?.title ?? "今日热点观察";
  return {
    chosenTitle: title,
    angle: "",
    keyPoints: [],
    imagePrompts: padPrompts([], want, title),
  };
}

/** Agent 2: write the initial draft. */
export async function writeArticle(env: Env, sel: TopicSelection): Promise<string> {
  const max = parseInt(env.WRITE_MAX_TOKENS || "4096", 10);
  const md = await runText(env, env.AI_MODEL_WRITE, buildWriteMessages(sel), max);
  return stripArtifacts(md);
}

/** Writing agent: continue the article with new sections (for length). */
async function writeMore(env: Env, sel: TopicSelection, soFar: string): Promise<string> {
  const max = parseInt(env.WRITE_MAX_TOKENS || "4096", 10);
  const tail = soFar.slice(-800);
  const md = await runText(env, env.AI_MODEL_WRITE, buildContinuationMessages(sel, tail), max);
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
export async function reviewArticle(env: Env, markdown: string): Promise<Review> {
  const min = parseInt(env.MIN_CHARS || "4000", 10);
  const text = await runText(env, env.AI_MODEL_REVIEW, buildReviewMessages(markdown, min), 600);
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
): Promise<string> {
  const min = parseInt(env.MIN_CHARS || "4000", 10);
  const max = parseInt(env.WRITE_MAX_TOKENS || "4096", 10);
  const md = await runText(
    env,
    env.AI_MODEL_WRITE,
    buildReviseMessages(sel, draft, review.problems, review.suggestion, min),
    max,
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
): Promise<{ markdown: string; review: Review; chars: number }> {
  const min = parseInt(env.MIN_CHARS || "4000", 10);
  const maxRounds = parseInt(env.REVIEW_MAX_REVISIONS || "6", 10);

  let md = dedupeParagraphs(await writeArticle(env, sel));

  // 1) Keep continuing until we reach the minimum *unique* length.
  for (let round = 0; round < maxRounds && countCjk(md) < min; round++) {
    const prev = countCjk(md);
    const more = await writeMore(env, sel, md);
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
  const review = await reviewArticle(env, md);
  console.log(`review: pass=${review.pass} chars=${countCjk(md)} problems=${review.problems.join("; ")}`);

  return { markdown: md, review, chars: countCjk(md) };
}

/** Generate one image, best-effort with a retry (never throws). */
async function generateOne(env: Env, prompt: string): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await generateImageBytes(env, prompt + IMAGE_STYLE);
    } catch (e) {
      console.error(`image attempt ${attempt + 1} failed:`, e);
    }
  }
  return null;
}

/** Agent 3: generate several exaggerated images; returns only successful ones. */
export async function generateImages(env: Env, prompts: string[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const prompt of prompts) {
    const bytes = await generateOne(env, prompt);
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
  const candidates = await collectCandidates(env);
  if (candidates.length === 0) {
    console.error("no candidates from any source; aborting");
    return null;
  }

  const selection = await selectTopic(env, candidates);

  // Images only depend on the selection (not the article body), so generate
  // them concurrently with the (slow) write+review+extend harness.
  const [harness, images] = await Promise.all([
    writeWithHarness(env, selection),
    generateImages(env, selection.imagePrompts),
  ]);

  const markdown = harness.markdown;
  if (!markdown) {
    console.error("writer returned empty markdown; aborting");
    return null;
  }

  const title = extractTitle(markdown, selection.chosenTitle);
  const slug = slugify(title);

  const post: Post = {
    slug,
    title,
    date: new Date().toISOString(),
    tags: [],
    hasCover: images.length >= 1,
    inlineImages: Math.max(0, images.length - 1),
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
