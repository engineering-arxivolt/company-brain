import { describe, expect, it } from "vitest"
import {
	callWithTransientRetry,
	isTransientUpstreamError,
} from "./transient-retry"

describe("isTransientUpstreamError", () => {
	it("treats a gateway failure as transient", () => {
		expect(isTransientUpstreamError(new Error("502 Bad Gateway"))).toBe(true)
		expect(isTransientUpstreamError(new Error("503 Service Unavailable"))).toBe(
			true,
		)
		expect(isTransientUpstreamError(new Error("Request timed out"))).toBe(true)
		expect(isTransientUpstreamError(new Error("socket hang up"))).toBe(true)
	})

	it("does not treat a rejected call as transient", () => {
		// A 401 is a credential problem and a 400 is a wrong argument: both
		// need a different fix, and retrying them only spends the call budget.
		expect(isTransientUpstreamError(new Error("401 Unauthorized"))).toBe(false)
		expect(isTransientUpstreamError(new Error("400 Bad Request"))).toBe(false)
		expect(isTransientUpstreamError(new Error("404 Not Found"))).toBe(false)
		expect(isTransientUpstreamError(new Error("429 Too Many Requests"))).toBe(
			false,
		)
	})
})

describe("callWithTransientRetry", () => {
	it("retries a read that failed on a blip", async () => {
		let calls = 0
		const result = await callWithTransientRetry(
			async () => {
				calls++
				if (calls === 1) throw new Error("503 Service Unavailable")
				return "ok"
			},
			{ readOnly: true },
		)
		expect(result).toBe("ok")
		expect(calls).toBe(2)
	})

	it("does not retry a write that failed on a blip", async () => {
		// A write that failed halfway may already have taken effect, and
		// repeating it could duplicate a side effect nobody asked for twice.
		let calls = 0
		await expect(
			callWithTransientRetry(
				async () => {
					calls++
					throw new Error("503 Service Unavailable")
				},
				{ readOnly: false },
			),
		).rejects.toThrow(/503/)
		expect(calls).toBe(1)
	})

	it("does not retry a call that was rejected on its merits", async () => {
		let calls = 0
		await expect(
			callWithTransientRetry(
				async () => {
					calls++
					throw new Error("400 Bad Request: unknown field")
				},
				{ readOnly: true },
			),
		).rejects.toThrow(/400/)
		expect(calls).toBe(1)
	})

	it("reports the upstream's own error after a failed retry", async () => {
		await expect(
			callWithTransientRetry(async () => {
				throw new Error("502 Bad Gateway")
			}, { readOnly: true }),
		).rejects.toThrow(/502 Bad Gateway/)
	})
})
