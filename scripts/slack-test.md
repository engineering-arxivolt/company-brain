# Testing Company Brain Slack Events with curl

This guide shows how to simulate Slack sending events to your Company Brain worker using `curl`, so you can test the bot locally before wiring up the real Slack app.

## Prerequisites

1. **Your worker running** — locally via `bun run dev` or deployed on Cloudflare.
2. **A public URL** Slack can reach — if testing locally, run a tunnel (e.g. ngrok) and set `PUBLIC_URL` in `.dev.vars`.
3. **Your Slack signing secret** — from your Slack app's **Basic Information → App Credentials → Signing Secret**.
4. **Your Slack app installed** in a workspace, with **Event Subscriptions** enabled pointing at `<PUBLIC_URL>/brain/slack/events`.

The full events endpoint is:

```
POST <PUBLIC_URL>/brain/slack/events
```

> Note: During Slack app setup, Slack sends a `url_verification` challenge to this URL. The worker echoes the `challenge` back even before you've pasted the signing secret into `/setup`.

---

## Step 1: Get your signing secret

From your Slack app page (https://api.slack.com/apps → your app → **Basic Information → App Credentials**), copy the **Signing Secret**.

---

## Step 2: Generate the Slack signature headers

Slack requires `x-slack-signature` and `x-slack-request-timestamp` headers on every request. Use the helper script to generate them:

```sh
bun run scripts/slack-sign.js <SLACK_SIGNING_SECRET> '<jsonBody>'
```

The script prints the exact `-H` headers and a full `curl` command to copy/paste.

---

## Step 3: Example curl commands

### A) URL verification challenge (Slack app setup)

When you first set the Request URL in Slack, Slack sends this to verify the endpoint:

```sh
curl -X POST <PUBLIC_URL>/brain/slack/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3g8ALWMm6VT5OVQD"}'
```

Expected response: `{"challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3g8ALWMm6VT5OVQD"}`

> For this request, Slack does **not** send a signature (it hasn't been configured yet), so you don't need the signature headers.

---

### B) Direct message to the bot (message event, `channel_type: im`)

This simulates someone DMing the bot. The worker will process it and (if connected) post a reply back to Slack.

```sh
BODY='{"type":"event_callback","team_id":"T12345678","api_app_id":"A12345678","event_id":"Ev12345678","event_time":1234567890,"event":{"type":"message","user":"U12345678","text":"hello brain","channel":"D12345678","channel_type":"im","ts":"1234567890.123456"}}'

bun run scripts/slack-sign.js <SLACK_SIGNING_SECRET> "$BODY"
```

Then copy the printed `curl` command and run it.

Expected worker response: `{"ok":true}` — and shortly after, the bot posts a message in your Slack DM.

---

### C) @mention in a channel (app_mention event)

```sh
BODY='{"type":"event_callback","team_id":"T12345678","api_app_id":"A12345678","event_id":"Ev12345678","event_time":1234567890,"event":{"type":"app_mention","user":"U12345678","text":"<@BOT12345678> what is the status of prod?","channel":"C12345678","ts":"1234567890.123456"}}'

bun run scripts/slack-sign.js <SLACK_SIGNING_SECRET> "$BODY"
```

Copy and run the printed curl command.

---

### D) Channel message (proactive chime-in candidate)

```sh
BODY='{"type":"event_callback","team_id":"T12345678","api_app_id":"A12345678","event_id":"Ev12345678","event_time":1234567890,"event":{"type":"message","user":"U12345678","text":"anyone know where the API docs are?","channel":"C12345678","ts":"1234567890.123456"}}'

bun run scripts/slack-sign.js <SLACK_SIGNING_SECRET> "$BODY"
```

---

## Step 4: See the response in Slack

For the bot to actually post a message back into Slack:

1. **The Slack app must be installed** in your workspace (OAuth install via `/setup` → **Add to Slack**).
2. **Event Subscriptions must be enabled** in your Slack app with the Request URL set to `<PUBLIC_URL>/brain/slack/events` and showing a green checkmark.
3. **Bot token scopes** must include `chat:write` (already in `SLACK_SCOPES`).
4. **The bot must be in the channel/DM** where you send the message (invite it: `/invite @CompanyBrain`).

When you run the curl command, the worker:
1. Verifies the signature.
2. Parses the event envelope.
3. Runs the brain agent (which may call AI + tools).
4. Posts the answer back to Slack via `chat.postMessage`.

Check Slack for the bot's reply. If nothing appears, check:
- Worker logs: `bun run dev` output (look for `[slack]` lines)
- The Slack app's **Event Subscriptions** page (Request URL must be green)
- The Slack app's **Install App** page (bot must be installed)

---

## Step 5: Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `401 invalid signature` | Wrong signing secret or timestamp too old | Re-copy signing secret; regenerate signature (timestamp must be within 5 min) |
| `400 invalid json` | Body isn't valid JSON | Quote the JSON body properly in curl |
| `503 Slack is not configured yet` | Slack credentials not pasted into `/setup` | Open `<PUBLIC_URL>/setup`, sign in, paste Client ID / Client Secret / Signing Secret |
| `{"ok":true}` but no reply in Slack | Bot not installed or not in channel | Install app via `/setup` → **Add to Slack**; invite bot to the channel |
| ngrok / tunnel not receiving requests | Tunnel down or wrong host-header | Restart `ngrok http <PUBLIC_URL>`; ensure `PUBLIC_URL` matches the tunnel URL |
