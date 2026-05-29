import type { DataSource, Env } from "../types";
import { newsNowSource } from "./newsnow";

/**
 * Friendly display names for well-known newsnow source ids.
 * Unknown ids still work (the id itself is used as the name).
 */
const KNOWN_NAMES: Record<string, string> = {
  huxiu: "虎嗅",
  zhihu: "知乎",
  "36kr": "36氪",
  weibo: "微博",
  baidu: "百度热搜",
  toutiao: "今日头条",
  bilibili: "哔哩哔哩",
  douyin: "抖音",
  ithome: "IT之家",
  wallstreetcn: "华尔街见闻",
  cls: "财联社",
  thepaper: "澎湃新闻",
  hackernews: "Hacker News",
  github: "GitHub Trending",
};

/**
 * Build the active source registry from the SOURCES env var.
 *
 * To add a NON-newsnow source, implement the `DataSource` interface and
 * push your instance into the returned array (e.g. behind a known id).
 */
export function getSources(env: Env): DataSource[] {
  const ids = (env.SOURCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return ids.map((id) => newsNowSource(id, KNOWN_NAMES[id] ?? id));
}
