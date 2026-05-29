import type { Env, Post, PostMeta } from "./types";

const INDEX_KEY = "index";
const INDEX_LIMIT = 1000;

/** Build a URL-safe, collision-resistant slug (date + title + random). */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[\\/:*?"<>|#%]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-${base || "post"}-${rand}`;
}

export async function getIndex(env: Env): Promise<PostMeta[]> {
  const raw = await env.BLOG_KV.get(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PostMeta[];
  } catch {
    return [];
  }
}

export async function getPost(env: Env, slug: string): Promise<Post | null> {
  const raw = await env.BLOG_KV.get(`post:${slug}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Post;
  } catch {
    return null;
  }
}

export async function getImage(
  env: Env,
  slug: string,
  idx = 0,
): Promise<ArrayBuffer | null> {
  const key = idx > 0 ? `img:${slug}:${idx}` : `img:${slug}`;
  return env.BLOG_KV.get(key, "arrayBuffer");
}

/**
 * Persist a post, its images (index 0 = cover, 1..n = inline), and prepend it
 * to the index. Images are stored at `img:<slug>` and `img:<slug>:<i>`.
 */
export async function savePost(
  env: Env,
  post: Post,
  images: Uint8Array[],
): Promise<void> {
  await env.BLOG_KV.put(`post:${post.slug}`, JSON.stringify(post));
  for (let i = 0; i < images.length; i++) {
    const key = i === 0 ? `img:${post.slug}` : `img:${post.slug}:${i}`;
    await env.BLOG_KV.put(key, images[i]);
  }

  const index = await getIndex(env);
  const meta: PostMeta = {
    slug: post.slug,
    title: post.title,
    date: post.date,
    tags: post.tags,
    hasCover: post.hasCover,
    inlineImages: post.inlineImages,
    excerpt: post.excerpt,
    source: post.source,
  };
  index.unshift(meta);
  await env.BLOG_KV.put(INDEX_KEY, JSON.stringify(index.slice(0, INDEX_LIMIT)));
}
