import { describe, expect, it, vi } from "vitest"
import { isTypeSafeConfigured, querySystemOne } from "./client"

describe("TypeSafe / Jev Client", () => {
	it("identifies whether TypeSafe is configured", () => {
		expect(isTypeSafeConfigured({} as any)).toBe(false)
		expect(isTypeSafeConfigured({ TYPESAFE_API_KEY: "" } as any)).toBe(false)
		expect(isTypeSafeConfigured({ TYPESAFE_API_KEY: "   " } as any)).toBe(false)
		expect(isTypeSafeConfigured({ TYPESAFE_API_KEY: "ts_live_123" } as any)).toBe(
			true,
		)
	})

	it("sends questions and receives typed choice answer", async () => {
		const mockResponse = {
			model: "jev-1.13.0",
			answers: {
				effect: {
					type: "choice",
					choice: "read",
					confidence: 0.95,
					probabilities: {
						read: 0.95,
						metadata: 0.05,
					},
				},
			},
			usage: {
				input_tokens: 120,
				output_tokens: 15,
			},
		}

		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		} as any)

		try {
			const res = await querySystemOne({
				apiKey: "test-api-key",
				state: "Tool call state",
				questions: {
					effect: {
						type: "choice",
						instructions: "Classify effect",
						criteria: {
							read: "Reads external data",
							metadata: "Discovers metadata",
						},
					},
				},
			})

			expect(globalThis.fetch).toHaveBeenCalledTimes(1)
			const [url, init] = (globalThis.fetch as any).mock.calls[0]
			expect(url).toBe("https://api.typesafe.ai/v1/systemone")
			expect(init.method).toBe("POST")
			expect(init.headers["Authorization"]).toBe("Bearer test-api-key")
			expect(res.answers.effect.type).toBe("choice")
			expect(res.answers.effect.choice).toBe("read")
			expect(res.answers.effect.confidence).toBe(0.95)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("throws an error when HTTP response fails", async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => "Unauthorized",
		} as any)

		try {
			await expect(
				querySystemOne({
					apiKey: "invalid-key",
					state: "Sample text",
					questions: {
						test: {
							type: "noul",
							instructions: "Is this true?",
						},
					},
				}),
			).rejects.toThrow(/HTTP 401: Unauthorized/)
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})
