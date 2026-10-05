import { createHmac, timingSafeEqual } from "node:crypto"

// Standard Webhooks (https://github.com/standard-webhooks/standard-webhooks),
// as implemented by Svix. Parallel signs with this scheme. It is deliberately
// NOT folded into slack/verify.ts: that helper is `v0=<hex>` over
// `v0:ts:body`, while this is base64 over `id.ts.body` with a derived key, so
// the two schemes share only the constant-time compare.
//   key      : secret minus the `whsec_` prefix, base64-decoded to raw bytes
//   payload  : `${webhook-id}.${webhook-timestamp}.${rawBody}`
//   encoding : standard Base64 WITH padding; header is space-delimited so a
//              rotation window can carry an old and a new signature at once
const MAX_SKEW_SECONDS = 60 * 5

export type StandardWebhookHeaders = {
	id?: string | null
	timestamp?: string | null
	signature?: string | null
}

/** Strip the `whsec_` prefix and base64-decode to the raw HMAC signing key. */
export function decodeStandardWebhookSecret(secret: string): Uint8Array {
	const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret
	return new Uint8Array(Buffer.from(raw, "base64"))
}

function expectedSignature(args: {
	signingKey: Uint8Array
	id: string
	timestamp: string
	rawBody: Uint8Array
}): string {
	return createHmac("sha256", args.signingKey)
		.update(`${args.id}.${args.timestamp}.`)
		.update(args.rawBody)
		.digest("base64")
}

/** Constant-time compare that tolerates a length mismatch without throwing. */
function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

/**
 * Verify one Standard Webhooks delivery. Secret rotation keeps the previous
 * secret live for a short window, so several `v1,<sig>` entries may be present;
 * any one matching is enough.
 */
export function verifyStandardWebhookSignature(
	rawBody: Uint8Array,
	headers: StandardWebhookHeaders,
	secret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
	const id = headers.id
	const timestamp = headers.timestamp
	const signature = headers.signature
	if (!id || !timestamp || !signature || !secret) return false

	const ts = Number(timestamp)
	if (!Number.isFinite(ts)) return false
	// Replay window: an old delivery replayed verbatim must not verify.
	if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false

	const signingKey = decodeStandardWebhookSecret(secret)
	if (signingKey.length === 0) return false

	const expected = expectedSignature({ signingKey, id, timestamp, rawBody })
	return signature
		.split(" ")
		.map((part) => part.trim())
		.filter(Boolean)
		.some((part) => {
			const comma = part.indexOf(",")
			if (comma < 0) return false
			if (part.slice(0, comma) !== "v1") return false
			return safeEqual(part.slice(comma + 1), expected)
		})
}

/** Read the three Standard Webhooks headers off a live request. */
export function standardWebhookHeadersFrom(
	headers: Headers,
): StandardWebhookHeaders {
	return {
		id: headers.get("webhook-id"),
		timestamp: headers.get("webhook-timestamp"),
		signature: headers.get("webhook-signature"),
	}
}