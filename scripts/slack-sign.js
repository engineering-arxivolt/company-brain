#!/usr/bin/env node
/**
 * slack-sign.js — Generate a valid Slack request signature for curl testing.
 *
 * Slack signs every Events API / Interactions request with HMAC-SHA256:
 *   base string  = `v0:<timestamp>:<rawBody>`
 *   signature    = `v0=` + hex(HMAC-SHA256(signingSecret, base string))
 *
 * Usage:
 *   bun run scripts/slack-sign.js <signingSecret> <jsonBody>
 *
 * Example:
 *   bun run scripts/slack-sign.js \
 *     <SLACK_SIGNING_SECRET> \
 *     '{"type":"event_callback","team_id":"T123","event_id":"E123","event":{"type":"message","user":"U123","text":"hi brain","channel":"C123","ts":"123.456"}}'
 *
 * Output: the exact curl -H headers to copy/paste.
 */

import { createHmac } from "node:crypto";

const signingSecret = process.argv[2];
const rawBody = process.argv[3];

if (!signingSecret || !rawBody) {
  console.error(
    "Usage: bun run scripts/slack-sign.js <signingSecret> '<jsonBody>'",
  );
  process.exit(1);
}

const timestamp = Math.floor(Date.now() / 1000);
const base = `v0:${timestamp}:${rawBody}`;
const signature = `v0=${createHmac("sha256", signingSecret)
  .update(base)
  .digest("hex")}`;

console.log("=== Slack signature headers (copy these into your curl command) ===");
console.log("");
console.log(`-H "Content-Type: application/json"`);
console.log(`-H "X-Slack-Signature: ${signature}"`);
console.log(`-H "X-Slack-Request-Timestamp: ${timestamp}"`);
console.log("");
console.log("=== Full curl command ===");
console.log("");
console.log(
  `curl -X POST <YOUR_PUBLIC_URL>/brain/slack/events \\`,
);
console.log(`  -H "Content-Type: application/json" \\`);
console.log(`  -H "X-Slack-Signature: ${signature}" \\`);
console.log(`  -H "X-Slack-Request-Timestamp: ${timestamp}" \\`);
console.log(`  -d '${rawBody}'`);
console.log("");
