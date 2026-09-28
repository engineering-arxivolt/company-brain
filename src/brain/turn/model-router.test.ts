import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { routeModelTier, getHeuristicModelForTask } from "./model-router"

const mockEnv = {
	TYPESAFE_API_KEY: "test-key",
	OPENAI_API_KEY: "sk-or-test",
	OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
} as unknown as Env

const originalFetch = globalThis.fetch

describe("model-router", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("heuristic picks fast for simple task", () => {
		const model = getHeuristicModelForTask(mockEnv, "what is 2+2?")
		expect(model).toBeDefined()
		console.log("Simple task ->", model)
	})

	it("heuristic picks balanced for analysis task", () => {
		const model = getHeuristicModelForTask(mockEnv, "analyze this code and debug the issue")
		expect(model).toBeDefined()
		console.log("Analysis task ->", model)
	})

	it("heuristic picks strong for research task", () => {
		const model = getHeuristicModelForTask(mockEnv, "comprehensive research on competitors and market analysis")
		expect(model).toBeDefined()
		console.log("Research task ->", model)
	})

	it("heuristic picks fast for classification task", () => {
		const model = getHeuristicModelForTask(mockEnv, "classify this message as spam or not spam")
		expect(model).toBeDefined()
		console.log("Classification task ->", model)
	})

	it("JEV routes simple classification to fast tier", async () => {
		;(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			json: async () => ({
				model: "jev-1.13.0",
				answers: {
					tier: {
						type: "choice",
						choice: "fast",
						confidence: 0.95,
						probabilities: { fast: 0.95, balanced: 0.05 },
					},
				},
			}),
		})

		const tier = await routeModelTier(mockEnv, "Classify this as spam or ham", undefined, "test-trace")
		expect(tier).toBe("fast")
	})

	it("JEV routes complex research to strong tier", async () => {
		;(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			json: async () => ({
				model: "jev-1.13.0",
				answers: {
					tier: {
						type: "choice",
						choice: "strong",
						confidence: 0.88,
						probabilities: { strong: 0.88, balanced: 0.12 },
					},
				},
			}),
		})

		const tier = await routeModelTier(mockEnv, "Deep dive into competitor pricing strategies across 50 companies", undefined, "test-trace")
		expect(tier).toBe("strong")
	})

	it("JEV falls back to balanced on low confidence", async () => {
		;(globalThis.fetch as any).mockResolvedValue({
			ok: true,
			json: async () => ({
				model: "jev-1.13.0",
				answers: {
					tier: {
						type: "choice",
						choice: "strong",
						confidence: 0.5, // Below 0.7 threshold
						probabilities: { strong: 0.5, balanced: 0.5 },
					},
				},
			}),
		})

		const tier = await routeModelTier(mockEnv, "Some ambiguous task", undefined, "test-trace")
		expect(tier).toBe("balanced")
	})

	it("JEV falls back to balanced on API error", async () => {
		;(globalThis.fetch as any).mockRejectedValue(new Error("API down"))

		const tier = await routeModelTier(mockEnv, "Any task", undefined, "test-trace")
		expect(tier).toBe("balanced")
	})
})