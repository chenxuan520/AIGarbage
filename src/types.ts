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

  // Secret. Set via `wrangler secret put ADMIN_KEY`.
  ADMIN_KEY?: string;
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
  source?: PostSource;
}

export interface Post extends PostMeta {
  markdown: string;
}
