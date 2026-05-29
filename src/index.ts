import {
  handleDelete,
  handleEdit,
  handleLogin,
  handleLogout,
  handleSave,
  renderDashboard,
  renderEdit,
  renderLogin,
} from "./admin";
import { isAuthed } from "./auth";
import { runGeneration } from "./generate";
import { renderQr } from "./qr";
import { fetchSourceContent } from "./sources";
import {
  renderFavicon,
  renderHome,
  renderImage,
  renderPost,
  renderRss,
  renderSearch,
  renderSitemap,
} from "./render";
import type { Env } from "./types";

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname: path, origin } = url;
    const method = request.method;

    try {
      if (path === "/") {
        const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
        const cat = url.searchParams.get("cat") || undefined;
        return await renderHome(env, page, cat);
      }
      if (path === "/search") {
        const page = parseInt(url.searchParams.get("page") || "1", 10) || 1;
        return await renderSearch(env, url.searchParams.get("q") || "", page);
      }
      if (path.startsWith("/post/")) {
        return await renderPost(env, decodeURIComponent(path.slice(6)));
      }
      if (path.startsWith("/img/")) {
        const idx = parseInt(url.searchParams.get("i") || "0", 10) || 0;
        return await renderImage(env, decodeURIComponent(path.slice(5)), idx);
      }
      if (path === "/qr") return renderQr(url.searchParams.get("d") || "");
      if (path === "/favicon.svg" || path === "/favicon.ico") return renderFavicon();
      if (path === "/rss.xml") return await renderRss(env, origin);
      if (path === "/sitemap.xml") return await renderSitemap(env, origin);

      // ---- admin console ----
      if (path === "/admin/login") {
        if (method === "POST") return await handleLogin(env, request);
        if (await isAuthed(request, env)) return redirect("/admin");
        return renderLogin(env);
      }
      if (path === "/admin/logout") return handleLogout();
      if (path === "/admin") {
        if (!(await isAuthed(request, env))) return redirect("/admin/login");
        return await renderDashboard(env, request);
      }
      if (path === "/admin/save") {
        if (!(await isAuthed(request, env))) return redirect("/admin/login");
        if (method !== "POST") return redirect("/admin");
        return await handleSave(env, request);
      }
      if (path === "/admin/edit") {
        if (!(await isAuthed(request, env))) return redirect("/admin/login");
        return method === "POST"
          ? await handleEdit(env, request)
          : await renderEdit(env, request);
      }
      if (path === "/admin/delete") {
        if (!(await isAuthed(request, env))) return redirect("/admin/login");
        if (method !== "POST") return redirect("/admin");
        return await handleDelete(env, request);
      }
      if (path === "/admin/extract") {
        if (!(await isAuthed(request, env))) return redirect("/admin/login");
        const text = await fetchSourceContent(
          url.searchParams.get("id") || "",
          url.searchParams.get("url") || "",
        );
        return Response.json({ len: text.length, sample: text.slice(0, 800) });
      }

      if (path === "/admin/generate") {
        const keyOk = !!env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;
        const authed = await isAuthed(request, env);
        if (!keyOk && !authed) {
          return method === "POST" ? redirect("/admin/login") : new Response("Forbidden", { status: 403 });
        }
        // Browser/session trigger: generation is slow, so run it in the
        // background and bounce back to the dashboard immediately.
        if (authed && !keyOk) {
          ctx.waitUntil(
            runGeneration(env)
              .then((r) => console.log("admin generation:", JSON.stringify(r)))
              .catch((e) => console.error("admin generation error:", e)),
          );
          return redirect("/admin?gen=ok");
        }
        // Programmatic trigger (ADMIN_KEY): synchronous JSON result.
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
