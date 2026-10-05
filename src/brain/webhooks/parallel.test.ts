import { describe, expect, it } from "vitest"
import {
	type ParallelRouteMetadata,
	parallelDeliveryShouldPost,
	resolveParallelDelivery,
} from "./parallel"

const ROUTE: ParallelRouteMetadata = {
	orgId: "org_1",
	teamId: "T01",
	channelId: "C01",
	threadTs: "1699999999.000100",
}

// Built explicitly rather than via a default parameter: `metadata = ROUTE`
// would fire when the test passes undefined, which is exactly the case meant to
// represent "Parallel sent no metadata at all".
function detected(metadata?: unknown) {
	return {
		type: "monitor.event.detected",
		timestamp: "2025-10-27T14:56:05.619331Z",
		data: {
			monitor_id: "monitor_0c9d7f7d5a7841a0b6c269b2b9b1e6aa",
			event: { event_group_id: "mevtgrp_b0079f70195e4258" },
			metadata,
		},
	}
}

describe("resolveParallelDelivery", () => {
	it("extracts routing metadata so the reply lands in the asking channel", () => {
		const d = resolveParallelDelivery(detected(ROUTE))
		expect(d?.route).toEqual(ROUTE)
		expect(d?.monitorId).toBe("monitor_0c9d7f7d5a7841a0b6c269b2b9b1e6aa")
		expect(d?.eventGroupId).toBe("mevtgrp_b0079f70195e4258")
	})

	it("keeps a routable delivery even when metadata is absent", () => {
		// Still valid: the route returns 2xx either way, this just cannot post.
		const d = resolveParallelDelivery(detected(undefined))
		expect(d).not.toBeNull()
		expect(d?.route).toBeUndefined()
		expect(d?.type).toBe("monitor.event.detected")
	})

	it("rejects metadata that is missing a field rather than posting somewhere wrong", () => {
		const d = resolveParallelDelivery(detected({ orgId: "org_1", teamId: "T01" }))
		expect(d?.route).toBeUndefined()
	})

	it("ignores unexpected extra metadata keys", () => {
		const d = resolveParallelDelivery(detected({ ...ROUTE, extra: "fine" }))
		expect(d?.route).toEqual(ROUTE)
	})

	it("returns null for an unknown event type", () => {
		expect(resolveParallelDelivery({ type: "monitor.event.exploded" })).toBeNull()
	})

	it("returns null for a non-object payload", () => {
		expect(resolveParallelDelivery("not json")).toBeNull()
		expect(resolveParallelDelivery(null)).toBeNull()
		expect(resolveParallelDelivery({})).toBeNull()
	})

	it("surfaces the error text on a failed execution", () => {
		const d = resolveParallelDelivery({
			type: "monitor.execution.failed",
			data: {
				monitor_id: "monitor_x",
				event: { type: "error", error: "Error occurred while processing" },
				metadata: ROUTE,
			},
		})
		expect(d?.error).toBe("Error occurred while processing")
	})
})

describe("parallelDeliveryShouldPost", () => {
	it("posts only on a detected event", () => {
		expect(
			parallelDeliveryShouldPost(resolveParallelDelivery(detected(ROUTE))!),
		).toBe(true)
	})

	it("stays silent when a run completed with nothing to report", () => {
		// The load-bearing rule: "nothing changed" must never become a message.
		const d = resolveParallelDelivery({
			type: "monitor.execution.completed",
			data: { monitor_id: "monitor_x", metadata: ROUTE },
		})
		expect(parallelDeliveryShouldPost(d!)).toBe(false)
	})

	it("stays silent on a detected event we cannot route", () => {
		expect(
			parallelDeliveryShouldPost(resolveParallelDelivery(detected(undefined))!),
		).toBe(false)
	})

	it("stays silent on a failed execution", () => {
		const d = resolveParallelDelivery({
			type: "monitor.execution.failed",
			data: { monitor_id: "m", metadata: ROUTE },
		})
		expect(parallelDeliveryShouldPost(d!)).toBe(false)
	})

	it("narrows the delivery to a postable one, with a route that is not optional", () => {
		// The guard is a type predicate, so a caller that passes it is entitled to
		// a literal event type and a non-optional route. This is the invariant the
		// webhook route depends on when it builds the turn, and it is invisible to
		// a plain boolean guard, which is why the predicate exists.
		const delivery = resolveParallelDelivery(detected(ROUTE))!
		if (!parallelDeliveryShouldPost(delivery)) {
			throw new Error("expected the delivery to be postable")
		}

		// Compile-time assertions: these fail `tsc --noEmit` if the narrowing is lost.
		const type: "monitor.event.detected" = delivery.type
		const route: ParallelRouteMetadata = delivery.route
		expect(type).toBe("monitor.event.detected")
		expect(route.teamId).toBe("T01")
	})
})