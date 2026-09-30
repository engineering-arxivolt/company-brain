import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { degradedAsError } from "../observability"
import {
	availableProviders,
	brainChainModelNames,
	isDegradedProviderMetadata,
	DEGRADED_METADATA_KEY,
	getBrainModel,
	isPoolExhausted,
	openAiCompatibleBaseUrl,
	withFallbackChain,
	DEGRADED_NOTICE,
	OPENROUTER_MAIN_MODEL,
	OPENROUTER_ESCALATION_MODEL,
	autoAddedMainTurnHasFreeModel,
	autoAddedMainTurnModels,
	catalogMainTurnModels,
	setCatalogMainTurnModels,
	clearCatalogMainTurnModels,
	isFreeModel,
} from "./brain-model"
import { BRAIN_MAIN_MODEL_CHOICES, TRIAGE_MODEL } from "./model-profile"
import {
	getModelTokenPrices,
	registerDynamicModelPrices,
	clearDynamicModelPrices,
} from "../billing/model-prices"
import {
	getModelInfo,
	getModelReasoningProviderOptions,
	usesChatCompletions,
	registerOpenRouterModels,
	clearDynamicModels,
} from "@/lib/model-registry"

const asEnv = (vars: Record<string, string>) => vars as unknown as Env

const openRouterEnv = asEnv({
	OPENAI_API_KEY: "sk-or-v1-test",
	OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
})

/** Upstream OpenRouter ids of every model the registry prices at $0. */
const FREE_MODEL_IDS = new Set<string>(
	[
		"nemotron-3-ultra-free",
		"nemotron-3-super-free",
		"qwen3.8-27b-free",
		"gemma-4-31b-free",
		"dots-3-note-free",
		"@cf/meta/llama-3.2-1b-instruct",
	].map((name) => getModelInfo(name as never).modelId),
)

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
		// The chain head is OpenRouter's cheap cached model, so Gemini becomes a
		// later hop. This used to be Anthropic's Claude at $2/$10 per MTok.
		expect(model.modelId).toBe("z-ai/glm-5.3-flash")
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

	it("leads with the cheap cached model and keeps the frontier model as escalation", () => {
		// The head of the chain decides the bill. It must not be the $2/$10
		// frontier model: a hard turn is what escalation is for.
		expect(OPENROUTER_MAIN_MODEL).toBe("glm-5.3-flash")
		expect(OPENROUTER_ESCALATION_MODEL).toBe("claude-sonnet-5-openrouter")
	})

	it("bills the main model at the cache-read rate and the free models at zero", () => {
		expect(getModelTokenPrices("glm-5.3-flash")).toEqual({
			inputPerMTok: 0.15,
			outputPerMTok: 0.5,
			cacheReadPerMTok: 0.03,
		})
		expect(getModelTokenPrices("qwen3.8-27b-free")?.inputPerMTok).toBe(0)
		expect(getModelTokenPrices("dots-3-note-free")?.inputPerMTok).toBe(0)
	})

	it("never auto-adds a free model to the answering chain", () => {
		// The invariant behind the whole gate: nothing this module adds to the
		// write-path chain on its own initiative may be free. If someone repoints
		// OPENROUTER_MAIN_MODEL at a `:free` id, this fails instead of quietly
		// reinstating a 69.7%-non-hallucination model on the memory write path.
		expect(autoAddedMainTurnHasFreeModel()).toBe(false)
		expect(isFreeModel(OPENROUTER_MAIN_MODEL)).toBe(false)
		expect(isFreeModel(OPENROUTER_ESCALATION_MODEL)).toBe(false)
	})

	it("drops a substituted free model from the answering chain", () => {
		// Only the OpenRouter endpoint is configured, so `resolveModel` swaps the
		// requested Anthropic model for the endpoint's free model. That free model
		// would otherwise hold the turn's memory/GitHub/Linear/Notion tools, so it
		// must be dropped even though nothing free was added by hand.
		const chain = brainChainModelNames("claude-sonnet-5", openRouterEnv, {
			mainTurn: true,
		})
		expect(chain.length).toBeGreaterThan(0)
		expect(chain).not.toContain("nemotron-3-ultra-free")
		// Every survivor is a paid model, checked against the registry's own prices.
		for (const name of chain) {
			expect(isFreeModel(name)).toBe(false)
		}
	})

	it("leads the answering chain with the paid models, cheapest first", () => {
		const chain = brainChainModelNames("gemini-3.8-flash", openRouterEnv, {
			mainTurn: true,
		})
		expect(chain.slice(0, 2)).toEqual([
			OPENROUTER_MAIN_MODEL,
			OPENROUTER_ESCALATION_MODEL,
		])
	})

	it("still lets a read-only caller keep its free model", () => {
		// Triage and the post-turn observer are read-only, so a free model is
		// correct there. Dropping it would break the free-plan deployment.
		const chain = brainChainModelNames(TRIAGE_MODEL, openRouterEnv)
		expect(chain.some((name) => isFreeModel(name))).toBe(true)
		// And the built model's id is one the registry prices at zero.
		const model = inspect(getBrainModel(TRIAGE_MODEL, openRouterEnv))
		expect(FREE_MODEL_IDS.has(model.modelId ?? "")).toBe(true)
	})

	it("keeps a free model when it is the only provider, rather than failing", () => {
		// No paid model is reachable at all, so dropping the free one would leave
		// the chain empty and throw. Serving on it beats a dead brain; this is the
		// one documented way a free model reaches the answering turn.
		const chain = brainChainModelNames("claude-sonnet-5", openRouterEnv, {
			mainTurn: true,
		})
		expect(chain).toContain(OPENROUTER_MAIN_MODEL)
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


// ── The catalog actually decides the answering chain ─────────────────────────
//
// The catalog used to be fetched, classified, registered and priced, and then
// ignored: primeOpenRouterTiers' result was discarded and the chain ran the
// pinned pair. These tests pin the loop shut. They reset the module-level
// catalog state, because that state is process-wide and would otherwise leak
// into every other suite in this file.
describe("catalog-driven answering chain", () => {
	beforeEach(() => {
		clearCatalogMainTurnModels()
		clearDynamicModels()
		clearDynamicModelPrices()
	})
	afterEach(() => {
		clearCatalogMainTurnModels()
		clearDynamicModels()
		clearDynamicModelPrices()
	})

	it("runs the pinned pair when the catalog has not been primed", () => {
		expect(catalogMainTurnModels()).toBeNull()
		expect(autoAddedMainTurnModels()).toEqual([
			OPENROUTER_MAIN_MODEL,
			OPENROUTER_ESCALATION_MODEL,
		])
	})

	it("leads the chain with the catalog's picks once primed", () => {
		registerOpenRouterModels(["vendor/cheap", "vendor/frontier"])
		registerDynamicModelPrices([
			{ id: "vendor/cheap", inputPerMTok: 0.15, outputPerMTok: 0.5 },
			{ id: "vendor/frontier", inputPerMTok: 3, outputPerMTok: 15 },
		])
		setCatalogMainTurnModels(["vendor/cheap" as never, "vendor/frontier" as never])

		const chain = brainChainModelNames("gemini-3.8-flash", openRouterEnv, {
			mainTurn: true,
		})

		expect(chain.slice(0, 2)).toEqual(["vendor/cheap", "vendor/frontier"])
	})

	it("refuses a wholly-free catalog pair, keeping the pinned hops", () => {
		registerOpenRouterModels(["vendor/free-a", "vendor/free-b"])
		registerDynamicModelPrices([
			{ id: "vendor/free-a", inputPerMTok: 0, outputPerMTok: 0 },
			{ id: "vendor/free-b", inputPerMTok: 0, outputPerMTok: 0 },
		])

		setCatalogMainTurnModels(["vendor/free-a" as never, "vendor/free-b" as never])

		// The answering turn writes to memory; it must not be talked onto a free
		// model by a catalog that happens to only offer free ones.
		expect(catalogMainTurnModels()).toBeNull()
		expect(autoAddedMainTurnHasFreeModel()).toBe(false)
	})

	it("drops a free hop from a mixed catalog pair but keeps the paid one", () => {
		registerOpenRouterModels(["vendor/free-a", "vendor/paid"])
		registerDynamicModelPrices([
			{ id: "vendor/free-a", inputPerMTok: 0, outputPerMTok: 0 },
			{ id: "vendor/paid", inputPerMTok: 0.2, outputPerMTok: 0.8 },
		])

		setCatalogMainTurnModels(["vendor/free-a" as never, "vendor/paid" as never])

		expect(catalogMainTurnModels()).toEqual(["vendor/paid"])
		expect(autoAddedMainTurnHasFreeModel()).toBe(false)
	})

	// The bug this closes: the free bucket was excluded from registration, but
	// free[0] is what the `fast` tier is served from. An unregistered id falls
	// through getModelInfo's fallback to a different provider entirely -- a free
	// OpenRouter model was being served by xAI -- and isFreeModel reported false,
	// so the write-path guard did not catch it.
	it("resolves and prices a catalog free model instead of falling back to xAI", () => {
		registerOpenRouterModels(["vendor/free"])
		registerDynamicModelPrices([
			{ id: "vendor/free", inputPerMTok: 0, outputPerMTok: 0 },
		])
		const freeId = "vendor/free" as never

		expect(getModelInfo(freeId).provider).toBe("openai")
		expect(getModelInfo(freeId).modelId).toBe("vendor/free")
		expect(usesChatCompletions(freeId)).toBe(true)
		// Priced at $0, so the write-path guard can see it for what it is.
		expect(isFreeModel(freeId)).toBe(true)
	})
})
