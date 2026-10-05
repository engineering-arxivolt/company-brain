#!/usr/bin/env node
/**
 * Sign a Parallel monitor delivery the way Parallel does, and POST it to a
 * worker. Proves the receiving half of the Parallel integration
 * (`POST /brain/webhooks/parallel`) end to end without waiting for a real
 * monitor to fire.
 *
 * Usage:
 *   ./scripts/parallel-webhook-probe.ts --url https://brain.example/brain/webhooks/parallel \
 *     --secret whsec_... --org <orgId> --team <T…> --channel <C…> [--thread <ts>] [--monitor <id>]
 *
 * The `whsec_…` value is Parallel's Settings -> Webhooks signing secret: the
 * same one the worker reads as `PARALLEL_WEBHOOK_SECRET`. Pass
 * `--print-only` to see the signed request without sending it.
 *
 * Read the status code:
 *   200  the delivery was authenticated and routed; a turn ran in the background
 *   401  the signature did not verify -- usually a secret mismatch
 *   501  PARALLEL_WEBHOOK_SECRET is not set on the worker
 *
 * A 200 only proves routing. The reply that lands in Slack depends on
 * PARALLEL_API_KEY too: without it (or without a real `monitor_id`) the turn
 * degrades to the "could not load the details" notice.
 *
 * The `orgId`/`teamId`/`channelId` are the routing metadata Parallel echoes
 * back from whatever created the monitor. They are not free text: `teamId` must
 * be a Slack workspace installed to that org, and `channelId` a channel the bot
 * is in, or the delivery is dropped with a warning rather than posted.
 */
import { createHmac } from "node:crypto"

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "")
}

function required(name: string): string {
	const value = args.get(name)
	if (!value) {
		console.error(`missing --${name}`)
		process.exit(2)
	}
	return value
}

const url = required("url")
const secret = required("secret")
const printOnly = args.has("print-only")

const orgId = args.get("org") ?? ""
const teamId = args.get("team") ?? ""
const channelId = args.get("channel") ?? ""
const threadTs = args.get("thread")
if (!printOnly && !(orgId && teamId && channelId)) {
	console.error(
		"--org, --team and --channel are required: they are the routing metadata Parallel echoes back. Use --print-only to just show the signed request.",
	)
	process.exit(2)
}

const body = JSON.stringify({
	type: "monitor.event.detected",
	timestamp: new Date().toISOString(),
	data: {
		monitor_id: args.get("monitor") ?? "monitor_probe",
		event: {
			event_group_id: args.get("group") ?? "mevtgrp_probe",
			type: "monitor.event.detected",
		},
		...(orgId
			? {
					metadata: {
						orgId,
						teamId,
						channelId,
						...(threadTs ? { threadTs } : {}),
					},
				}
			: {}),
	},
})

const id = `msg_probe_${Date.now()}`
const timestamp = String(Math.floor(Date.now() / 1000))
// The same HMAC input the worker verifies: `webhook-id.webhook-timestamp.rawBody`
// over the base64-decoded secret, base64 WITH padding.
const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret
const signature = `v1,${createHmac("sha256", Buffer.from(raw, "base64"))
	.update(`${id}.${timestamp}.${body}`)
	.digest("base64")}`

const headers = {
	"content-type": "application/json",
	"webhook-id": id,
	"webhook-timestamp": timestamp,
	"webhook-signature": signature,
}

console.log(`POST ${url}`)
console.log(`  webhook-id         ${id}`)
console.log(`  webhook-timestamp  ${timestamp}`)
console.log(`  webhook-signature  ${signature.slice(0, 12)}…`)
console.log(`  body               ${body}`)

if (printOnly) process.exit(0)

// The body must arrive byte-for-byte as signed, so it is sent as built.
const res = await fetch(url, { method: "POST", headers, body })
console.log(`  -> HTTP ${res.status} ${res.statusText}`)
console.log(`  -> ${await res.text()}`)
console.log()

// Only the auth failures are worth a red script; everything else is the
// route's own 2xx-on-anything-but-bad-signature contract.
if (res.status === 401) {
	console.error("signature rejected: the whsec_ secret does not match the worker's PARALLEL_WEBHOOK_SECRET.")
	process.exitCode = 1
}