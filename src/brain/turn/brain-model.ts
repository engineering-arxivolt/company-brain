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
 * Head of the brain chain when OpenRouter is configured. OpenRouter serves
 * Anthropic's own weights, so this is Claude without a separate Anthropic key —
 * it just bills through the one OpenAI-compatible endpoint already set up.
 */
export const OPENROUTER_MAIN_MODEL: SupportedModel = "claude-sonnet-5-openrouter"
/** Free OpenRouter model: still answers when the paid one is out of credits. */
export const OPENROUTER_FREE_MODEL: SupportedModel = OPENAI_COMPATIBLE_FALLBACK_MODEL

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
 * @param options.mainTurn Only the user-facing Slack turn sets this. It gets
 *   the OpenRouter hops (paid frontier model, then its free tier) at the head of
 *   the chain and a degraded notice when everything is out of quota. Background
 *   callers — triage, the post-turn observer, the approval classifier — leave it
 *   off: they keep the cheap model they resolved and handle quota errors with
 *   their own recovery rather than showing the user a notice.
 */
export function getBrainModel(
	modelName: SupportedModel,
	env: Env,
	options: { mainTurn?: boolean } = {},
): LanguageModel {
	const resolved = resolveModel(modelName, env)
	const gateway = hasBrainGateway(env)
	const key = gateway ? GATEWAY_INJECTED_KEY : undefined
	const candidates: LanguageModel[] = []

	// OpenRouter first when its OpenAI-compatible endpoint is configured: it
	// fronts both paid frontier models and a free tier, so one key covers more
	// quota than any single provider.
	if (
		options.mainTurn &&
		openAiCompatibleBaseUrl(env) &&
		env.OPENAI_API_KEY?.trim()
	) {
		candidates.push(brainProviderModel(OPENROUTER_MAIN_MODEL, env, key))
		candidates.push(brainProviderModel(OPENROUTER_FREE_MODEL, env, key))
	}

	candidates.push(brainProviderModel(resolved, env, key))
	const fallback = brainFallbackModelFor(resolved)
	if (fallback !== resolved && (gateway || providerHasKey(fallback, env))) {
		candidates.push(brainProviderModel(fallback, env, key))
	}

	// A gateway runs the fall-through itself, so it stays a single candidate.
	const models = gateway ? [wrapBrainGateway(env, candidates)] : candidates
	// Deduped: a picked OpenRouter model would otherwise appear twice.
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
