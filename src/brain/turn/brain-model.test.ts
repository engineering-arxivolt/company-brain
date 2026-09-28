import { describe, expect, it } from "vitest"
import { degradedAsError } from "../observability"
import {
	availableProviders,
	isDegradedProviderMetadata,
	DEGRADED_METADATA_KEY,
	getBrainModel,
	isPoolExhausted,
	openAiCompatibleBaseUrl,
	withFallbackChain,
	DEGRADED_NOTICE,
	OPENROUTER_FREE_MODEL,
	OPENROUTER_MAIN_MODEL,
} from "./brain-model"
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

describe("quota fallback chain", () => {
	const quotaError = Object.assign(new Error("free-models-per-day limit reached"), {
		statusCode: 429,
	})
	const brokenError = Object.assign(new Error("tool schema invalid"), { statusCode: 400 })

	/** Minimal v2 stand-in that records calls and can be told to fail. */
	const fakeModel = (modelId: string, fail?: unknown) =>
		({
			specificationVersion: "v2",
			provider: "test",
			modelId,
			supportedUrls: {},
			doGenerate: async () => {
				if (fail) throw fail
				return {
					content: [{ type: "text", text: `answered by ${modelId}` }],
					finishReason: "stop",
					usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
					warnings: [],
				}
			},
			doStream: async () => {
				if (fail) throw fail
				return { stream: new ReadableStream() }
			},
		}) as never

	const generate = (model: unknown) =>
		(
			model as {
				doGenerate: (o: unknown) => Promise<{ content: Array<{ text?: string }> }>
			}
		).doGenerate({ prompt: [] })

	const text = (result: { content: Array<{ text?: string }> }) =>
		result.content.map((part) => part.text ?? "").join("")

	it("classifies only quota errors as retryable", () => {
		expect(isPoolExhausted(quotaError)).toBe(true)
		expect(isPoolExhausted(Object.assign(new Error("x"), { statusCode: 402 }))).toBe(true)
		expect(isPoolExhausted(new Error("free-models-per-day"))).toBe(true)
		expect(isPoolExhausted(brokenError)).toBe(false)
	})

	it("uses the first candidate when it works", async () => {
		const chain = withFallbackChain([fakeModel("a"), fakeModel("b")])
		expect(text(await generate(chain))).toBe("answered by a")
	})

	it("moves to the next candidate when one is out of quota", async () => {
		const chain = withFallbackChain([fakeModel("a", quotaError), fakeModel("b"), fakeModel("c")])
		expect(text(await generate(chain))).toBe("answered by b")
	})

	it("spans several exhausted candidates before giving up", async () => {
		const chain = withFallbackChain([
			fakeModel("a", quotaError),
			fakeModel("b", quotaError),
			fakeModel("c"),
		])
		expect(text(await generate(chain))).toBe("answered by c")
	})

	it("says it is degraded instead of inventing an answer", async () => {
		const chain = withFallbackChain([fakeModel("a", quotaError), fakeModel("b", quotaError)])
		const result = await generate(chain)
		expect(text(result)).toBe(DEGRADED_NOTICE)
		expect(text(result)).toMatch(/degraded/i)
		expect(text(result)).toMatch(/quota/i)
	})

	it("propagates non-quota failures so real bugs stay visible", async () => {
		const chain = withFallbackChain([fakeModel("a", brokenError), fakeModel("b")])
		await expect(generate(chain)).rejects.toThrow("tool schema invalid")
	})

	it("rejects an empty chain instead of silently degrading", () => {
		expect(() => withFallbackChain([])).toThrow(/no model candidates/)
	})

	it("rethrows for background callers so their own recovery can run", async () => {
		// The post-turn observer would otherwise persist the notice into team
		// memory as a durable note.
		const chain = withFallbackChain([fakeModel("a", quotaError)], null)
		await expect(generate(chain)).rejects.toThrow(/free-models-per-day/)
	})

	it("routes OpenRouter ahead of the requested model for the main turn", () => {
		const env = asEnv({
			OPENAI_API_KEY: "sk-or-v1-test",
			OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
			GOOGLE_GENERATIVE_AI_API_KEY: "goog-test",
		})
		const model = getBrainModel("gemini-3.8-flash", env, {
			mainTurn: true,
		}) as unknown as { provider: string; modelId: string }
		// The chain head is OpenRouter's Claude, so Gemini becomes a later hop.
		expect(model.modelId).toBe("anthropic/claude-sonnet-5")
		expect(model.provider).toBe("openai.chat")
	})

	it("keeps the paid OpenRouter hop off triage and classification calls", async () => {
		const env = asEnv({
			OPENAI_API_KEY: "sk-or-v1-test",
			OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
			GOOGLE_GENERATIVE_AI_API_KEY: "goog-test",
		})
		// Google outranks the OpenAI-compatible endpoint, so triage keeps the
		// cheap model it resolved on and never sees the paid OpenRouter hop.
		const triage = getBrainModel(TRIAGE_MODEL, env) as unknown as { modelId: string }
		expect(triage.modelId).toBe("gemini-3.8-flash")
		// ...and it gets no degraded notice either: it throws so the caller's
		// own fallback runs.
		await expect(generate(triage)).rejects.toThrow()
	})

	it("keeps the requested model first without an OpenAI-compatible endpoint", () => {
		const env = asEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "goog-test" })
		const model = getBrainModel("gemini-3.8-flash", env) as unknown as { modelId: string }
		expect(model.modelId).toBe("gemini-3.8-flash")
	})

	it("offers a paid and a free OpenRouter model as the first two hops", () => {
		expect(OPENROUTER_MAIN_MODEL).toBe("claude-sonnet-5-openrouter")
		expect(OPENROUTER_FREE_MODEL).toBe("nemotron-3-ultra-free")
	})
})

describe("degraded telemetry marker", () => {
	const quotaError = Object.assign(new Error("free-models-per-day limit reached"), {
		statusCode: 429,
	})
	const fakeModel = (modelId: string, fail?: unknown) =>
		({
			specificationVersion: "v2",
			provider: "test",
			modelId,
			supportedUrls: {},
			doGenerate: async () => {
				if (fail) throw fail
				return {
					content: [{ type: "text", text: `ok ${modelId}` }],
					finishReason: "stop",
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					warnings: [],
				}
			},
			doStream: async () => ({ stream: new ReadableStream() }),
		}) as never

	it("tags an exhausted chain so telemetry can record the outage", async () => {
		const chain = withFallbackChain([fakeModel("a", quotaError), fakeModel("b", quotaError)])
		const result = (await (
			chain as unknown as { doGenerate: (o: unknown) => Promise<Record<string, unknown>> }
		).doGenerate({ prompt: [] })) as { providerMetadata?: unknown }
		expect(isDegradedProviderMetadata(result.providerMetadata)).toEqual({
			degraded: true,
			exhausted: "test/a,test/b",
		})
	})

	it("leaves a real answer unmarked", async () => {
		const chain = withFallbackChain([fakeModel("a"), fakeModel("b", quotaError)])
		const result = (await (
			chain as unknown as { doGenerate: (o: unknown) => Promise<Record<string, unknown>> }
		).doGenerate({ prompt: [] })) as { providerMetadata?: unknown }
		expect(isDegradedProviderMetadata(result.providerMetadata).degraded).toBe(false)
	})

	it("treats absent or foreign metadata as not degraded", () => {
		expect(isDegradedProviderMetadata(undefined).degraded).toBe(false)
		expect(isDegradedProviderMetadata({}).degraded).toBe(false)
		expect(isDegradedProviderMetadata({ other: { degraded: true } }).degraded).toBe(false)
	})

	it("turns the marker into a PostHog-visible error", () => {
		expect(degradedAsError(undefined)).toEqual({})
		expect(
			degradedAsError({ [DEGRADED_METADATA_KEY]: { degraded: true, exhausted: "a,b" } }),
		).toEqual({ isError: true, error: "all model candidates out of quota (a,b)" })
	})
})
