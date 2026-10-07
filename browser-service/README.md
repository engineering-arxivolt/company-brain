# Interactive browser sidecar (browser-use on your VPS)

The worker cannot run Chromium, so the `browse_website` turn tool delegates to
this FastAPI service: one POST in, one browser run out. Your own LLM key, your
own box — no Browser-Use Cloud account.

```
POST /run                          Authorization: Bearer $BROWSER_SERVICE_TOKEN
{ "task": "List all plan prices", "start_url": "https://acme.test/pricing" }

→ 200 { "ok": true, "result": "...", "steps": 6, "ms": 41000 }
→ 429 "browser is busy"            (one job at a time — the worker relays it)
→ 504 "browser task timed out"     (run exceeded BROWSER_MAX_SECONDS)
```

## Run it

```bash
cd browser-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium   # or: uvx browser-use install
cp .env.example .env   # fill in BROWSER_SERVICE_TOKEN + one LLM key
uvicorn main:app --host 127.0.0.1 --port 8000
```

Put it behind HTTPS (Caddy/nginx + a firewall rule for the worker's egress, or
a private tunnel) and set the two secrets on the worker:

```bash
wrangler secret put BROWSER_SERVICE_URL     # e.g. https://browser.example.com
wrangler secret put BROWSER_SERVICE_TOKEN   # same value as the sidecar's
```

Unset = `browse_website` stays hidden and `search_web` / `web_extract` cover
the web. Nothing else on the worker changes.

## How it works

- `POST /run` runs one
  [browser-use `Agent`](https://docs.browser-use.com/quickstart) with the
  `start_url` baked into the task. The lock is an `asyncio.Lock` held for the
  whole run (not just acquisition), so a second call gets 429 instead of
  queueing behind a minutes-long job.
- `BROWSER_MAX_SECONDS` (default 240) races the agent and answers 504 on
  expiry. It sits below the worker's 5-minute client timeout so the worker —
  not a dropped socket — decides what the model hears next.
- The LLM comes from your own key. `BROWSER_LLM` picks the provider
  (`openai` / `anthropic` / `google` / `chat-browser-use`); unset means the
  first key found wins, OpenAI → Anthropic → Google → Browser-Use.
- `GET /health` returns `{"ok": true, "busy": …}` without auth for load
  balancers; every other route needs the Bearer token (constant-time compare).
- `BROWSER_HEADLESS=false` shows the Chromium window for debugging flows
  locally. Nothing persistent is kept: each run gets a fresh profile, and the
  result text is capped at 12,000 characters to match the worker's turn budget.
