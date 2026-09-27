import { describe, expect, it } from "vitest"
import { summarizeContext, summarizeError } from "./error-summary"

const retryError = {
	name: "AI_RetryError",
	message: "Failed after 3 attempts. Last error: Rate limit exceeded",
	reason: "maxRetriesExceeded",
	errors: [
		{ name: "AI_APICallError", message: "Rate limit exceeded", statusCode: 429 },
		{ name: "AI_APICallError", message: "Rate limit exceeded", statusCode: 429 },
		{
			name: "AI_APICallError",
			message: "Rate limit exceeded",
			statusCode: 429,
			url: "https://openrouter.ai/api/v1/chat/completions",
			isRetryable: true,
		},
	],
	lastError: {
		name: "AI_APICallError",
		message: "Rate limit exceeded",
		statusCode: 429,
		isRetryable: true,
	},
}

describe("summarizeError", () => {
	it("reads the provider status out of a retry wrapper", () => {
		const summary = summarizeError(retryError)

		expect(summary).toContain("AI_RetryError")
		expect(summary).toContain("reason=maxRetriesExceeded")
		expect(summary).toContain("attempts=3")
		expect(summary).toContain("status=429")
		expect(summary).toContain("retryable=true")
	})

	it("follows the cause chain on a plain Error", () => {
		const error = new Error("outer", { cause: new Error("inner") })

		expect(summarizeError(error)).toBe("Error: outer | Error: inner")
	})

	it("keeps a plain Error readable", () => {
		expect(summarizeError(new Error("boom"))).toBe("Error: boom")
	})

	it("scrubs provider keys", () => {
		const summary = summarizeError(
			new Error("auth failed for sk-or-v1-abcdefghijklmnopqrstuvwxyz"),
		)

		expect(summary).toContain("auth failed")
		expect(summary).not.toContain("sk-or-v1-abcdefghijklmnopqrstuvwxyz")
	})

	it("stays one line and bounded", () => {
		const summary = summarizeError(new Error("a\n\tb  ".repeat(200)), 60)

		expect(summary.length).toBeLessThanOrEqual(60)
		expect(summary).not.toContain("\n")
	})

	it("names a failure that carries no message", () => {
		expect(summarizeError(undefined)).toBe("unknown error")
		expect(summarizeError(new Error(""))).toBe("Error")
	})
})

describe("summarizeContext", () => {
	it("keeps the call site's fields and redacts secret keys", () => {
		const summary = summarizeContext({
			channel: "C123",
			threadTs: "1700000000.000100",
			apiKey: "sk-live-abcdefghijklmnopqrstuv",
		})

		expect(summary).toContain("channel")
		expect(summary).toContain("C123")
		expect(summary).toContain("[redacted]")
		expect(summary).not.toContain("sk-live-abcdefghijklmnopqrstuv")
	})

	it("stays silent when there is nothing to add", () => {
		expect(summarizeContext(undefined)).toBeUndefined()
		expect(summarizeContext({})).toBeUndefined()
	})
})
