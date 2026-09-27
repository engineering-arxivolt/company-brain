import { describe, expect, it } from "vitest"
import { availableProviders, getBrainModel, openAiCompatibleBaseUrl } from "./brain-model"
import { BRAIN_MAIN_MODEL_CHOICES, TRIAGE_MODEL } from "./model-profile"
import { getModelInfo, getModelReasoningProviderOptions, usesChatCompletions } from "@/lib/model-registry"

const asEnv = (vars: Record<string, string>) => vars as unknown as Env

const openRouterEnv = asEnv({
	OPENAI_API_KEY: "sk-or-v1-test",
	OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
})

type InspectableModel = { modelId?: string; provider?: string }

const inspect = (model: unknown) => model as InspectableModel

describe("free OpenAI-compatible models", () => {
	it("falls back to a free model when the endpoint is the only provider", () => {
		const model = inspect(getBrainModel("grok-4.5", openRouterEnv))

		expect(model.modelId).toBe("nvidia/nemotron-3-ultra-550b-a55b:free")
	})

	it("keeps triage on the light free model", () => {
		const model = inspect(getBrainModel(TRIAGE_MODEL, openRouterEnv))

		expect(model.modelId).toBe("qwen/qwen3.8-27b:free")
	})

	it("leaves OpenAI's own models on the Responses API", () => {
		const model = inspect(getBrainModel("gpt-5.6", asEnv({ OPENAI_API_KEY: "sk-test" })))

		expect(model.modelId).toBe("gpt-5.6")
	})

	it("refuses a chat model when no endpoint is configured", () => {
		expect(() =>
			getBrainModel("nemotron-3-ultra-free", asEnv({ OPENAI_API_KEY: "sk-or-v1-test" })),
		).toThrow(/OPENAI_BASE_URL/)
	})

	it("sends no Responses-API options for chat models", () => {
		expect(getModelReasoningProviderOptions("nemotron-3-ultra-free", "high")).toEqual({})
		expect(getModelReasoningProviderOptions("gemma-4-31b-free", "low")).toEqual({})
	})

	it("marks only the free models as chat-completions", () => {
		expect(usesChatCompletions("nemotron-3-ultra-free")).toBe(true)
		expect(usesChatCompletions("qwen3.8-27b-free")).toBe(true)
		expect(usesChatCompletions("gpt-5.6")).toBe(false)
		expect(getModelInfo("nemotron-3-ultra-free").modelId).toBe(
			"nvidia/nemotron-3-ultra-550b-a55b:free",
		)
	})

	it("reports the endpoint and provider order for a one-key deployment", () => {
		expect(openAiCompatibleBaseUrl(openRouterEnv)).toBe("https://openrouter.ai/api/v1")
		// Workers AI needs the env.AI binding, absent in plain unit tests.
		expect(availableProviders(openRouterEnv)).toEqual(["openai"])
	})

	it("offers the free models in the settings choices", () => {
		expect(BRAIN_MAIN_MODEL_CHOICES).toContain("nemotron-3-ultra-free")
		expect(BRAIN_MAIN_MODEL_CHOICES).toContain("nemotron-3-super-free")
	})
})
