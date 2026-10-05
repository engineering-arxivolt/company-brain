import { afterEach, describe, expect, it, vi } from "vitest"
import {
	assertRoutableMetadata,
	createParallelMonitor,
	fetchParallelMonitorEvents,
	formatParallelEventsForTurn,
	type ParallelRouteMetadata,
} from "./parallel"

const ROUTE = {
	orgId: "org_1",
	teamId: "T01",
	channelId: "C01",
	threadTs: "1699999999.000100",
}

// The fetch boundary and the pure renderer are covered here; the delivery
// decision itself lives in turn/parallel-monitor.ts, where importing the agent
// would drag the Cloudflare runtime into the test process.

const originalFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		// createParallelMonitor reads the raw body for its error message.
		text: async () => JSON.stringify(body),
	}
}

/** The `[input, init]` pair a single fetch call was made with. */
type FetchCall = [input: RequestInfo | URL, init?: RequestInit]

/**
 * Install a `fetch` stub and hand it back so its calls can be inspected.
 *
 * Two things this buys over a bare `vi.fn(async () => ...)`:
 *
 *  - The explicit parameter list stops the mock inferring a zero-argument
 *    signature, which made `mock.calls[0]` an empty tuple that could not be
 *    destructured at all.
 *  - `fetchCall` fails loudly when the code under test never called `fetch`,
 *    instead of destructuring `undefined` and reporting a confusing downstream
 *    mismatch. A stub that is never called is a real regression, not a setup
 *    detail to paper over.
 */
function stubFetch(
	respond: (input: RequestInfo | URL, init?: RequestInit) => unknown,
) {
	// The stub answers with a hand-rolled object rather than a real `Response`,
	// so the return is asserted rather than reconstructed.
	const mock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) =>
			respond(input, init) as Response,
	)
	globalThis.fetch = mock as unknown as typeof fetch
	return mock
}

/** The arguments of the first (and expected only) fetch call. */
function fetchCall(mock: ReturnType<typeof stubFetch>): FetchCall {
	const call = mock.mock.calls[0]
	if (!call) throw new Error("expected fetch to have been called once")
	return call as FetchCall
}

describe("fetchParallelMonitorEvents", () => {
	it("scopes the query to the delivered execution", async () => {
		const fetchMock = stubFetch(() => jsonResponse({ events: [{ event_id: "evt_1" }] }))

		const events = await fetchParallelMonitorEvents({
			apiKey: "key",
			monitorId: "monitor_1",
			eventGroupId: "mevtgrp_1",
		})

		expect(events).toEqual([{ event_id: "evt_1" }])
		const [url, init] = fetchCall(fetchMock)
		expect(String(url)).toContain("/v1/monitors/monitor_1/events")
		expect(String(url)).toContain("event_group_id=mevtgrp_1")
		expect(init?.headers).toMatchObject({ "x-api-key": "key" })
	})

	it("encodes a monitor id that would otherwise alter the path", async () => {
		const fetchMock = stubFetch(() => jsonResponse({ events: [] }))

		await fetchParallelMonitorEvents({
			apiKey: "key",
			monitorId: "monitor/../../admin",
		})

		const [url] = fetchCall(fetchMock)
		expect(String(url)).toContain("monitor%2F..%2F..%2Fadmin")
		expect(String(url)).not.toContain("/v1/monitors/admin")
	})

	it("returns null instead of throwing on an API error", async () => {
		stubFetch(() => jsonResponse({ message: "nope" }, 500))

		// The delivery is already acknowledged, so a fetch failure must degrade
		// to saying less rather than surfacing an error back to Parallel.
		expect(
			await fetchParallelMonitorEvents({ apiKey: "key", monitorId: "m" }),
		).toBeNull()
	})

	it("returns null on a malformed body rather than trusting it", async () => {
		stubFetch(() => jsonResponse({ events: "not-an-array" }))

		expect(
			await fetchParallelMonitorEvents({ apiKey: "key", monitorId: "m" }),
		).toBeNull()
	})

	it("returns null when the network throws", async () => {
		stubFetch(() => {
			throw new Error("offline")
		})

		expect(
			await fetchParallelMonitorEvents({ apiKey: "key", monitorId: "m" }),
		).toBeNull()
	})
})

describe("formatParallelEventsForTurn", () => {
	it("renders content and its citations", () => {
		const out = formatParallelEventsForTurn([
			{
				event_id: "evt_1",
				output: {
					content: "Acme cut pricing by 20%.",
					basis: [
						{
							field: "pricing",
							reasoning: "compared to last month",
							citations: [
								{
									title: "Acme pricing",
									url: "https://acme.example/pricing",
									excerpts: ["Now 20% lower."],
								},
							],
						},
					],
				},
			},
		])

		expect(out).toContain("Acme cut pricing by 20%.")
		expect(out).toContain("https://acme.example/pricing")
		expect(out).toContain("Now 20% lower.")
	})

	it("skips completion events that carry no content", () => {
		// A detected run and its completion marker can share an event group.
		expect(
			formatParallelEventsForTurn([
				{ event_id: "c1", output: { content: null } },
				{ event_id: "c2" },
			]),
		).toBeNull()
	})

	it("drops citations without a url, which cannot be verified or linked", () => {
		const out = formatParallelEventsForTurn([
			{
				output: {
					content: "Something changed.",
					basis: [
						{ citations: [{ title: "Nameless source", url: null }] },
					],
				},
			},
		])

		expect(out).toContain("Something changed.")
		expect(out).not.toContain("Nameless source")
	})

	it("bounds the content it will put in front of the model", () => {
		const out = formatParallelEventsForTurn([
			{ output: { content: "x".repeat(50_000) } },
		])

		expect(out).not.toBeNull()
		expect((out ?? "").length).toBeLessThan(15_000)
	})
})
describe("assertRoutableMetadata", () => {
	it("accepts the route we actually send", () => {
		expect(() => assertRoutableMetadata(ROUTE)).not.toThrow()
	})

	it("rejects an oversized key before it becomes a 422 at creation time", () => {
		// Built as a loose record and cast, because the whole point is a key that
		// `ParallelRouteMetadata` does not declare: the runtime guard must catch
		// an unexpected key, which a well-typed literal could never express.
		const oversized = {
			...ROUTE,
			channelIdentifier: "C01",
		} as unknown as ParallelRouteMetadata
		expect(() => assertRoutableMetadata(oversized)).toThrow(/limit is 16/)
	})

	it("rejects an oversized value", () => {
		expect(() =>
			assertRoutableMetadata({ ...ROUTE, threadTs: "9".repeat(600) }),
		).toThrow(/limit is 512/)
	})
})

describe("createParallelMonitor", () => {
	const base = {
		apiKey: "key",
		webhookUrl: "https://brain.example/brain/webhooks/parallel",
		query: "Acme pricing changes",
		frequency: "1d",
		route: ROUTE,
	}

	it("registers the webhook with the routing metadata", async () => {
		const fetchMock = stubFetch(() =>
			jsonResponse({ monitor_id: "monitor_abc", status: "active" }, 201),
		)

		const id = await createParallelMonitor(base)

		expect(id).toBe("monitor_abc")
		const [url, init] = fetchCall(fetchMock)
		expect(String(url)).toBe("https://api.parallel.ai/v1/monitors")
		expect(init?.method).toBe("POST")
		const body = JSON.parse(init?.body as string)
		expect(body.type).toBe("event_stream")
		expect(body.webhook.url).toBe(base.webhookUrl)
		// Only `detected` is needed to post; subscribing to the rest would be
		// noise even though the receiver already filters.
		expect(body.webhook.event_types).toEqual(["monitor.event.detected"])
		expect(body.metadata).toEqual(ROUTE)
	})

	it("clamps a frequency Parallel would reject", async () => {
		const fetchMock = stubFetch(() => jsonResponse({ monitor_id: "m" }, 201))

		await createParallelMonitor({ ...base, frequency: "90d" })

		const [, init] = fetchCall(fetchMock)
		expect(JSON.parse(init?.body as string).frequency).toBe("30d")
	})

	it("falls back to a valid default for an unparseable frequency", async () => {
		const fetchMock = stubFetch(() => jsonResponse({ monitor_id: "m" }, 201))

		await createParallelMonitor({ ...base, frequency: "every day" })

		const [, init] = fetchCall(fetchMock)
		expect(JSON.parse(init?.body as string).frequency).toBe("1d")
	})

	it("throws rather than reporting success it cannot back", async () => {
		stubFetch(() => jsonResponse({ message: "bad request" }, 422))

		await expect(createParallelMonitor(base)).rejects.toThrow(/HTTP 422/)
	})

	it("throws when the response carries no monitor_id", async () => {
		stubFetch(() => jsonResponse({ type: "event_stream" }, 201))

		await expect(createParallelMonitor(base)).rejects.toThrow(/no monitor_id/)
	})
})
