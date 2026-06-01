import type { Env } from "./types";

/**
 * Runtime-editable generation config. Persisted in KV under `config` and
 * layered over the static `wrangler.toml` defaults, so the admin panel can
 * point article generation at a user-supplied model without a redeploy.
 */
export interface GenConfig {
  /** "workers-ai" uses the built-in AI binding; "openai" calls a custom endpoint. */
  provider: "workers-ai" | "openai";
  /** OpenAI-compatible base, e.g. https://api.openai.com/v1 (no trailing slash). */
  apiBaseUrl: string;
  apiKey: string;

  modelSelect: string;
  modelWrite: string;
  modelReview: string;
  modelImage: string;

  minChars: number;
  imageCount: number;
  writeMaxTokens: number;
  /** Min reviewer score (0-100) required to publish. */
  reviewMinScore: number;
}

const CONFIG_KEY = "config";

function num(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Static defaults sourced from environment variables. */
export function defaultConfig(env: Env): GenConfig {
  return {
    provider: "workers-ai",
    apiBaseUrl: "",
    apiKey: "",
    modelSelect: env.AI_MODEL_SELECT,
    modelWrite: env.AI_MODEL_WRITE,
    modelReview: env.AI_MODEL_REVIEW,
    modelImage: env.AI_MODEL_IMAGE,
    minChars: num(env.MIN_CHARS, 4000),
    imageCount: num(env.IMAGE_COUNT, 5),
    writeMaxTokens: num(env.WRITE_MAX_TOKENS, 4096),
    reviewMinScore: num(env.REVIEW_MIN_SCORE, 90),
  };
}

/** Effective config = KV overrides merged over env defaults. */
export async function getConfig(env: Env): Promise<GenConfig> {
  const base = defaultConfig(env);
  try {
    const raw = await env.BLOG_KV.get(CONFIG_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<GenConfig>;
    return { ...base, ...saved };
  } catch {
    return base;
  }
}

export async function saveConfig(env: Env, patch: Partial<GenConfig>): Promise<GenConfig> {
  const next: GenConfig = { ...(await getConfig(env)), ...patch };
  if (next.provider !== "openai") next.provider = "workers-ai";
  next.reviewMinScore = Math.min(100, Math.max(0, Math.round(next.reviewMinScore)));
  await env.BLOG_KV.put(CONFIG_KEY, JSON.stringify(next));
  return next;
}
