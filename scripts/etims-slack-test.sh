#!/usr/bin/env bash
#
# etims-slack-test.sh — End-to-end test: create an eTIMS-compliant invoice,
# submit it to KRA eTIMS, then post it to Slack so you can see how it looks.
#
# All traffic goes through the Company Brain worker — no direct Slack API calls.
#
# Modes:
#   mock    — Simulates KRA OSCU without real credentials (default for testing)
#   sandbox — Real KRA sandbox (needs ETIMS_OSCU_* credentials)
#   production — Real KRA production (needs ETIMS_OSCU_* credentials)
#
# Set ETIMS_MODE=mock to test without any KRA registration.
#
# Prerequisites:
#   1. Worker running:  bun run dev   (or deployed on Cloudflare)
#   2. PUBLIC_URL set (e.g. https://<you>.ngrok-free.app)
#   3. Signed in to the web app so you have a brain_session cookie
#   4. Slack app installed in your workspace with a bot token
#   5. SLACK_CHANNEL set to your target Slack channel ID
#
# Usage:
#   chmod +x scripts/etims-slack-test.sh
#   ETIMS_MODE=mock ./scripts/etims-slack-test.sh
#
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
PUBLIC_URL="${PUBLIC_URL:-http://localhost:8787}"
SESSION_COOKIE="${SESSION_COOKIE:-brain_session=your_session_cookie_here}"
SLACK_CHANNEL="${SLACK_CHANNEL:-C1234567890}"
ETIMS_MODE="${ETIMS_MODE:-mock}"

echo "============================================================"
echo "eTIMS Invoice → Slack Test (mode: $ETIMS_MODE)"
echo "============================================================"
echo ""

# ── Step 0: Sanity check — is the worker up? ───────────────────────────────
echo "[0/5] Checking worker is reachable…"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${PUBLIC_URL}/brain/webhooks/invoices" \
  -H "Cookie: ${SESSION_COOKIE}")
if [ "${STATUS}" != "401" ] && [ "${STATUS}" != "405" ] && [ "${STATUS}" != "200" ]; then
  echo "  ✗ Worker may not be reachable (HTTP ${STATUS})."
  echo "    Make sure bun run dev is running and you're signed in."
  echo "    Set SESSION_COOKIE env var with your brain_session cookie."
  exit 1
fi
echo "  ✓ Worker reachable (HTTP ${STATUS})"
echo ""

# ── Step 1: Create an eTIMS-compliant invoice (draft) ─────────────────────
echo "[1/5] Creating eTIMS invoice (draft)…"

INVOICE_PAYLOAD=$(cat <<JSON
{
  "customerTin": "P051234567L",
  "customerName": "Acme Supplies Ltd",
  "customerMobile": "0712345678",
  "items": [
    {
      "itemSeq": 1,
      "itemCd": "ITM001",
      "itemNm": "Consulting Services",
      "pkgUnitCd": "PCS",
      "pkg": 1,
      "qtyUnitCd": "HRS",
      "qty": 10,
      "prc": 15000,
      "splyAmt": 150000,
      "dcRt": 0,
      "dcAmt": 0,
      "taxTyCd": "A",
      "taxblAmt": 150000,
      "taxAmt": 27000,
      "totAmt": 177000
    }
  ],
  "receipt": {
    "rcptPbctDt": "$(date -u +%Y%m%d%H%M%S)",
    "prchrAcptcYn": "N",
    "custTin": "P051234567L",
    "custMblNo": "0712345678",
    "trdeNm": "Acme Supplies Ltd",
    "topMsg": "Thank you for your business",
    "btmMsg": "E&OE"
  },
  "totTaxblAmt": 150000,
  "totTaxAmt": 27000,
  "totAmt": 177000
}
JSON
)

CREATE_RESP=$(curl -s -X POST "${PUBLIC_URL}/brain/webhooks/invoices" \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Content-Type: application/json" \
  -d "${INVOICE_PAYLOAD}")

echo "  Response: ${CREATE_RESP}"

INVOICE_ID=$(echo "${CREATE_RESP}" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
if [ -z "${INVOICE_ID}" ]; then
  echo "  ✗ Failed to create invoice. Check your session cookie."
  exit 1
fi
echo "  ✓ Invoice created: ${INVOICE_ID}"
echo ""

# ── Step 2: Submit to KRA eTIMS OSCU (or mock) ────────────────────────────
echo "[2/5] Submitting invoice to eTIMS OSCU (mode: ${ETIMS_MODE})…"

ETIMS_RESP=$(curl -s -X POST "${PUBLIC_URL}/brain/webhooks/invoices/${INVOICE_ID}/etims" \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Content-Type: application/json")

echo "  Response: ${ETIMS_RESP}"

ETIMS_INVOICE_NO=$(echo "${ETIMS_RESP}" | grep -o '"etimsInvoiceNo":"[^"]*"' | head -1 | sed 's/"etimsInvoiceNo":"//;s/"//')
ETIMS_QR_CODE=$(echo "${ETIMS_RESP}" | grep -o '"qrCode":"[^"]*"' | head -1 | sed 's/"qrCode":"//;s/"//')
echo "  ✓ Submitted to eTIMS: ${ETIMS_INVOICE_NO}"
if [ -n "${ETIMS_QR_CODE}" ]; then
  echo "  ✓ QR code generated: ${ETIMS_QR_CODE:0:60}…"
fi
echo ""

# ── Step 3: Fetch the invoice (to see stored data incl. QR code field) ─────
echo "[3/5] Fetching invoice details…"

INVOICE_RESP=$(curl -s -X GET "${PUBLIC_URL}/brain/webhooks/invoices/${INVOICE_ID}" \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Content-Type: application/json")

echo "  Response: ${INVOICE_RESP}"
echo ""

# ── Step 4: Post the eTIMS invoice to Slack via the worker ────────────────
echo "[4/5] Posting eTIMS invoice to Slack channel ${SLACK_CHANNEL}…"

SLACK_RESP=$(curl -s -X POST "${PUBLIC_URL}/brain/webhooks/invoices/${INVOICE_ID}/slack" \
  -H "Cookie: ${SESSION_COOKIE}" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"${SLACK_CHANNEL}\"}")

echo "  Response: ${SLACK_RESP}"

if echo "${SLACK_RESP}" | grep -q '"ok":true'; then
  echo "  ✓ Posted to Slack!"
else
  echo "  ✗ Slack post failed. Check that Slack is connected to this org."
fi
echo ""

# ── Step 5: Check logs ────────────────────────────────────────────────────
echo "[5/5] Checking worker logs…"
echo ""
echo "  Look for [etims-mock] or [etims] log lines in your worker output:"
echo "    bun run dev   (local)"
echo "    wrangler tail   (deployed)"
echo ""
echo "  You should see:"
echo "    [etims-mock] Submitted invoice inv_... -> eTIMS No: ETIMS-MOCK-..."
echo "    [slack] chat.postMessage succeeded channel=C1234567890"
echo ""

# ── Done ──────────────────────────────────────────────────────────────────
echo "============================================================"
echo "Done."
echo ""
echo "Next steps:"
echo "  1. Look in Slack channel ${SLACK_CHANNEL} for the invoice message."
echo "  2. The message includes an eTIMS QR code image."
echo "  3. Review the logs above to confirm the full flow worked."
echo "  4. Once you're satisfied with the mock output, register for"
echo "     real KRA sandbox credentials at https://etims-sbx.kra.go.ke"
echo "     and set ETIMS_MODE=sandbox with your ETIMS_OSCU_* secrets."
echo ""
echo "  Required env vars for mock mode:"
echo "    ETIMS_MODE=mock"
echo ""
echo "  Required env vars for sandbox/production:"
echo "    ETIMS_MODE=sandbox|production"
echo "    ETIMS_OSCU_BASE_URL"
echo "    ETIMS_OSCU_CLIENT_ID"
echo "    ETIMS_OSCU_CLIENT_SECRET"
echo "    ETIMS_OSCU_REGR_ID"
echo "    ETIMS_OSCU_REGR_NM"
echo "    ENCRYPTION_SECRET (for decrypting Slack bot token)"
