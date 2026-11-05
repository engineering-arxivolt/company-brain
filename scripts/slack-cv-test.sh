#!/usr/bin/env bash
#
# slack-cv-test.sh — Ask the deployed brain for a tailored CV + cover letter
# without typing in Slack, then show the log lines that prove the sandbox ran.
#
# It signs a Slack `message` event exactly the way Slack does (HMAC-SHA256 over
# `v0:<timestamp>:<rawBody>`) and POSTs it to the worker's /slack/events route.
# The bot's answer still lands in the Slack DM, so this exercises the real
# pipeline end to end — routing, Jev skill selection, the sandbox, the upload.
#
# Prerequisites:
#   1. Slack app installed and Event Subscriptions pointed at <PUBLIC_URL>/slack/events
#   2. The bot in the target DM/channel
#   3. Your app's Signing Secret (Basic Information → App Credentials)
#
# Usage:
#   SLACK_SIGNING_SECRET=xxxx ./scripts/slack-cv-test.sh
#   SLACK_SIGNING_SECRET=xxxx ./scripts/slack-cv-test.sh job-description.txt
#
# Env overrides:
#   PUBLIC_URL (default: the deployed worker)
#   SLACK_CHANNEL (default: the bot DM seen in this workspace)
#   SLACK_USER, SLACK_TEAM
#   TAIL_LOG (default: /tmp/tail3.log) — grep'd at the end when it exists
#
set -euo pipefail

PUBLIC_URL="${PUBLIC_URL:-https://company-brain.mindo-joseph-mj.workers.dev}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"
SLACK_TEAM="${SLACK_TEAM:-T0C3QD194PR}"
SLACK_USER="${SLACK_USER:-U0C5053HU9E}"
SLACK_CHANNEL="${SLACK_CHANNEL:-D0C4QDVEC01}"
TAIL_LOG="${TAIL_LOG:-/tmp/tail3.log}"
JOB_FILE="${1:-}"

echo "============================================================"
echo "Job description → CV + cover letter test"
echo "  worker : ${PUBLIC_URL}"
if [ -n "${JOB_FILE}" ]; then echo "  posting: ${JOB_FILE}"; else echo "  posting: built-in sample"; fi
echo "============================================================"
echo ""

if [ -z "${SLACK_SIGNING_SECRET}" ]; then
  echo "Missing SLACK_SIGNING_SECRET."
  echo "  Slack app → Basic Information → App Credentials → Signing Secret"
  echo "  SLACK_SIGNING_SECRET=xxxx ./scripts/slack-cv-test.sh"
  exit 1
fi

# ── Step 1: the ask ────────────────────────────────────────────────────────
if [ -n "${JOB_FILE}" ] && [ -f "${JOB_FILE}" ]; then
  JOB_TEXT="$(cat "${JOB_FILE}")"
else
  JOB_TEXT="$(cat <<'JOB'
Senior Software Engineer, Living Goods (Nairobi, Kenya)

We are looking for an experienced Senior Software Engineer to join our Global
Software Engineering team in Nairobi. You will take technical ownership of a
product area, lead a team of two to four engineers, and stay hands-on.

Engineering responsibilities:
- Design, develop and maintain our offline-first Android application.
- Design and build FHIR-native backend services (Kotlin, Spring Boot).
- Own the health of what the team ships: CI, releases, test coverage.

Requirements:
- 5+ years building and running production software.
- Strong TypeScript/JavaScript and one of Go, Kotlin, Ruby or Python.
- Experience leading engineers and reviewing code.
- Hybrid in Nairobi; relocation and visa support considered.
JOB
)"
fi

echo "[1/3] Building the Slack message event…"
TEXT="Here is a job description. Give me a CV and a cover letter tailored to it, as PDFs.

${JOB_TEXT}"

# JSON-encode everything, then sign the exact bytes that will be sent.
SIGNED="$(python3 - "${SLACK_SIGNING_SECRET}" "${SLACK_TEAM}" "${SLACK_USER}" "${SLACK_CHANNEL}" "${TEXT}" <<'PY'
import hashlib, hmac, json, sys, time

secret, team, user, channel, text = sys.argv[1:6]
now = int(time.time())
ts = f"{now}.000100"
body = json.dumps({
    "type": "event_callback",
    "team_id": team,
    "api_app_id": "A0C3QD194PR",
    "event_id": f"EvCVTEST{now}",
    "event_time": now,
    "event": {
        "type": "message",
        "user": user,
        "text": text,
        "channel": channel,
        "channel_type": "im",
        "ts": ts,
        "event_ts": ts,
    },
}, separators=(",", ":"))
stamp = str(now)
digest = hmac.new(
    secret.encode(), f"v0:{stamp}:{body}".encode(), hashlib.sha256
).hexdigest()
print(stamp)
print(f"v0={digest}")
print(body)
PY
)"
SIG_TS="$(sed -n 1p <<<"${SIGNED}")"
SIG="$(sed -n 2p <<<"${SIGNED}")"
BODY="$(sed -n 3p <<<"${SIGNED}")"
echo "  ✓ signed event (ts=${SIG_TS})"
echo ""

# ── Step 2: deliver it to the worker ───────────────────────────────────────
echo "[2/3] POST ${PUBLIC_URL}/slack/events …"
HTTP_CODE="$(curl -s -o /tmp/slack-cv-test-response.txt -w '%{http_code}' \
  -X POST "${PUBLIC_URL}/slack/events" \
  -H "Content-Type: application/json" \
  -H "x-slack-request-timestamp: ${SIG_TS}" \
  -H "x-slack-signature: ${SIG}" \
  --data-binary "${BODY}")"
echo "  HTTP ${HTTP_CODE} — $(head -c 300 /tmp/slack-cv-test-response.txt)"
case "${HTTP_CODE}" in
  200) echo "  ✓ accepted: the brain is working on it (reply lands in the DM)" ;;
  401) echo "  ✗ signature rejected: wrong signing secret, or a clock more than 5 min off" ;;
  503) echo "  ✗ Slack is not configured in /setup for this deployment" ;;
  *)   echo "  ✗ unexpected status" ;;
esac
echo ""

# ── Step 3: prove the document path actually ran ───────────────────────────
echo "[3/3] Watching ${TAIL_LOG} for the document path (Ctrl-C to stop)…"
echo "  Looking for, in order:"
echo "    preloaded skill enabled families=sandbox   ← the fix (tools now visible)"
echo "    sandbox_run … latexmk -pdf                 ← real compile in the container"
echo "    sandbox_get_artifact … uploaded: true      ← the PDF reached Slack"
echo ""
if [ -f "${TAIL_LOG}" ]; then
  timeout 180 grep --line-buffered -E \
    'preloaded skill enabled families|load_skill unlocked|sandbox_(start|run|write_file|get_artifact)|latexmk|uploaded|final output' \
    "${TAIL_LOG}" || true
else
  echo "  ${TAIL_LOG} not found. Start one with:"
  echo "    npx wrangler tail company-brain --format json > ${TAIL_LOG} 2>&1 &"
fi
echo ""
echo "If the run stops at 'load_skill unlocked families=sandbox' and never reaches"
echo "sandbox_run, the model gave up before using its tools — say so, and re-run"
echo "with a fuller job description so the turn does not stall on missing context."
