import type { Env, Post, PostMeta, Rejection } from "./types";

const INDEX_KEY = "index";
const INDEX_LIMIT = 1000;
const REJECT_KEY = "rejections";
const REJECT_LIMIT = 30;

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
    chars: post.chars,
    source: post.source,
    reviewPass: post.reviewPass,
    reviewScore: post.reviewScore,
    imgVer: post.imgVer ?? Date.now(),
  };
  index.unshift(meta);
  await env.BLOG_KV.put(INDEX_KEY, JSON.stringify(index.slice(0, INDEX_LIMIT)));
}

/** Update an existing post's editable fields and sync the index entry. */
export async function updatePost(
  env: Env,
  slug: string,
  fields: Partial<Pick<Post, "title" | "markdown" | "excerpt" | "chars" | "tags">>,
): Promise<Post | null> {
  const post = await getPost(env, slug);
  if (!post) return null;
  const next: Post = { ...post, ...fields };
  await env.BLOG_KV.put(`post:${slug}`, JSON.stringify(next));

  const index = await getIndex(env);
  const i = index.findIndex((m) => m.slug === slug);
  if (i >= 0) {
    index[i] = {
      ...index[i],
      title: next.title,
      excerpt: next.excerpt,
      chars: next.chars,
      tags: next.tags,
    };
    await env.BLOG_KV.put(INDEX_KEY, JSON.stringify(index));
  }
  return next;
}

/**
 * Replace just the images of an existing post (cover = index 0, inline = 1..n)
 * without touching its text, and sync hasCover/inlineImages in the post + index.
 * Used to re-illustrate already-published articles after an image-model upgrade.
 */
export async function replaceImages(
  env: Env,
  slug: string,
  images: Uint8Array[],
): Promise<void> {
  const post = await getPost(env, slug);
  if (!post) return;

  for (let i = 0; i < images.length; i++) {
    const key = i === 0 ? `img:${slug}` : `img:${slug}:${i}`;
    await env.BLOG_KV.put(key, images[i]);
  }
  // Clear any stale inline images beyond the new count (cover stays if we have one).
  const oldInline = Math.max(post.inlineImages ?? 0, 8);
  for (let i = Math.max(1, images.length); i <= oldInline; i++) {
    await env.BLOG_KV.delete(`img:${slug}:${i}`);
  }
  if (images.length === 0) await env.BLOG_KV.delete(`img:${slug}`);

  post.hasCover = images.length >= 1;
  post.inlineImages = Math.max(0, images.length - 1);
  post.imgVer = Date.now(); // bust the immutable image cache for the new pictures
  await env.BLOG_KV.put(`post:${slug}`, JSON.stringify(post));

  const index = await getIndex(env);
  const i = index.findIndex((m) => m.slug === slug);
  if (i >= 0) {
    index[i] = {
      ...index[i],
      hasCover: post.hasCover,
      inlineImages: post.inlineImages,
      imgVer: post.imgVer,
    };
    await env.BLOG_KV.put(INDEX_KEY, JSON.stringify(index));
  }
}

/** Record a draft that failed review (for the admin "未过审" log). */
export async function logRejection(env: Env, rec: Rejection): Promise<void> {
  const list = await getRejections(env);
  list.unshift(rec);
  await env.BLOG_KV.put(REJECT_KEY, JSON.stringify(list.slice(0, REJECT_LIMIT)));
}

export async function getRejections(env: Env): Promise<Rejection[]> {
  const raw = await env.BLOG_KV.get(REJECT_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Rejection[];
  } catch {
    return [];
  }
}

/** Delete a post, its images, and remove it from the index. */
export async function deletePost(env: Env, slug: string): Promise<void> {
  const post = await getPost(env, slug);
  await env.BLOG_KV.delete(`post:${slug}`);
  await env.BLOG_KV.delete(`img:${slug}`);
  // Inline images are capped low; clear a safe range even if the count is lost.
  const inline = Math.max(post?.inlineImages ?? 0, 8);
  for (let i = 1; i <= inline; i++) await env.BLOG_KV.delete(`img:${slug}:${i}`);

  const index = await getIndex(env);
  await env.BLOG_KV.put(INDEX_KEY, JSON.stringify(index.filter((m) => m.slug !== slug)));
}
