import { runGeneration } from "./generate";
import {
  renderFavicon,
  renderHome,
  renderImage,
  renderPost,
  renderRss,
  renderSitemap,
} from "./render";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname: path, origin } = url;

    try {
      if (path === "/") {
        const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
        return await renderHome(env, page);
      }
      if (path.startsWith("/post/")) {
        return await renderPost(env, decodeURIComponent(path.slice(6)));
      }
      if (path.startsWith("/img/")) {
        const idx = parseInt(url.searchParams.get("i") || "0", 10) || 0;
        return await renderImage(env, decodeURIComponent(path.slice(5)), idx);
      }
      if (path === "/favicon.svg" || path === "/favicon.ico") return renderFavicon();
      if (path === "/rss.xml") return await renderRss(env, origin);
      if (path === "/sitemap.xml") return await renderSitemap(env, origin);

      if (path === "/admin/generate") {
        const key = url.searchParams.get("key");
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
          return new Response("Forbidden", { status: 403 });
        }
        try {
          const result = await runGeneration(env);
          return Response.json({ ok: !!result, result });
        } catch (e) {
          const err = e as Error;
          return Response.json(
            { ok: false, error: String(err?.stack || err?.message || err) },
            { status: 500 },
          );
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("fetch error:", err);
      return new Response("Internal Error", { status: 500 });
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runGeneration(env)
        .then((r) => console.log("scheduled generation:", JSON.stringify(r)))
        .catch((e) => console.error("scheduled generation error:", e)),
    );
  },
} satisfies ExportedHandler<Env>;
