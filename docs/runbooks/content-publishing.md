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
ARXIVOLT_ENGINE_ADMIN_SECRET     same value as the engine's ADMIN_SECRET
POSTHOG_API_KEY                  server-side events (existing)
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
node test/publish-api.smoke.mjs   # 37 checks, no network, uses node:sqlite
```

Verify prod after a deploy:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://www.arxivolt.com/            # 200
curl -s https://www.arxivolt.com/sitemap.xml | grep -c '<loc>'               # stable count
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://www.arxivolt.com/admin/articles  # 401
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

## PostHog (pipeline + site)

Server-side (this repo, `@/lib/posthog`): emit one event per stage with the same
`distinct_id` (org id) and `slug`/`keyword`/`volume` properties —
`seo_keyword_chosen`, `seo_article_drafted`, `seo_article_published`, `seo_article_verified`.
Site-side: the engine needs the public project key (`phc_…`) to render the PostHog
snippet on article pages, so pageviews and CTA clicks land against the same slugs the
pipeline publishes. Until that key is in the engine, measurement stops at publication.
