import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
	decodeStandardWebhookSecret,
	standardWebhookHeadersFrom,
	verifyStandardWebhookSignature,
} from "./standard-webhooks"

// "whsec_" + base64("super-secret-key"), the shape Parallel hands out.
const SECRET = `whsec_${Buffer.from("super-secret-key").toString("base64")}`
const NOW = 1_751_498_975
const BODY = JSON.stringify({
	type: "monitor.event.detected",
	data: { monitor_id: "monitor_0c9d7f7d" },
})

function sign(args: {
	id: string
	timestamp: string | number
	body: string
	secret?: string
}): string {
	const key = decodeStandardWebhookSecret(args.secret ?? SECRET)
	const ts = String(args.timestamp)
	return `v1,${createHmac("sha256", key)
		.update(`${args.id}.${ts}.${args.body}`)
		.digest("base64")}`
}

function headersFor(args: {
	id?: string
	timestamp?: string | number
	signature?: string
}) {
	return {
		id: args.id ?? "whevent_abc123def456",
		timestamp: String(args.timestamp ?? NOW),
		signature:
			args.signature ??
			sign({
				id: args.id ?? "whevent_abc123def456",
				timestamp: args.timestamp ?? NOW,
				body: BODY,
			}),
	}
}

const raw = () => new TextEncoder().encode(BODY)

describe("verifyStandardWebhookSignature", () => {
	it("accepts a correctly signed delivery", () => {
		expect(
			verifyStandardWebhookSignature(raw(), headersFor({}), SECRET, NOW),
		).toBe(true)
	})

	it("rejects a body mutated after signing", () => {
		const tampered = new TextEncoder().encode(BODY.replace("monitor_", "monitorX"))
		expect(
			verifyStandardWebhookSignature(tampered, headersFor({}), SECRET, NOW),
		).toBe(false)
	})

	it("rejects a mismatched id, since the id is part of the signed payload", () => {
		const signature = sign({ id: "whevent_aaa", timestamp: NOW, body: BODY })
		expect(
			verifyStandardWebhookSignature(
				raw(),
				headersFor({ id: "whevent_bbb", signature }),
				SECRET,
				NOW,
			),
		).toBe(false)
	})

	it("rejects a signature made with a different secret", () => {
		const other = `whsec_${Buffer.from("other-key").toString("base64")}`
		const signature = sign({
			id: "whevent_abc123def456",
			timestamp: NOW,
			body: BODY,
			secret: other,
		})
		expect(
			verifyStandardWebhookSignature(raw(), headersFor({ signature }), SECRET, NOW),
		).toBe(false)
	})

	it("accepts when an old signature in the rotation window still matches", () => {
		const rotated = `whsec_${Buffer.from("rotated-key").toString("base64")}`
		const valid = sign({ id: "whevent_abc123def456", timestamp: NOW, body: BODY })
		const stale = sign({
			id: "whevent_abc123def456",
			timestamp: NOW,
			body: BODY,
			secret: rotated,
		})
		expect(
			verifyStandardWebhookSignature(
				raw(),
				headersFor({ signature: `${stale} ${valid}` }),
				SECRET,
				NOW,
			),
		).toBe(true)
	})

	it("rejects a delivery outside the replay window", () => {
		expect(
			verifyStandardWebhookSignature(
				raw(),
				headersFor({ timestamp: NOW - 60 * 6 }),
				SECRET,
				NOW,
			),
		).toBe(false)
	})

	it("tolerates small clock skew inside the window", () => {
		expect(
			verifyStandardWebhookSignature(
				raw(),
				headersFor({ timestamp: NOW - 60 * 4 }),
				SECRET,
				NOW,
			),
		).toBe(true)
	})

	it("rejects missing or malformed headers rather than throwing", () => {
		const signature = sign({
			id: "whevent_abc123def456",
			timestamp: NOW,
			body: BODY,
		})
		expect(verifyStandardWebhookSignature(raw(), {}, SECRET, NOW)).toBe(false)
		expect(
			verifyStandardWebhookSignature(
				raw(),
				{ id: "x", timestamp: String(NOW) },
				SECRET,
				NOW,
			),
		).toBe(false)
		// No `v1,` version prefix must never be accepted.
		expect(
			verifyStandardWebhookSignature(
				raw(),
				headersFor({ signature: signature.slice(3) }),
				SECRET,
				NOW,
			),
		).toBe(false)
		// A future version prefix is not v1, so it must not verify either.
		expect(
			verifyStandardWebhookSignature(
				raw(),
				headersFor({ signature: `v2,${signature.slice(3)}` }),
				SECRET,
				NOW,
			),
		).toBe(false)
		// Non-numeric timestamp, then an empty secret.
		expect(
			verifyStandardWebhookSignature(
				raw(),
				headersFor({ signature, timestamp: "not-a-number" }),
				SECRET,
				NOW,
			),
		).toBe(false)
		expect(
			verifyStandardWebhookSignature(raw(), headersFor({ signature }), "", NOW),
		).toBe(false)
	})

	it("matches Parallel's documented reference algorithm", () => {
		// Their bash reference: strip whsec_, base64 -d, hex for openssl hexkey,
		// sign "<id>.<ts>.<payload>", base64. Reproduced independently here so a
		// shared misreading of the spec cannot make this pass by construction.
		const hexKey = Buffer.from("super-secret-key").toString("hex")
		const ts = String(NOW)
		const id = "whevent_abc123def456"
		const expected = createHmac("sha256", Buffer.from(hexKey, "hex"))
			.update(`${id}.${ts}.${BODY}`)
			.digest("base64")
		expect(
			verifyStandardWebhookSignature(
				raw(),
				{ id, timestamp: ts, signature: `v1,${expected}` },
				SECRET,
				NOW,
			),
		).toBe(true)
	})
})

describe("decodeStandardWebhookSecret", () => {
	it("strips the whsec_ prefix and decodes to raw bytes", () => {
		expect(
			Buffer.from(decodeStandardWebhookSecret(SECRET)).toString(),
		).toBe("super-secret-key")
	})

	it("accepts a bare base64 secret with no prefix", () => {
		const bare = Buffer.from("plain-secret").toString("base64")
		expect(Buffer.from(decodeStandardWebhookSecret(bare)).toString()).toBe(
			"plain-secret",
		)
	})
})

describe("standardWebhookHeadersFrom", () => {
	it("maps the documented header names", () => {
		const h = new Headers({
			"webhook-id": "whevent_abc",
			"webhook-timestamp": String(NOW),
			"webhook-signature": "v1,abc",
		})
		expect(standardWebhookHeadersFrom(h)).toEqual({
			id: "whevent_abc",
			timestamp: String(NOW),
			signature: "v1,abc",
		})
	})
})
