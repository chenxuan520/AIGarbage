/// <reference types="@cloudflare/workers-types" />

export interface Env {
  BLOG_KV: KVNamespace;
  AI: Ai;

  NEWS_API_BASE: string;
  SOURCES: string;

  AI_MODEL_SELECT: string;
  AI_MODEL_WRITE: string;
  AI_MODEL_REVIEW: string;
  AI_MODEL_IMAGE: string;

  // Minimum Chinese characters; reviewer/harness rejects shorter drafts.
  MIN_CHARS: string;
  REVIEW_MAX_REVISIONS: string;

  IMAGE_WIDTH: string;
  IMAGE_HEIGHT: string;
  IMAGE_COUNT: string;
  WRITE_MAX_TOKENS: string;

  SITE_TITLE: string;
  SITE_DESC: string;

  // Secret. Set via `wrangler secret put ADMIN_KEY`. Also used to sign sessions.
  ADMIN_KEY?: string;

  // Admin login. Defaults: user "admin", pass "admin888" (demo). Override
  // ADMIN_PASS via `wrangler secret put ADMIN_PASS` in production.
  ADMIN_USER?: string;
  ADMIN_PASS?: string;

  // Cloudflare Turnstile (human check). Defaults to the always-pass TEST keys
  // so login works out of the box; replace with real keys for production.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

/** A single trending item returned by a data source. */
export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source?: string;
  extra?: Record<string, unknown>;
}

/**
 * Pluggable data source. Implement this to plug in any provider.
 * For newsnow-compatible APIs use the `newsNowSource` factory.
 */
export interface DataSource {
  id: string;
  name: string;
  fetch(env: Env): Promise<NewsItem[]>;
  /** Optional site-specific article-body extractor (falls back to generic). */
  fetchContent?(item: NewsItem, env: Env): Promise<string>;
}

/** Structured output of the topic-selection agent. */
export interface TopicSelection {
  chosenTitle: string;
  angle: string;
  keyPoints: string[];
  /** Multiple exaggerated cover/inline image prompts (index 0 = cover). */
  imagePrompts: string[];
}

export interface PostSource {
  id: string;
  title: string;
  url: string;
}

export interface PostMeta {
  slug: string;
  title: string;
  date: string; // ISO timestamp
  tags: string[];
  hasCover: boolean;
  /** Number of extra in-body images (cover excluded). */
  inlineImages?: number;
  /** Short plain-text summary for listing pages. */
  excerpt?: string;
  /** Chinese character count of the body, used for reading-time/stats. */
  chars?: number;
  source?: PostSource;
}

export interface Post extends PostMeta {
  markdown: string;
}
