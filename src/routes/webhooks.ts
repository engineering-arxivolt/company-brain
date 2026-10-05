import { getAgentByName } from "agents"
import { Hono } from "hono"
import type { AppContext } from "@/types"
import {
	parallelDeliveryShouldPost,
	resolveParallelDelivery,
} from "@/lib/brain/webhooks/parallel"
import {
	standardWebhookHeadersFrom,
	verifyStandardWebhookSignature,
} from "@/lib/brain/webhooks/standard-webhooks"

// Parallel retries a failed delivery for 48h with exponential backoff. Every
// path that is not an authentication failure therefore answers 2xx: a 5xx here
// buys nothing but two days of retries, since the payload is already
// authenticated and re-delivery cannot change its routing.
const DEDUP_TTL_SECONDS = 60 * 60 * 24

export const webhookRoutes = new Hono<AppContext>()
	.post("/parallel", async (c) => {
		const secret = c.env.PARALLEL_WEBHOOK_SECRET
		if (!secret) {
			return c.json({ error: "webhooks are not configured" }, 501)
		}

		// Signature covers the exact bytes, so the raw body must be buffered
		// before any JSON parsing.
		const rawBody = new Uint8Array(await c.req.raw.clone().arrayBuffer())
		if (
			!verifyStandardWebhookSignature(
				rawBody,
				standardWebhookHeadersFrom(c.req.raw.headers),
				secret,
			)
		) {
			// A forged signature is the one case worth a hard failure.
			return c.json({ error: "invalid signature" }, 401)
		}

		// Duplicate deliveries are expected, not exceptional.
		const deliveryId = c.req.raw.headers.get("webhook-id")
		const kv = c.env.BRAIN_KV
		const dedupKey = deliveryId ? `parallel:evt:${deliveryId}` : null
		if (dedupKey && kv) {
			const seen = await kv.get(dedupKey).catch(() => null)
			if (seen) return c.json({ ok: true, duplicate: true })
		}

		let payload: unknown
		try {
			payload = JSON.parse(new TextDecoder().decode(rawBody))
		} catch {
			// Malformed but authenticated: acknowledge so Parallel stops retrying.
			return c.json({ ok: true })
		}

		const delivery = resolveParallelDelivery(payload)
		// Acknowledge anything we cannot route or act on. Marking it seen is
		// still correct: the delivery's fate is already decided.
		if (!delivery || !parallelDeliveryShouldPost(delivery)) {
			if (dedupKey && kv) {
				await kv
					.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS })
					.catch(() => {})
			}
			return c.json({ ok: true })
		}

		// The guard above narrowed `route` to non-optional, so there is nothing
		// left to check here: `shouldPost` already required one.
		const { route } = delivery

		// Claim the delivery before doing any work, so a retry arriving while the
		// turn is still running cannot start a second one.
		if (dedupKey && kv) {
			await kv
				.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS })
				.catch(() => {})
		}

		c.executionCtx.waitUntil(
			(async () => {
				try {
					const agent = await getAgentByName(
						c.env.COMPANY_BRAIN_AGENT,
						route.orgId,
					)
					await agent.onParallelMonitorEvent({
						type: delivery.type,
						monitorId: delivery.monitorId,
						eventGroupId: delivery.eventGroupId,
						teamId: route.teamId,
						channelId: route.channelId,
						threadTs: route.threadTs,
					})
				} catch (err) {
					console.error("[parallel-webhook] turn failed:", err)
				}
			})(),
		)

		return c.json({ ok: true })
	})