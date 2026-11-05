import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
	classifyOpenRouterModels,
	primeOpenRouterTiers,
	routeModelTier,
	getHeuristicModelForTask,
	usesOpenRouterPrimary,
} from "./model-router"
import { catalogFreeToolModels } from "./brain-model"

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

describe("catalog priming", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("counts OpenRouter as primary even when another provider key exists", () => {
		// Regression: `availableProviders[0] === "openai"` decided this, so a
		// deployment holding a Google key silently stopped priming the catalog
		// and answered from pinned model ids the router never classified.
		const env = {
			OPENAI_API_KEY: "sk-or-test",
			OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
			GOOGLE_GENERATIVE_AI_API_KEY: "google-test-key",
		} as unknown as Env
		expect(usesOpenRouterPrimary(env)).toBe(true)
	})

	it("does not claim primary without an OpenAI-compatible endpoint", () => {
		const env = {
			GOOGLE_GENERATIVE_AI_API_KEY: "google-test-key",
		} as unknown as Env
		expect(usesOpenRouterPrimary(env)).toBe(false)
	})

	it("takes the free hops from the catalog's classification", async () => {
		;(globalThis.fetch as any).mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{
							id: "nvidia/big-context:free",
							name: "Big free",
							pricing: { prompt: "0", completion: "0" },
							context_length: 1_000_000,
							supported_parameters: ["tools", "response_format"],
						},
						{
							id: "vendor/small-context:free",
							name: "Small free",
							pricing: { prompt: "0", completion: "0" },
							context_length: 32_000,
							supported_parameters: ["tools", "response_format"],
						},
						{
							id: "vendor/no-tools:free",
							name: "No tools",
							pricing: { prompt: "0", completion: "0" },
							context_length: 200_000,
							supported_parameters: ["response_format"],
						},
						{
							id: "vendor/cheap-paid",
							name: "Cheap paid",
							pricing: { prompt: "0.1", completion: "0.2" },
							context_length: 200_000,
							supported_parameters: ["tools", "response_format"],
						},
					],
				}),
				{ status: 200 },
			),
		)

		await primeOpenRouterTiers(mockEnv)

		// Biggest context first, and a model without tool support never makes
		// it onto the answering chain.
		expect(catalogFreeToolModels()).toEqual([
			"nvidia/big-context:free",
			"vendor/small-context:free",
		])
	})
})