# Runbook: research → article → publish → measure

Everything below is code in this repo plus two Workers. There is **no second content
engine**: the article stage reuses the existing one (see "Which module owns what").

## Which module owns what (don't duplicate)

| Stage | Owned by | Notes |
|---|---|---|
| Evidence | `src/brain/content/evidence.ts` | one read-only turn per round; every claim traceable |
| Angle / mix | `src/brain/content/plan.ts`, `taxonomy.ts` | deterministic rotation, funnel × vehicle |
| Voice + rules | `src/brain/content/voice.ts`, `sources/content-engine.ts` | house rules come from the `Arxivolt/content-engine` repo as skills |
| Social drafts | `src/brain/content/generate.ts` (`runContentStudio`) | review card → Buffer (`push.ts`, `buffer.ts`) |
| Campaign pack | `src/brain/content/campaign.ts` | posts + SEO block + script + brief + Flow kit |
| Keyword data | `src/brain/content/treg.ts` | treg → `catalog_search` → `catalog_get` → `call` (Google Ads, $0) |
| Site publishing | `src/brain/content/sources/arxivolt-engine.ts` | `publishDeepDive` → engine admin API |
| Rendering | `arxivolt-engine` worker | article HTML, JSON-LD, sitemap, redirects, PDF assets |

If a new capability looks like "a content pipeline", it belongs in one of the rows above,
not in a new module.

## Secrets and config

company-brain:
```
PUBLIC_URL                       (already set)
ARXIVOLT_ENGINE_URL              optional, defaults to https://www.arxivolt.com
ARXIVOLT_ENGINE_ADMIN_SECRET     same value as the engine's ADMIN_SECRET (set, rotated 2026-11)
POSTHOG_API_KEY                  server-side events (existing)
GSC_ACCESS_TOKEN                 optional fallback; Search Console normally comes via treg
```
```
npx wrangler secret put ARXIVOLT_ENGINE_ADMIN_SECRET --name company-brain
```

arxivolt-engine:
```
ADMIN_SECRET            guards /admin/* (products, publish API)
LINEAR_WEBHOOK_SECRET   optional; when set, /linear-webhook requires it
```
Bindings live in `wrangler.jsonc` (reconstructed from the live worker: D1 `DB`,
compat date, www/gate/forge custom domains). Deploy:

```bash
npx wrangler deploy          # from the arxivolt-engine repo
node test/publish-api.smoke.mjs   # 48 checks, no network, uses node:sqlite
```

Verify prod after a deploy:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://www.arxivolt.com/            # 200
curl -s https://www.arxivolt.com/sitemap.xml | grep -c '<loc>'               # stable count
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://www.arxivolt.com/admin/articles  # 401
# secrets are write-only — keep the value in a password manager and export it
curl -s "https://www.arxivolt.com/admin/articles?limit=2" -H "Authorization: Bearer $ARXIVOLT_ENGINE_ADMIN_SECRET"   # 200 + rows
```

## Render agent (VPS side: cards, Flow stills, PDFs)

Requires Node 24 (no bun needed):

```bash
cd ~/company-brain
TOKEN=<deployment:encryption-secret> \
WORKER_URL=https://company-brain.<account>.workers.dev \
POLL_MS=5000 \
node scripts/render-agent.ts
```

systemd unit:
```ini
[Service]
WorkingDirectory=/home/ubuntu/company-brain
Environment=WORKER_URL=https://company-brain.example.workers.dev
Environment=TOKEN=<secret>
ExecStart=/usr/bin/env node scripts/render-agent.ts
Restart=always
RestartSec=5
```
`EnvironmentFile=/home/ubuntu/.render-agent.env` keeps the token out of the unit file.

## PDF generation (container sandbox)

`src/brain/documents/deliver-report.ts` writes the LaTeX, then runs the build from
`build.sh` under `timeout -k 5 240s`, so a hung `pdflatex` dies instead of pinning the
session. Each step logs `ms=` so "slow" and "stuck" are distinguishable.
Sandbox exec timeouts: default 30s, max 300s (`tools/sandbox/guards.ts`).

If a sandbox wedges (an exec that never returns):
```bash
ps -eo pid,etime,cmd | grep 'container-server/sandbox'   # etime in days = wedged
# restart the sandbox container (Cloudflare dashboard → Sandbox, or `docker restart <id>`)
```
A wedged exec keeps its slot, so every later command queues behind it. That is the
"PDF just sits there" failure mode.

## Troubleshooting (the bugs this runbook encodes)

| Symptom | Cause | Fix |
|---|---|---|
| `claim failed: 500`, queue frozen | `/render/next` throws on a KV value that parses to `null` | `parseRenderJob` rejects it and the key is deleted (`render-jobs.ts`, `worker.ts`) |
| `env: 'bun': No such file` | agent shebang was `#!/usr/bin/env bun` | shebang is `node`; jobs spawn `process.execPath`, never bare `node` |
| Agent hangs on a render | child process had no timeout | `run()` kills at 180s and reports exit 124 |
| PDF never finishes | exec left running in the container | `timeout` wrapper + max timeout 300s |
| `ms=` missing in logs | no per-step timing | every step logs elapsed ms |
| `Cannot read properties of null (reading 'dbSession')` from `/admin/articles` | `stmt.bind.apply(null, args)` drops the statement as `this` | `bind(...args)`; the smoke fake now throws if `bind` loses its receiver |
| `content_growth_plan` says no Search Console data | treg not connected, or the property isn't listed for that Google account | error names which one; connect treg under Settings → Connectors |

## PostHog (pipeline + site) — wired

Server-side (`@/lib/posthog` → `captureSeoEvent`), `distinct_id` = org id:

| Event | Emitted from | Joins on |
|---|---|---|
| `seo_keyword_chosen` | `content/growth.ts` → `chooseTopic` | `keyword`, `volume`, `score` |
| `seo_article_drafted` | `content/sources/arxivolt-engine.ts` → `publishDeepDive` | `slug` |
| `seo_article_published` | same, after the API accepts | `slug`, `url`, `cluster` |
| `seo_article_verified` | same, after the page is fetched back | `slug`, `verified` |

Site-side (`arxivolt-engine`): every HTML response gets the snippet injected before
`</head>`; the project key is baked into the worker. Article/pillar/home pages register
`slug`, `cluster`, `page_type`, `page_path` as PostHog super properties, then emit
`$pageview`, `cta_click` (consultation/cal.com/mailto/wa.me/tel links) and `read_depth`
(50/90%). The script loads 1.2s after `load` so it never competes with LCP, and admin
JSON is never injected (asserted in `test/publish-api.smoke.mjs`).

Funnel in PostHog: `seo_keyword_chosen` → `seo_article_published` → `$pageview` →
`cta_click`, all on `slug`. If the last two are empty, the beacon is the bug, not the content.

## Indexing (IndexNow)

The engine serves `/<key>.txt` for `INDEXNOW_KEY` and POSTs new/changed URLs to
`api.indexnow.org` after every successful `POST`/`PATCH /admin/articles`. Bing, Yandex and
Seznam index in hours instead of waiting for a crawl. Check:

```bash
curl -s https://www.arxivolt.com/8f4c2d1e6a9b47d3a5c0e2f7b9d1486c.txt   # must return the key
```

## Growth loop (free stack)

| Source | Free tier | Feeds |
|---|---|---|
| Google Search Console | free, API quota'd | `content/gsc.ts` → `seo_gsc_query` table → `summariseByPage` |
| PostHog | 1M events/mo, 5K replays, 1 project, 1-yr retention, hard stop at limits | sessions/conversions per slug |
| Cloudflare Web Analytics | free on all plans | traffic baseline + Core Web Vitals |
| IndexNow / Bing Webmaster | free | indexing latency |
| Buffer (already connected) | free per channel | social surface |

Decision model (`content/growth.ts`): `scorePage` (opportunity/decay/conversion gap),
`scoreTopic` (volume × intent × link surface × freshness, cannibalisation = hard 0),
bands at 0.7/0.4, and `content/growth-report.ts` builds the weekly top-5. In the brain the
operator asks for it in words and the `content_growth_plan` tool does the pull + scoring
(`refresh: true` fetches 28 days first; it refuses with the token instructions when
nothing is stored). Gates live in `content/quality.ts` (`auditArticle`): single H1,
title 10–140, meta 60–180, ≥300 words, one figure = one evidence citation. System 1
triage (`content/triage.ts`) classifies intake, keyword intent and draft risk with a 0.7
confidence floor and a regex fallback.

### Blocked / one-click steps

- **Search Console token**: needs `webmasters.readonly`. Set `GSC_ACCESS_TOKEN` and
  `GSC_SITE_URL` as worker secrets; without them `fetchGscQueries` fails closed with that
  message (no silent zero traffic).
- **Cloudflare Web Analytics**: the RUM site cannot be created with a wrangler OAuth token
  (RUM scope missing). Create it once in the dashboard (Web Analytics → Add site →
  `www.arxivolt.com`, auto-install), or set `CF_BEACON_TOKEN` in the engine and the snippet
  is injected server-side.
- **PostHog site key** is embedded and verified (ingest returns `{"status":"Ok"}`).

