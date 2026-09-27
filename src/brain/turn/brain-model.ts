import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createXai } from "@ai-sdk/xai"
import { Ai } from "@cloudflare/ai"
import type { LanguageModel, LanguageModelV2 } from "ai"
import { createAiGateway } from "ai-gateway-provider"
import { captureException } from "@/lib/capture"
import {
	getModelInfo,
	type SupportedModel,
	type SupportedModelProvider,
	usesChatCompletions,
} from "@/lib/model-registry"
import { brainFallbackModelFor, TRIAGE_MODEL } from "./model-profile"

// Workers AI LanguageModel v2 adapter
function createWorkersAIModel(modelId: string, aiBinding: Ai): LanguageModel {
	const model: LanguageModel & { __workersAI: true; __modelId: string } = {
		specificationVersion: "v2",
		modelId,
		__workersAI: true,
		__modelId: modelId,
		async generateText(options) {
			const { prompt, system, temperature, maxTokens, topP, stopSequences, seed } = options
			// Convert AI SDK prompt format to Workers AI format
			const messages = []
			if (system) messages.push({ role: "system", content: system })
			if (typeof prompt === "string") {
				messages.push({ role: "user", content: prompt })
			} else if (Array.isArray(prompt)) {
				// Handle structured prompt
				for (const part of prompt) {
					if (part.type === "text") {
						messages.push({ role: "user", content: part.text })
					}
				}
			}

			const result = await aiBinding.run(modelId, {
				messages,
				temperature,
				max_tokens: maxTokens,
				top_p: topP,
				stop: stopSequences,
				seed,
			})

			const text = result.response?.text ?? ""
			return {
				text,
				usage: {
					promptTokens: result.usage?.prompt_tokens ?? 0,
					completionTokens: result.usage?.completion_tokens ?? 0,
				},
				finishReason: result.finish_reason ?? "stop",
			}
		},
	} satisfies LanguageModelV2
	return model
}

// Sentinel the gateway swaps for its stored provider key (BYOK).
const GATEWAY_INJECTED_KEY = "CF_TEMP_TOKEN"

/** Best model this deployment can reach, per provider. */
const PROVIDER_DEFAULT_MODEL: Record<SupportedModelProvider, SupportedModel> = {
	anthropic: "claude-sonnet-5",
	openai: "gpt-5.6",
	google: "gemini-3.1-pro-preview",
	xai: "grok-4.5",
	"workers-ai": "@cf/meta/llama-3.1-8b-instruct",
}

/**
 * Free models to fall back to when the `openai` provider is really an
 * OpenAI-compatible endpoint (OpenRouter, Workers AI): OpenAI's own model ids
 * don't exist there. Triage runs on every message, so it takes the light one.
 */
export const OPENAI_COMPATIBLE_FALLBACK_MODEL: SupportedModel = "nemotron-3-ultra-free"
export const OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL: SupportedModel =
	"qwen3.8-27b-free"

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
		case "workers-ai":
			return hasWorkersAI(env) ? "workers-ai" : undefined // AI binding only
	}
}

/** Providers this deployment has a key for, in preference order. */
export function availableProviders(env: Env): SupportedModelProvider[] {
	const order: SupportedModelProvider[] = [
		"anthropic",
		"openai",
		"google",
		"xai",
		"workers-ai",
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
	// Chat-completions models need their endpoint, not just any key: without
	// OPENAI_BASE_URL the call below would fail with a confusing error.
	if (providerKey(provider, env)?.trim()) {
		if (!usesChatCompletions(modelName) || openAiCompatibleBaseUrl(env)) return modelName
		const error = new Error(
			`[company-brain] ${modelName} runs on an OpenAI-compatible chat endpoint, but OPENAI_BASE_URL is not set.`,
		)
		captureException(error, { tags: { feature: "company_brain" } })
		throw error
	}
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

/** Workers AI is always available when the AI binding is configured in wrangler.jsonc */
export function hasWorkersAI(env: Env): boolean {
	return env.AI !== undefined
}

export function brainProviderModel(
	modelName: SupportedModel,
	env: Env,
	apiKeyOverride?: string,
): LanguageModel {
	const { modelId, provider } = getModelInfo(modelName)
	const apiKey = apiKeyOverride ?? providerKey(provider, env) ?? ""
	
	// Workers AI models (prefixed with @cf/)
	if (modelId.startsWith("@cf/")) {
		if (!hasWorkersAI(env)) {
			throw new Error("[company-brain] Workers AI binding not configured")
		}
		// Create a LanguageModel v2 adapter for Workers AI
		return createWorkersAIModel(modelId, env.AI)
	}

	
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
		case "workers-ai":
			throw new Error("[company-brain] use @cf/ model ids for Workers AI")
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
 * Workers AI models (prefixed with @cf/) bypass the gateway since it doesn't support them.
 */
export function wrapBrainGateway(
	env: Env,
	models: LanguageModel[],
): LanguageModel {
	const [primary] = models
	if (!primary) {
		throw new Error("[company-brain] no model candidates provided")
	}
	
	// Check if the primary model is a Workers AI model - gateway doesn't support it
	const isWorkersAI = (primary as any).__workersAI === true
	if (isWorkersAI) {
		return primary
	}
	
	const config = brainGatewayConfig(env)
	if (!config) return primary
	const aigateway = createAiGateway(config)
	// ai-gateway-provider types expect LanguageModelV3[]; our models match at runtime.
	return aigateway(models as never) as LanguageModel
}

export function getBrainModel(modelName: SupportedModel, env: Env) {
	// resolveModel throws when nothing can serve the request (no key, no
	// endpoint, no gateway, no AI binding). Let it throw: swallowing it here
	// turned a clear "OPENAI_BASE_URL missing" error into a confusing
	// "no model candidates" error two steps later.
	const resolved = resolveModel(modelName, env)

	const gateway = hasBrainGateway(env)
	const key = gateway ? GATEWAY_INJECTED_KEY : undefined
	const candidates: LanguageModel[] = []

	// Try primary model
	try {
		const primary = brainProviderModel(resolved, env, key)
		if (primary) candidates.push(primary)
	} catch (e) {
		console.warn(`[company-brain] primary model ${resolved} failed:`, e)
	}

	// Try fallback model
	try {
		const fallback = brainFallbackModelFor(resolved)
		if (fallback !== resolved && (gateway || providerHasKey(fallback, env))) {
			const fb = brainProviderModel(fallback, env, key)
			if (fb) candidates.push(fb)
		}
	} catch (e) {
		console.warn(`[company-brain] fallback model failed:`, e)
	}

	// Ultimate fallback: OpenRouter free model
	if (candidates.length === 0) {
		try {
			const ultimate = brainProviderModel("nemotron-3-ultra-free", env, key)
			if (ultimate) candidates.push(ultimate)
		} catch (e) {
			console.error("[company-brain] all model candidates failed:", e)
		}
	}

	if (candidates.length === 0) {
		throw new Error("[company-brain] no model candidates provided")
	}

	return wrapBrainGateway(env, candidates)
}

function providerHasKey(modelName: SupportedModel, env: Env): boolean {
	return Boolean(providerKey(getModelInfo(modelName).provider, env)?.trim())
}
