import type { DataSource, Env, NewsItem } from "../types";

interface NewsNowResponse {
  status?: string;
  id?: string;
  updatedTime?: number;
  items?: Array<{ id: string | number; title: string; url: string }>;
}

/**
 * Adapter for any newsnow-compatible endpoint:
 *   GET {NEWS_API_BASE}/api/s?id=<id>&latest
 * One factory covers all newsnow sources (huxiu, zhihu, weibo, ...).
 */
export function newsNowSource(id: string, name: string): DataSource {
  return {
    id,
    name,
    async fetch(env: Env): Promise<NewsItem[]> {
      const base = (env.NEWS_API_BASE || "").replace(/\/$/, "");
      const url = `${base}/api/s?id=${encodeURIComponent(id)}&latest`;
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "AIGarbage/1.0" },
      });
      if (!res.ok) {
        throw new Error(`source "${id}" responded HTTP ${res.status}`);
      }
      const data = (await res.json()) as NewsNowResponse;
      return (data.items ?? [])
        .filter((it) => it && it.title)
        .map((it) => ({
          id: String(it.id),
          title: String(it.title).trim(),
          url: it.url,
          source: id,
        }));
    },
  };
}
