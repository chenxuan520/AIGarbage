# AIGarbage

> Using AI to automatically generate blog spam to pollute the Internet.

A fully automated blog that runs entirely on a **single Cloudflare Worker** and the
**free tier** (no credit card required). On a schedule it pulls trending news from
multiple pluggable sources, lets Workers AI pick a topic, write an article, and
generate a cover image, stores everything in Workers KV, and serves the blog itself.

## How it works

```
Cron Trigger
  -> fetch hot items from multiple sources (pluggable)
  -> aggregate + dedupe
  -> [Agent 1] selectTopic  : choose 1 topic + angle + image prompt (JSON)
  -> [Agent 2] writeArticle : produce the markdown article
  -> [Agent 3] generateCover: flux-1-schnell cover image
  -> store post + image + index in KV

HTTP request -> same Worker -> read KV -> render markdown to HTML
```

All AI (text and image) runs through the Workers AI binding, so there is **no API
key to manage**.

## Project layout

```
src/
  index.ts        # Worker entry: fetch (site) + scheduled (cron)
  types.ts        # Env + shared types
  sources/
    newsnow.ts    # generic newsnow adapter (one factory, all sources)
    index.ts      # source registry, driven by the SOURCES var
  prompts.ts      # prompts for the select / write agents
  ai.ts           # Workers AI text + image helpers
  store.ts        # KV read/write, slug generation
  generate.ts     # the select -> write -> illustrate -> store pipeline
  render.ts       # home / post / image / RSS / sitemap + CSS
wrangler.toml     # bindings, vars, cron
```

## Setup & deploy

```bash
npm install

# 1. Log in (free account, no credit card)
npx wrangler login

# 2. Create the KV namespace, then paste the printed id into wrangler.toml
npx wrangler kv namespace create BLOG_KV

# 3. Set the secret that protects the manual trigger
npx wrangler secret put ADMIN_KEY

# 4. Deploy
npx wrangler deploy
```

The site is served at `https://aigarbage.<your-subdomain>.workers.dev`. The cron
trigger then generates posts on its own schedule.

### Local development

```bash
cp .dev.vars.example .dev.vars   # set a local ADMIN_KEY
npx wrangler dev
# then trigger a generation manually:
#   http://localhost:8787/admin/generate?key=<ADMIN_KEY>
```

> Workers AI calls in `wrangler dev` run against your real Cloudflare account, so
> you must be logged in for generation to work.

## Configuration (`wrangler.toml` [vars])

- `SOURCES` - comma-separated newsnow source ids (e.g. `huxiu,zhihu,36kr,weibo`).
- `NEWS_API_BASE` - base URL of the newsnow-compatible API.
- `AI_MODEL_SELECT` / `AI_MODEL_WRITE` / `AI_MODEL_IMAGE` - model per agent.
- `IMAGE_WIDTH` / `IMAGE_HEIGHT` - cover size (default 1024x576, 16:9).
- `WRITE_MAX_TOKENS` - article length budget.
- `crons` under `[triggers]` - generation schedule (default every 6 hours).

### Adding a data source

Most Chinese/EN hot lists are covered by adding an id to `SOURCES`. For a custom
provider, implement the `DataSource` interface in `src/sources/` and register it
in `src/sources/index.ts`.

## Routes

- `GET /` - paginated post list
- `GET /post/<slug>` - a single article
- `GET /img/<slug>` - the article cover image
- `GET /rss.xml`, `GET /sitemap.xml`, `GET /robots.txt`
- `GET /admin/generate?key=<ADMIN_KEY>` - manually trigger one generation

## Free-tier notes

- Workers AI: 10,000 neurons/day. A full post (select + write + cover) costs a few
  hundred neurons, so dozens of posts/day fit comfortably.
- KV: 100k reads/day, 1k writes/day, 1 GB. Covers are ~50-150 KB each.

## Optional: auto-deploy via GitHub Actions

`.github/workflows/deploy.yml` deploys on push to `master`. It stays a no-op until
you add a `CLOUDFLARE_API_TOKEN` repository secret.
