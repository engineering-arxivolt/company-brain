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
import {
	PesaCastWebhookSchema,
	pesacastWebhookHeadersFrom,
	verifyPesacastSignature,
	type PesaCastWebhook,
} from "@/lib/brain/webhooks/pesacast"

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

	// PesaCast phone webhook: real-time M-PESA transactions pushed from the
	// Android app to a URL the user controls. Mirrors the parallel webhook
	// pattern: verify signature (or bearer token), dedupe on Idempotency-Key,
	// acknowledge immediately, then defer the ingest turn to the Durable Object.
	.post("/pesacast", async (c) => {
		const secret = c.env.PESACAST_WEBHOOK_SECRET
		const token = c.env.PESACAST_WEBHOOK_TOKEN

		if (!secret && !token) {
			return c.json({ error: "pesacast webhooks are not configured" }, 501)
		}

		// The signature covers the exact bytes, so buffer the raw body first.
		const rawBody = new Uint8Array(await c.req.raw.clone().arrayBuffer())
		const headers = pesacastWebhookHeadersFrom(c.req.raw.headers)

		let authenticated = false
		if (secret && headers.signature && headers.timestamp) {
			authenticated = verifyPesacastSignature(rawBody, headers, secret)
		}
		// Fall back to bearer token when no signature was sent (e.g. desktop source).
		if (!authenticated && token) {
			const auth = c.req.raw.headers.get("authorization")
			if (auth === `Bearer ${token}`) authenticated = true
		}

		if (!authenticated) {
			return c.json({ error: "invalid signature or token" }, 401)
		}

		// Duplicate deliveries are expected (at-least-once). Claim before work.
		const deliveryId = headers.idempotencyKey
		const kv = c.env.BRAIN_KV
		const dedupKey = deliveryId ? `pesacast:evt:${deliveryId}` : null
		if (dedupKey && kv) {
			const seen = await kv.get(dedupKey).catch(() => null)
			if (seen) return c.json({ ok: true, duplicate: true })
		}

		let payload: PesaCastWebhook
		try {
			payload = PesaCastWebhookSchema.parse(
				JSON.parse(new TextDecoder().decode(rawBody)),
			)
		} catch {
			// Malformed but authenticated: acknowledge so the phone stops retrying.
			if (dedupKey && kv) {
				await kv
					.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS })
					.catch(() => {})
			}
			return c.json({ ok: true })
		}

		// Ignore test pings from the app's "Save & send test" button.
		if (payload.test) {
			if (dedupKey && kv) {
				await kv
					.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS })
					.catch(() => {})
			}
			return c.json({ ok: true, test: true })
		}

		if (dedupKey && kv) {
			await kv
				.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS })
				.catch(() => {})
		}

		// Defer the ingest to the org's Durable Object so the HTTP response
		// returns immediately and the phone doesn't retry.
		c.executionCtx.waitUntil(
			(async () => {
				try {
					const agent = await getAgentByName(
						c.env.COMPANY_BRAIN_AGENT,
						c.get("org")?.id ?? "default",
					)
					await agent.ingestPesacastTransactions({
						orgId: c.get("org")?.id ?? "default",
						deviceId: headers.deviceId ?? payload.device_id ?? null,
						source: payload.source ?? "android",
						transactions: payload.transactions,
					})
				} catch (err) {
					console.error("[pesacast-webhook] ingest turn failed:", err)
				}
			})(),
		)

		return c.json({ ok: true, count: payload.transactions.length })
	})

	// Slack slash command: /mpesa <amount> — search recent M-PESA transactions
	.post("/slack/mpesa", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const body = await c.req.parseBody()
		const text = (body.text as string) || ""

		// Parse: "/mpesa <amount>" or "/mpesa all"
		const match = text.trim().match(/^(\d[\d,.]*)$|^all$/i)
		if (!match) {
			return c.json({
				response_type: "ephemeral",
				text: "Usage: `/mpesa <amount>` — search recent M-PESA transactions\nExample: `/mpesa 5000` or `/mpesa all`",
			})
		}

		const transactions = await agent.listPesacastTransactions({
			orgId: org.id,
			limit: 10,
		})

		if (transactions.length === 0) {
			return c.json({
				response_type: "ephemeral",
				text: "No recent M-PESA transactions found.",
			})
		}

		let lines = ["*Recent M-PESA Transactions:*"]
		for (const t of transactions) {
			const emoji = t.direction === "received" ? "💵" : "💸"
			lines.push(
				`${emoji} *KES ${t.amount}* — ${t.counterparty} (${t.direction}) • ${t.ref} • ${new Date(t.time).toLocaleDateString()}`
			)
		}

		return c.json({
			response_type: "ephemeral",
			text: lines.join("\n"),
		})
	})

	// List PesaCast transactions for the current org (dashboard read path).
	.get("/pesacast/transactions", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(
			c.env.COMPANY_BRAIN_AGENT,
			org.id,
		)

		const limit = c.req.query("limit")
		const offset = c.req.query("offset")
		const direction = c.req.query("direction")
		const from = c.req.query("from")
		const to = c.req.query("to")

		const transactions = await agent.listPesacastTransactions({
			orgId: org.id,
			limit: limit ? Number(limit) : undefined,
			offset: offset ? Number(offset) : undefined,
			direction: direction || undefined,
			from: from || undefined,
			to: to || undefined,
		})

		return c.json({ ok: true, transactions })
	})

	// ── Invoice routes ──
	// Create a new eTIMS-compliant invoice (draft).
	.post("/invoices", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const body = await c.req.json()

		const id = await agent.createInvoice({
			orgId: org.id,
			customerTin: body.customerTin,
			customerName: body.customerName,
			customerMobile: body.customerMobile,
			items: body.items ?? [],
			receipt: body.receipt ?? {
				rcptPbctDt: new Date().toISOString().replace(/[-:]/g, "").slice(0, 14),
				prchrAcptcYn: "N",
			},
			totTaxblAmt: body.totTaxblAmt ?? 0,
			totTaxAmt: body.totTaxAmt ?? 0,
			totAmt: body.totAmt ?? 0,
		})

		return c.json({ ok: true, id })
	})

	// Submit an invoice to KRA eTIMS (OSCU).
	.post("/invoices/:id/etims", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const invoiceId = c.req.param("id")

		const result = await agent.submitInvoiceToETims(invoiceId)
		return c.json({ ok: true, ...result })
	})

	// Get a single invoice by ID.
	.get("/invoices/:id", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const invoiceId = c.req.param("id")

		const invoices = await agent.listInvoices({
			orgId: org.id,
			limit: 1000,
		})

		const invoice = invoices.find((i) => i.id === invoiceId)
		if (!invoice) return c.json({ error: "Invoice not found" }, 404)

		return c.json({ ok: true, invoice })
	})

	// List invoices for an org.
	.get("/invoices", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const invoices = await agent.listInvoices({
			orgId: org.id,
			status: c.req.query("status") || undefined,
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
			offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
		})

		return c.json({ ok: true, invoices })
	})

	// Match an M-PESA transaction to an open invoice.
	.post("/invoices/match", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const body = await c.req.json()

		const result = await agent.matchMpesaToInvoice({
			orgId: org.id,
			ref: body.ref,
			amount: body.amount,
			counterparty: body.counterparty ?? null,
			time: body.time,
			direction: body.direction,
		})

		return c.json({ ok: true, ...result })
	})

	// Post an eTIMS invoice to Slack with rich Block Kit formatting.
	.post("/invoices/:id/slack", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)

		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const invoiceId = c.req.param("id")
		const body = await c.req.json()

		const result = await agent.postEtimsInvoiceToSlack({
			orgId: org.id,
			invoiceId,
			channel: body.channel ?? undefined,
			threadTs: body.threadTs ?? undefined,
		})

		if (!result.ok) {
			return c.json({ ok: false, error: result.error }, 400)
		}

		return c.json({ ok: true, ts: result.ts })
	})