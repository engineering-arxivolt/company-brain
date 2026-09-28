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

	it("reports Jev provenance with the runner-up distribution", async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				model: "jev-1.13.0",
				answers: {
					effect: {
						type: "choice",
						choice: "destructive",
						confidence: 0.82,
						probabilities: { destructive: 0.82, material_write: 0.11 },
					},
				},
			}),
		} as any)

		try {
			const classifier = createMcpApprovalClassifier({
				deps: {
					z: (await import("zod")).z,
					generateText: vi.fn(),
					getModel: vi.fn(),
					Output: { object: vi.fn() } as any,
				} as any,
				env: { TYPESAFE_API_KEY: "test-typesafe-key" } as any,
				traceId: "test-trace",
				profile: { name: "claude-haiku-4.5" } as any,
			})

			const decision = await classifier.classify({
				serverSlug: "linear",
				toolName: "delete_issue",
				description: "Delete an issue",
				inputSchema: {},
				arguments: { id: "ISS-1" },
			})

			expect(decision.provenance.source).toBe("jev")
			expect(decision.provenance.model).toBe("jev-1.13.0")
			expect(decision.provenance.confidence).toBe(0.82)
			expect(decision.provenance.alternatives).toEqual({
				destructive: 0.82,
				material_write: 0.11,
			})
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("reports llm provenance so an audit can tell Jev from a model guess", async () => {
		const classifier = createMcpApprovalClassifier({
			deps: {
				z: (await import("zod")).z,
				generateText: vi.fn().mockResolvedValue({
					output: { effect: "read", reason: "Lists issues." },
					usage: { promptTokens: 10, completionTokens: 2 },
				}),
				getModel: vi.fn(),
				Output: { object: vi.fn() } as any,
			} as any,
			env: {} as any,
			traceId: "test-trace",
			profile: { name: "claude-haiku-4.5" } as any,
		})

		const decision = await classifier.classify({
			serverSlug: "linear",
			toolName: "list_issues",
			description: "List issues",
			inputSchema: {},
			arguments: {},
		})

		expect(decision.provenance).toEqual({
			source: "llm",
			model: "claude-haiku-4.5",
		})
	})

	it("reports unavailable provenance when no decider answered", async () => {
		const classifier = createMcpApprovalClassifier({
			deps: {
				z: (await import("zod")).z,
				generateText: vi.fn().mockRejectedValue(new Error("model down")),
				getModel: vi.fn(),
				Output: { object: vi.fn() } as any,
			} as any,
			env: {} as any,
			traceId: "test-trace",
			profile: { name: "claude-haiku-4.5" } as any,
		})

		const decision = await classifier.classify({
			serverSlug: "linear",
			toolName: "delete_issue",
			description: "Delete an issue",
			inputSchema: {},
			arguments: {},
		})

		expect(decision.effect).toBe("unknown")
		expect(decision.provenance.source).toBe("unavailable")
	})

	it("does not reclassify a repeated call", async () => {
		const originalFetch = globalThis.fetch
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				model: "jev-1.13.0",
				answers: {
					effect: {
						type: "choice",
						choice: "read",
						confidence: 0.9,
						probabilities: { read: 0.9 },
					},
				},
			}),
		} as any)
		globalThis.fetch = fetchMock

		try {
			const classifier = createMcpApprovalClassifier({
				deps: {
					z: (await import("zod")).z,
					generateText: vi.fn(),
					getModel: vi.fn(),
					Output: { object: vi.fn() } as any,
				} as any,
				env: { TYPESAFE_API_KEY: "test-typesafe-key" } as any,
				traceId: "test-trace",
				profile: { name: "claude-haiku-4.5" } as any,
			})
			const input = {
				serverSlug: "linear",
				toolName: "delete_issue",
				description: "Delete an issue",
				inputSchema: {},
				arguments: { id: "ISS-1" },
			}

			await classifier.classify(input)
			await classifier.classify(input)

			expect(fetchMock).toHaveBeenCalledTimes(1)
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})
