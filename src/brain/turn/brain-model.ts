import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createXai } from "@ai-sdk/xai"
import type { LanguageModel } from "ai"
import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2StreamPart,
	LanguageModelV2Usage,
} from "@ai-sdk/provider"
import { createAiGateway } from "ai-gateway-provider"
import { captureException } from "@/lib/capture"
import { getModelTokenPrices } from "../billing/model-prices"
import {
	getModelInfo,
	type SupportedModel,
	type SupportedModelProvider,
	usesChatCompletions,
} from "@/lib/model-registry"
import { brainFallbackModelFor, TRIAGE_MODEL } from "./model-profile"

// Sentinel the gateway swaps for its stored provider key (BYOK).
const GATEWAY_INJECTED_KEY = "CF_TEMP_TOKEN"

/** Best model this deployment can reach, per provider. */
const PROVIDER_DEFAULT_MODEL: Record<SupportedModelProvider, SupportedModel> = {
	anthropic: "claude-sonnet-5",
	openai: "gpt-5.6",
	google: "gemini-3.8-flash",
	xai: "grok-4.5",
}

/**
 * Free models to fall back to when the `openai` provider is really an
 * OpenAI-compatible endpoint (OpenRouter, Workers AI): OpenAI's own model ids
 * don't exist there. Triage runs on every message, so it takes the light one.
 */
export const OPENAI_COMPATIBLE_FALLBACK_MODEL: SupportedModel = "nemotron-3-ultra-free"
export const OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL: SupportedModel =
	"qwen3.8-27b-free"

/**
 * Head of the brain chain when OpenRouter is configured. GLM-5.3-Flash is
 * OpenRouter's Z.AI model: it caches automatically (so the brain's long system
 * prefix bills at the cache-read rate with no prompt changes), carries a 72.4%
 * non-hallucination rate, and is the strongest agentic index of the cheap tier.
 *
 * This sits ahead of the operator's configured model on every user-facing turn,
 * so it decides the bill. It was previously `claude-sonnet-5-openrouter` at
 * $2/$10 per MTok — roughly 12x more per turn.
 */
export const OPENROUTER_MAIN_MODEL: SupportedModel = "glm-5.3-flash"

/**
 * The escalation tier: a hard turn, deep research, or a write-path tool call.
 * Anthropic's own weights through the same OpenAI-compatible endpoint, so one
 * key covers both. Deliberately kept off the head of the chain — reaching for
 * it is a routing decision, not the default.
 */
export const OPENROUTER_ESCALATION_MODEL: SupportedModel = "claude-sonnet-5-openrouter"

/**
 * The models this module adds to the answering turn on its own initiative, in
 * chain order. Deliberately contains no free model — see `isFreeModel`.
 */
const AUTO_ADDED_MAIN_TURN_MODELS: readonly SupportedModel[] = [
	OPENROUTER_MAIN_MODEL,
	OPENROUTER_ESCALATION_MODEL,
]

/**
 * A free model is one the endpoint bills at $0 per token. It answers the
 * read-only classify paths (triage, chime, post-turn observation) but never the
 * answering turn: that turn owns the tools which write to memory and to
 * GitHub/Linear/Notion, and the free tier's 69.7% non-hallucination rate means
 * its plausible inventions get persisted and then served back to the team as
 * fact. A free model was previously the answering turn's last hop "for when the
 * paid one is out of credits"; exhausting the paid hops now yields the degraded
 * notice instead, which is honest about being unusable where a free answer
 * would not be.
 *
 * This is priced off `model-prices` rather than hardcoded per model, so adding
 * a `:free` model to the registry is enough to opt it out of the write path.
 */
export function isFreeModel(modelName: SupportedModel): boolean {
	return getModelTokenPrices(modelName)?.inputPerMTok === 0
}

/**
 * True when a model this module would auto-add to the answering turn is free.
 * Guards `AUTO_ADDED_MAIN_TURN_MODELS` against a future edit that points one
 * of its entries at a `:free` id and silently reinstates the write path.
 */
export function autoAddedMainTurnHasFreeModel(): boolean {
	return AUTO_ADDED_MAIN_TURN_MODELS.some(isFreeModel)
}

/** Base URL of the configured OpenAI-compatible endpoint, if any. */
export function openAiCompatibleBaseUrl(env: Env): string | undefined {
	return env.OPENAI_BASE_URL?.trim() || undefined
}

/** Provider API key from environment, if set. */
export function providerKey(
	provider: SupportedModelProvider,
	env: Env,
): string | undefined {
	switch (provider) {
		case "anthropic":
			return env.ANTHROPIC_API_KEY
		case "openai":
			return env.OPENAI_API_KEY
		case "google":
			return env.GOOGLE_GENERATIVE_AI_API_KEY
		case "xai":
			return env.XAI_API_KEY
	}
}

/** Providers this deployment has a key for, in preference order. */
export function availableProviders(env: Env): SupportedModelProvider[] {
	const order: SupportedModelProvider[] = [
		"anthropic",
		"google",
		"openai",
		"xai",
	]
	return order.filter((provider) => providerKey(provider, env)?.trim())
}

/**
 * The requested model when its provider has a key, otherwise the best model
 * from a provider that does. A deployment with one key still runs every
 * feature; it just runs them all on that provider.
 */
function resolveModel(modelName: SupportedModel, env: Env): SupportedModel {
	const { provider } = getModelInfo(modelName)
	if (providerKey(provider, env)?.trim()) return modelName
	const fallbackProvider = availableProviders(env)[0]
	if (!fallbackProvider) {
		const error = new Error(
			"No model provider key is set. Set MODEL_API_KEY to an Anthropic, OpenAI, Google or xAI key, or point OPENAI_BASE_URL at an OpenAI-compatible endpoint with its key in OPENAI_API_KEY.",
		)
		captureException(error, { tags: { feature: "company_brain" } })
		throw error
	}
	return fallbackModelFor(fallbackProvider, modelName, env)
}

/**
 * Best model reachable on `provider`. When the `openai` provider is really an
 * OpenAI-compatible endpoint, the model list is that endpoint's, so a free
 * registry model stands in for OpenAI's own ids.
 */
function fallbackModelFor(
	provider: SupportedModelProvider,
	requested: SupportedModel,
	env: Env,
): SupportedModel {
	if (provider === "openai" && openAiCompatibleBaseUrl(env)) {
		return requested === TRIAGE_MODEL
			? OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL
			: OPENAI_COMPATIBLE_FALLBACK_MODEL
	}
	return PROVIDER_DEFAULT_MODEL[provider]
}

/** xAI client, for the provider-native web-search tool. */
export function brainXai(env: Env, apiKeyOverride?: string) {
	return createXai({
		apiKey: apiKeyOverride ?? env.XAI_API_KEY ?? GATEWAY_INJECTED_KEY,
	})
}

export function hasXai(env: Env): boolean {
	return Boolean(env.XAI_API_KEY?.trim()) || hasBrainGateway(env)
}

export function brainProviderModel(
	modelName: SupportedModel,
	env: Env,
	apiKeyOverride?: string,
): LanguageModel {
	const { modelId, provider } = getModelInfo(modelName)
	const apiKey = apiKeyOverride ?? providerKey(provider, env) ?? ""
	switch (provider) {
		case "xai":
			return createXai({ apiKey }).responses(modelId)
		case "openai": {
			if (!usesChatCompletions(modelName)) {
				return createOpenAI({ apiKey })(modelId)
			}
			const baseURL = openAiCompatibleBaseUrl(env)
			if (!baseURL) {
				const error = new Error(
					`[company-brain] ${modelName} runs on an OpenAI-compatible chat endpoint, but OPENAI_BASE_URL is not set.`,
				)
				captureException(error, { tags: { feature: "company_brain" } })
				throw error
			}
			return createOpenAI({ apiKey, baseURL }).chat(modelId)
		}
		case "anthropic":
			return createAnthropic({ apiKey })(modelId)
		case "google":
			return createGoogleGenerativeAI({ apiKey })(modelId)
	}
}

function brainGatewayConfig(env: Env) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID
	const gateway = env.AI_GATEWAY_NAME
	const apiKey = env.AI_GATEWAY_TOKEN
	if (!accountId?.trim() || !gateway?.trim() || !apiKey?.trim()) return null
	return { accountId, gateway, apiKey }
}

export function hasBrainGateway(env: Env): boolean {
	return brainGatewayConfig(env) !== null
}

/**
 * Route through a Cloudflare AI Gateway when one is configured: it holds the
 * provider keys and falls through the candidate list on failure. Without a
 * gateway the first candidate is called directly.
 */
export function wrapBrainGateway(
	env: Env,
	models: LanguageModel[],
): LanguageModel {
	const [primary] = models
	if (!primary) {
		throw new Error("[company-brain] no model candidates provided")
	}
	const config = brainGatewayConfig(env)
	if (!config) return primary
	const aigateway = createAiGateway(config)
	// ai-gateway-provider types expect LanguageModelV3[]; our models match at runtime.
	return aigateway(models as never) as LanguageModel
}

/**
 * Served when every provider in the chain is out of quota. The alternative —
 * answering from a model with no tool access and no company data — invents
 * confident nonsense, so the turn says plainly that it is degraded instead.
 */
export const DEGRADED_NOTICE =
	"⚠️ Degraded mode: every language model this workspace can reach is out of " +
	"quota right now (OpenRouter and Google AI Studio free tiers are both " +
	"exhausted), so I can't answer this one — I'd only be guessing. Add credits " +
	"to OpenRouter or an Anthropic API key in Settings and I'll be back."

/** Quota exhaustion is the only failure worth surviving by trying the next model. */
export function isPoolExhausted(error: unknown): boolean {
	const status = errorStatus(error)
	return status === 402 || status === 429 || isFreePoolMessage(error)
}

/** Key the degraded marker travels under in the model response metadata. */
export const DEGRADED_METADATA_KEY = "company_brain"

function degradedMetadata(exhausted: string[]) {
	return { [DEGRADED_METADATA_KEY]: { degraded: true, exhausted: exhausted.join(",") } }
}

/** True when a model response was the degraded notice rather than a real answer. */
export function isDegradedProviderMetadata(
	metadata: unknown,
): { degraded: boolean; exhausted: string } {
	const record = metadata as Record<string, unknown> | null | undefined
	const marker = record?.[DEGRADED_METADATA_KEY] as
		| { degraded?: unknown; exhausted?: unknown }
		| null
		| undefined
	if (marker?.degraded !== true) return { degraded: false, exhausted: "" }
	return {
		degraded: true,
		exhausted: typeof marker.exhausted === "string" ? marker.exhausted : "",
	}
}

/**
 * Tries each candidate in order and, only when every one of them is out of
 * quota, answers with `degradedText`. Without an AI Gateway the SDK only ever
 * called the first candidate, so a second provider key bought nothing; this is
 * what makes the chain real. Non-quota errors (bad request, tool failure,
 * network) propagate untouched so real bugs stay visible.
 *
 * The degraded result is tagged in `providerMetadata` so telemetry can record a
 * total outage as the error it is — otherwise it looks in PostHog like a fast,
 * successful generation by whichever model was tried last.
 *
 * `degradedText: null` rethrows the quota error instead of serving a notice.
 * Background callers want that: triage, the post-turn observer and the approval
 * classifier each have their own recovery, and a user-facing notice would be
 * captured as a result — the observer would write "service is degraded" into the
 * team's memory as a durable note.
 */
export function withFallbackChain(
	models: LanguageModel[],
	degradedText: string | null = DEGRADED_NOTICE,
): LanguageModel {
	const chain = models.filter((model): model is LanguageModel => Boolean(model))
	const head = chain[0] as unknown as LanguageModelV2 | undefined
	if (!head) throw new Error("[company-brain] no model candidates provided")

	const noUsage: LanguageModelV2Usage = {
		inputTokens: undefined,
		outputTokens: undefined,
		totalTokens: undefined,
	}

	return {
		specificationVersion: "v2",
		modelId: head.modelId,
		provider: head.provider,
		supportedUrls: head.supportedUrls,
		async doGenerate(options: LanguageModelV2CallOptions) {
			let lastError: unknown
			const exhausted: string[] = []
			for (const model of chain) {
				const candidate = model as unknown as LanguageModelV2
				try {
					return await candidate.doGenerate(options)
				} catch (err) {
					if (!isPoolExhausted(err)) throw err
					lastError = err
					exhausted.push(`${candidate.provider}/${candidate.modelId}`)
					console.warn(
						`[company-brain] ${candidate.provider}/${candidate.modelId} out of quota (status=${errorStatus(err) ?? "unknown"}); trying next candidate`,
					)
				}
			}
			// Background callers opt out of the notice and handle the error themselves.
			if (degradedText === null) throw lastError
			console.warn(`[company-brain] every model candidate out of quota; serving degraded notice`)
			return {
				content: [{ type: "text" as const, text: degradedText }],
				finishReason: "stop" as const,
				usage: noUsage,
				warnings: [],
				providerMetadata: degradedMetadata(exhausted),
			}
		},
		async doStream(options: LanguageModelV2CallOptions) {
			let lastError: unknown
			const exhausted: string[] = []
			for (const model of chain) {
				const candidate = model as unknown as LanguageModelV2
				try {
					return await candidate.doStream(options)
				} catch (err) {
					if (!isPoolExhausted(err)) throw err
					lastError = err
					exhausted.push(`${candidate.provider}/${candidate.modelId}`)
					console.warn(
						`[company-brain] ${candidate.provider}/${candidate.modelId} out of quota (status=${errorStatus(err) ?? "unknown"}); trying next candidate`,
					)
				}
			}
			if (degradedText === null) throw lastError
			console.warn(`[company-brain] every model candidate out of quota; serving degraded notice`)
			const metadata = degradedMetadata(exhausted)
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				start(controller) {
					controller.enqueue({ type: "text-start", id: "0" })
					controller.enqueue({ type: "text-delta", id: "0", delta: degradedText })
					controller.enqueue({ type: "text-end", id: "0" })
					controller.enqueue({
						type: "finish",
						finishReason: "stop",
						usage: noUsage,
						providerMetadata: metadata,
					})
					controller.close()
				},
			})
			return { stream }
		},
	} satisfies LanguageModelV2 as unknown as LanguageModel
}

function walkErrorChain(value: unknown, visit: (record: Record<string, unknown>) => void): void {
	const seen = new Set<unknown>()
	let current: unknown = value
	for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
		if (typeof current !== "object" || seen.has(current)) return
		seen.add(current)
		const record = current as Record<string, unknown>
		visit(record)
		if (record.lastError !== undefined) current = record.lastError
		else if (record.cause !== undefined) current = record.cause
		else return
	}
}

function errorStatus(error: unknown): number | undefined {
	let found: number | undefined
	walkErrorChain(error, (record) => {
		const status = record.statusCode ?? record.status
		if (typeof status === "number") found ??= status
	})
	return found
}

function isFreePoolMessage(error: unknown): boolean {
	let matched = false
	walkErrorChain(error, (record) => {
		const message = record.message
		if (typeof message === "string" && /free-models-per-day/i.test(message)) matched = true
	})
	return matched
}

/**
 * The ordered model names this deployment may answer with, before they become
 * provider instances. Exported so the free-model gate is directly assertable:
 * `getBrainModel` returns a fallback wrapper that deliberately hides its
 * members, and "the chain contains no free model" is the property worth
 * testing.
 *
 * @param options.mainTurn Only the user-facing Slack turn sets this. It gets
 *   the OpenRouter hops (the cheap cached model, then the frontier escalation
 *   model) at the head of the chain, a degraded notice when everything is out of
 *   quota, and never a free model — see `isFreeModel`. Background callers —
 *   triage, the post-turn observer, the approval classifier — leave it off: they
 *   keep the cheap model they resolved and handle quota errors with their own
 *   recovery rather than showing a user-facing notice. Those paths are
 *   read-only, so a free model is acceptable there.
 *
 * Applies the write-path rule: a free model is dropped unless dropping it would
 * leave nothing, in which case it is kept rather than failing the turn outright.
 * That case is a deployment with no paid provider configured at all; it is
 * logged, and it is the only way a free model can reach the answering turn.
 */
export function brainChainModelNames(
	modelName: SupportedModel,
	env: Env,
	options: { mainTurn?: boolean } = {},
): SupportedModel[] {
	const resolved = resolveModel(modelName, env)
	const gateway = hasBrainGateway(env)
	const candidates: SupportedModel[] = []

	// OpenRouter first when its OpenAI-compatible endpoint is configured: it
	// fronts a cheap cached main model and a frontier escalation model, so one
	// key covers more quota than any single provider. The cheap model leads and
	// the frontier model follows as an escalation hop rather than a default.
	//
	// No free model is added here. This chain owns the answering turn's tools,
	// which write to memory and to GitHub/Linear/Notion; see `isFreeModel`. When
	// every paid hop is out of credits the chain falls through to the degraded
	// notice, which tells the user the brain is unavailable instead of writing an
	// unreliable answer into the store it later answers from.
	if (
		options.mainTurn &&
		openAiCompatibleBaseUrl(env) &&
		env.OPENAI_API_KEY?.trim()
	) {
		candidates.push(...AUTO_ADDED_MAIN_TURN_MODELS)
	}

	candidates.push(resolved)
	const fallback = brainFallbackModelFor(resolved)
	if (fallback !== resolved && (gateway || providerHasKey(fallback, env))) {
		candidates.push(fallback)
	}

	const deduped = [...new Set(candidates)]
	// The answering turn writes to memory, so it never runs on a free model —
	// not one added above, and not one `resolveModel` substituted in because the
	// requested provider had no key. Background callers skip this: they are
	// read-only, and their recovery paths expect to keep what they resolved.
	if (!options.mainTurn) return deduped
	const paid = deduped.filter((name) => !isFreeModel(name))
	if (paid.length === 0) return deduped
	if (paid.length < deduped.length) {
		console.warn(
			`[company-brain] dropping free model(s) from the answering chain: ${deduped
				.filter((name) => isFreeModel(name))
				.join(", ")}`,
		)
	}
	return paid
}

export function getBrainModel(
	modelName: SupportedModel,
	env: Env,
	options: { mainTurn?: boolean } = {},
): LanguageModel {
	const gateway = hasBrainGateway(env)
	const key = gateway ? GATEWAY_INJECTED_KEY : undefined
	const instances = brainChainModelNames(modelName, env, options).map((name) =>
		brainProviderModel(name, env, key),
	)

	// A gateway runs the fall-through itself, so it stays a single candidate.
	const models = gateway ? [wrapBrainGateway(env, instances)] : instances
	// Deduped by resolved provider model id rather than by registry name: two
	// registry keys can point at the same upstream model.
	const unique = models.filter(
		(model, i) =>
			models.findIndex(
				(other) =>
					(other as unknown as LanguageModelV2).modelId ===
					(model as unknown as LanguageModelV2).modelId,
			) === i,
	)
	return withFallbackChain(unique, options.mainTurn ? DEGRADED_NOTICE : null)
}

function providerHasKey(modelName: SupportedModel, env: Env): boolean {
	return Boolean(providerKey(getModelInfo(modelName).provider, env)?.trim())
}
