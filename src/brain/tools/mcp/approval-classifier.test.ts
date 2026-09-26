import { describe, expect, it, vi } from "vitest"
import { createMcpApprovalClassifier } from "./approval-classifier"

describe("createMcpApprovalClassifier with Jev", () => {
	it("classifies an operation via Jev when TYPESAFE_API_KEY is configured", async () => {
		const mockJevResponse = {
			model: "jev-1.13.0",
			answers: {
				effect: {
					type: "choice",
					choice: "read",
					confidence: 0.99,
					probabilities: {
						read: 0.99,
						metadata: 0.01,
					},
				},
			},
			usage: {
				input_tokens: 150,
				output_tokens: 20,
			},
		}

		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockJevResponse,
		} as any)

		const generateText = vi.fn()

		try {
			const classifier = createMcpApprovalClassifier({
				deps: {
					z: (await import("zod")).z,
					generateText,
					getModel: vi.fn(),
					Output: { object: vi.fn() } as any,
				} as any,
				env: {
					TYPESAFE_API_KEY: "test-typesafe-key",
				} as any,
				traceId: "test-trace",
				profile: { name: "claude-haiku-4.5" } as any,
			})

			const decision = await classifier.classify({
				serverSlug: "linear",
				toolName: "search_issues",
				description: "Search team issues",
				inputSchema: {},
				arguments: { query: "bug in login" },
			})

			expect(globalThis.fetch).toHaveBeenCalledTimes(1)
			const [url, init] = (globalThis.fetch as any).mock.calls[0]
			expect(url).toBe("https://api.typesafe.ai/v1/systemone")
			expect(init.headers["Authorization"]).toBe("Bearer test-typesafe-key")
			expect(decision.effect).toBe("read")
			expect(decision.reason).toContain("System 1 model (confidence: 99%)")
			// Standard LLM should NOT have been called because Jev succeeded
			expect(generateText).not.toHaveBeenCalled()
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("falls back to standard LLM when TYPESAFE_API_KEY is unset", async () => {
		const generateText = vi.fn().mockResolvedValue({
			output: {
				effect: "material_write",
				reason: "Creates a new issue in Linear.",
			},
			usage: { promptTokens: 100, completionTokens: 20 },
		})

		const classifier = createMcpApprovalClassifier({
			deps: {
				z: (await import("zod")).z,
				generateText,
				getModel: vi.fn(),
				Output: { object: vi.fn() } as any,
			} as any,
			env: {} as any,
			traceId: "test-trace",
			profile: { name: "claude-haiku-4.5" } as any,
		})

		const decision = await classifier.classify({
			serverSlug: "linear",
			toolName: "create_issue",
			description: "Create an issue in Linear",
			inputSchema: {},
			arguments: { title: "New bug" },
		})

		expect(generateText).toHaveBeenCalledTimes(1)
		expect(decision.effect).toBe("material_write")
	})
})
