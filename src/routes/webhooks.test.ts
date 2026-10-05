import { createHmac } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The Durable Object lookup is the one thing in this route that cannot run in
// a test process, so it is mocked; every other dependency (signature
// verification, payload resolution, KV dedup) is the real code under test.
const { getAgentByName } = vi.hoisted(() => ({
	getAgentByName: vi.fn(),
}))

vi.mock("agents", () => ({ getAgentByName }))

import { webhookRoutes } from "./webhooks"
import { decodeStandardWebhookSecret } from "@/lib/brain/webhooks/standard-webhooks"

// "whsec_" + base64("super-secret-key"), the shape Parallel hands out.
const SECRET = `whsec_${Buffer.from("super-secret-key").toString("base64")}`
// The replay window is checked against the wall clock, so a fixed timestamp
// would start failing on its own a few minutes after this file was written.
const NOW = Math.floor(Date.now() / 1000)
const DEFAULT_ID = "whevent_abc123def456"
const ROUTE = {
	orgId: "org_1",
	teamId: "T01",
	channelId: "C01",
	threadTs: "1699999999.000100",
}

/**
 * A payload Parallel sends when a monitor detects something.
 *
 * `metadata` is passed through rather than defaulted, because the case this
 * file needs to express is "Parallel sent no metadata at all" -- which a
 * default parameter would silently turn back into a routable delivery.
 */
function detectedBody(metadata?: unknown): string {
	return JSON.stringify({
		type: "monitor.event.detected",
		timestamp: "2025-10-27T14:56:05.619331Z",
		data: {
			monitor_id: "monitor_abc",
			event: { event_group_id: "mevtgrp_1" },
			...(metadata === undefined ? {} : { metadata }),
		},
	})
}

/** The normal case: a delivery stamped with the asking surface. */
function routableBody(): string {
	return detectedBody(ROUTE)
}

/** Sign the exact bytes that will be sent, the way Parallel does. */
function signRequest(body: string, args?: { id?: string; timestamp?: number }) {
	const id = args?.id ?? DEFAULT_ID
	const timestamp = String(args?.timestamp ?? NOW)
	const signature = `v1,${createHmac("sha256", decodeStandardWebhookSecret(SECRET))
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64")}`
	return {
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": signature,
	}
}

/** Map-backed KV stand-in: enough surface for the dedup read and claim. */
function fakeKv() {
	const store = new Map<string, string>()
	return {
		store,
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
	}
}

type PostArgs = {
	/** Omit the env binding entirely, to exercise the unconfigured path. */
	noSecret?: boolean
	id?: string
	timestamp?: number
	/** Send delivery headers with no signature at all. */
	sign?: boolean
	kv?: ReturnType<typeof fakeKv>
}

/**
 * POST /parallel and settle every deferred turn before returning, so an
 * assertion can see what the turn actually did.
 *
 * The route is mounted directly here, so the path carries no `/brain` prefix;
 * in the worker it is reached as POST /brain/webhooks/parallel.
 */
async function post(body: string, args?: PostArgs) {
	const kv = args?.kv ?? fakeKv()
	const pending: Promise<unknown>[] = []
	const env = {
		PARALLEL_WEBHOOK_SECRET: args?.noSecret ? undefined : SECRET,
		BRAIN_KV: kv,
		COMPANY_BRAIN_AGENT: {},
	} as unknown as Env

	const headers =
		args?.sign === false
			? { "webhook-id": args.id ?? DEFAULT_ID }
			: signRequest(body, { id: args?.id, timestamp: args?.timestamp })

	const res = await webhookRoutes.request(
		"/parallel",
		{
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		},
		env,
		{ waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
	)
	await Promise.all(pending)
	return { res, pending, kv, env }
}

/** POST with fully custom headers, for the signature-forgery case. */
async function postWithHeaders(
	body: string,
	headers: Record<string, string>,
	kv = fakeKv(),
) {
	const pending: Promise<unknown>[] = []
	const res = await webhookRoutes.request(
		"/parallel",
		{
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		},
		{
			PARALLEL_WEBHOOK_SECRET: SECRET,
			BRAIN_KV: kv,
			COMPANY_BRAIN_AGENT: {},
		} as unknown as Env,
		{ waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
	)
	return { res, pending, kv }
}
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	getAgentByName.mockReset()
	getAgentByName.mockResolvedValue({
		onParallelMonitorEvent: vi.fn(async () => {}),
	})
	consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("POST /brain/webhooks/parallel — configuration", () => {
	it("answers 501 when no signing secret is configured", async () => {
		const { res, kv } = await post(routableBody(), { noSecret: true })

		expect(res.status).toBe(501)
		expect(await res.json()).toEqual({ error: "webhooks are not configured" })
		expect(getAgentByName).not.toHaveBeenCalled()
		expect(kv.put).not.toHaveBeenCalled()
	})
})

describe("POST /brain/webhooks/parallel — authentication", () => {
	it("rejects a forged signature and never looks up an agent", async () => {
		// Headers sign a different body than the one actually sent.
		const kv = fakeKv()
		const { res, pending } = await postWithHeaders(
			routableBody(),
			signRequest("a completely different body"),
			kv,
		)

		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({ error: "invalid signature" })
		expect(getAgentByName).not.toHaveBeenCalled()
		expect(pending).toHaveLength(0)
		// A rejected delivery must not be marked seen: doing so would let an
		// unauthenticated replay of a later, correctly-signed delivery be
		// swallowed as a duplicate.
		expect(kv.put).not.toHaveBeenCalled()
	})

	it("rejects a genuine delivery replayed outside the window", async () => {
		const { res } = await post(routableBody(), { timestamp: NOW - 60 * 6 })

		expect(res.status).toBe(401)
		expect(getAgentByName).not.toHaveBeenCalled()
	})

	it("rejects an unsigned delivery", async () => {
		const { res } = await post(routableBody(), { sign: false })

		expect(res.status).toBe(401)
		expect(getAgentByName).not.toHaveBeenCalled()
	})
})
describe("POST /brain/webhooks/parallel — acknowledgement", () => {
	// Parallel retries for 48h with exponential backoff. Every authenticated
	// delivery whose fate is already decided must answer 2xx, or a non-2xx here
	// is what causes the retry storm.
	it("acknowledges malformed JSON that was correctly signed", async () => {
		const { res, kv } = await post("{not json at all")

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(getAgentByName).not.toHaveBeenCalled()
		// Note what does NOT happen: the parse-failure branch returns before the
		// dedup claim, so this delivery id is never written. Parallel will
		// re-send these exact bytes until the window closes. That is harmless
		// (no turn ever runs) and matches the `completed`/`failed` handling
		// below, which does claim -- so the two are deliberately not asserted
		// to match here.
		expect(kv.put).not.toHaveBeenCalled()
	})

	it("acknowledges an unknown event type", async () => {
		const { res, kv } = await post(
			JSON.stringify({ type: "monitor.execution.exploded" }),
		)

		expect(res.status).toBe(200)
		expect(getAgentByName).not.toHaveBeenCalled()
		expect(kv.store.size).toBe(1)
	})

	it("stays silent on a completed run that found nothing", async () => {
		// The load-bearing anti-mute rule: "nothing changed" must never post.
		const { res, kv } = await post(
			JSON.stringify({
				type: "monitor.execution.completed",
				data: { monitor_id: "monitor_abc", metadata: ROUTE },
			}),
		)

		expect(res.status).toBe(200)
		expect(getAgentByName).not.toHaveBeenCalled()
		expect(kv.store.size).toBe(1)
	})

	it("stays silent on a failed execution", async () => {
		const { res } = await post(
			JSON.stringify({
				type: "monitor.execution.failed",
				data: {
					monitor_id: "monitor_abc",
					event: { type: "error", error: "boom" },
					metadata: ROUTE,
				},
			}),
		)

		expect(res.status).toBe(200)
		expect(getAgentByName).not.toHaveBeenCalled()
	})

	it("stays silent on a detected event carrying no routing metadata", async () => {
		const { res } = await post(detectedBody(undefined))

		expect(res.status).toBe(200)
		expect(getAgentByName).not.toHaveBeenCalled()
	})

	it("stays silent when metadata is missing a required field", async () => {
		// orgId + teamId but no channelId. Posting here would mean posting to
		// an arbitrary channel, so the delivery is acknowledged and dropped.
		const { res } = await post(detectedBody({ orgId: "org_1", teamId: "T01" }))

		expect(res.status).toBe(200)
		expect(getAgentByName).not.toHaveBeenCalled()
	})
})
describe("POST /brain/webhooks/parallel — delivery", () => {
	it("routes a detected event to the org that asked for the monitor", async () => {
		const onParallelMonitorEvent = vi.fn(async () => {})
		getAgentByName.mockResolvedValue({ onParallelMonitorEvent })

		const { res, kv } = await post(routableBody())

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(getAgentByName).toHaveBeenCalledTimes(1)
		expect(getAgentByName.mock.calls[0]?.[1]).toBe(ROUTE.orgId)
		expect(onParallelMonitorEvent).toHaveBeenCalledWith({
			type: "monitor.event.detected",
			monitorId: "monitor_abc",
			eventGroupId: "mevtgrp_1",
			teamId: ROUTE.teamId,
			channelId: ROUTE.channelId,
			threadTs: ROUTE.threadTs,
		})
		expect(kv.store.size).toBe(1)
	})

	it("defers the turn through waitUntil rather than awaiting it", async () => {
		// The response must not block on a multi-minute agentic turn.
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		getAgentByName.mockResolvedValue({
			onParallelMonitorEvent: vi.fn(async () => {
				await gate
			}),
		})

		const body = routableBody()
		const { res, pending } = await postWithHeaders(body, signRequest(body))

		expect(res.status).toBe(200)
		expect(pending).toHaveLength(1)
		release()
		await Promise.all(pending)
	})

	it("answers 200 even when the turn throws", async () => {
		// The delivery is already acknowledged. A turn failure is logged, never
		// surfaced: a 5xx would buy nothing but two days of retries.
		getAgentByName.mockResolvedValue({
			onParallelMonitorEvent: vi.fn(async () => {
				throw new Error("agent is down")
			}),
		})

		const { res } = await post(routableBody())

		expect(res.status).toBe(200)
		expect(consoleError).toHaveBeenCalledWith(
			"[parallel-webhook] turn failed:",
			expect.any(Error),
		)
	})

	it("claims the delivery before the turn starts, not after", async () => {
		// A retry arriving mid-turn must find the key already written, or it
		// starts a second turn and the team gets two messages.
		const kv = fakeKv()
		const seenAtTurnTime: (string | undefined)[] = []
		getAgentByName.mockResolvedValue({
			onParallelMonitorEvent: vi.fn(async () => {
				seenAtTurnTime.push(kv.store.get(`parallel:evt:${DEFAULT_ID}`))
			}),
		})

		await post(routableBody(), { kv })

		expect(seenAtTurnTime).toEqual(["1"])
	})
})

describe("POST /brain/webhooks/parallel — deduplication", () => {
	it("runs the turn once for a repeated delivery id", async () => {
		const onParallelMonitorEvent = vi.fn(async () => {})
		getAgentByName.mockResolvedValue({ onParallelMonitorEvent })

		const kv = fakeKv()
		const first = await post(routableBody(), { kv, id: "whevent_dupe" })
		const second = await post(routableBody(), { kv, id: "whevent_dupe" })

		expect(first.res.status).toBe(200)
		expect(await second.res.json()).toEqual({ ok: true, duplicate: true })
		expect(onParallelMonitorEvent).toHaveBeenCalledTimes(1)
	})

	it("treats distinct delivery ids as distinct deliveries", async () => {
		const onParallelMonitorEvent = vi.fn(async () => {})
		getAgentByName.mockResolvedValue({ onParallelMonitorEvent })

		const kv = fakeKv()
		await post(routableBody(), { kv, id: "whevent_a" })
		await post(routableBody(), { kv, id: "whevent_b" })

		expect(onParallelMonitorEvent).toHaveBeenCalledTimes(2)
	})

	it("verifies the signature before honouring a duplicate", async () => {
		// Verification runs first, so an unauthenticated replay of a seen id is
		// refused rather than confirmed back to the caller as a known delivery.
		const kv = fakeKv()
		await post(routableBody(), { kv, id: "whevent_dupe" })
		getAgentByName.mockClear()

		const replay = await post(routableBody(), { kv, id: "whevent_dupe", sign: false })

		expect(replay.res.status).toBe(401)
		expect(getAgentByName).not.toHaveBeenCalled()
	})
})
