import type { AnthropicProviderOptions } from "@ai-sdk/anthropic"
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google"
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai"
import type { SharedV3ProviderOptions } from "@ai-sdk/provider"
import type { XaiResponsesProviderOptions } from "@ai-sdk/xai"

export const SUPPORTED_MODELS = [
	"grok-4.3",
	"grok-4.5",
	"gpt-5.1",
	"gpt-5.5",
	"gpt-5.6",
	"gpt-5.6-terra",
	"claude-opus-4.8",
	"claude-sonnet-5",
	"claude-sonnet-4.6",
	"claude-haiku-4.5",
	"gemini-3.1-pro-preview",
	"gemini-3.8-flash",
	// Free OpenRouter models, reached through its OpenAI-compatible endpoint
	// (set OPENAI_BASE_URL). They speak chat completions, not the Responses API.
	// Prefer these that support BOTH tools and structured outputs: the brain
	// parses typed JSON on its decision paths, so a free model without
	// structured outputs can silently degrade them.
	"nemotron-3-ultra-free",
	"nemotron-3-super-free",
	"qwen3.8-27b-free",
	"gemma-4-31b-free",
	"dots-3-note-free",
	// Paid OpenRouter model. Z.AI caches automatically, so the brain's long
	// system prefix bills at the cache-read rate with no prompt changes, and
	// cache writes are currently free on Z.AI. Chosen over the cheaper
	// DeepSeek V4 Flash on non-hallucination rate (72.4% vs 11%): this brain
	// writes its own answers into memory, so a model that invents plausible
	// team facts corrupts the store it later answers from.
	// Qwen is deliberately absent: it needs explicit cache_control breakpoints,
	// which this brain only emits for the anthropic provider.
	"glm-5.3-flash",
	// Anthropic models served by OpenRouter. Same weights as the native
	// Anthropic ids, but billed through one OpenAI-compatible endpoint. This
	// is the escalation tier, not the default: it is the most expensive model
	// the brain can reach.
	"claude-sonnet-5-openrouter",
	// Compatibility alias for chat/playground settings saved before the 3.1 upgrade.
	"gemini-2.5-pro",
	// Workers AI models (prefixed with @cf/)
	"@cf/meta/llama-3.2-1b-instruct",
] as const

export type SupportedModel = (typeof SUPPORTED_MODELS)[number]
export type SupportedModelProvider = "anthropic" | "openai" | "xai" | "google"
export type ModelReasoningEffort = "low" | "medium" | "high" | "xhigh"

const SUPPORTED_MODEL_SET = new Set<string>(SUPPORTED_MODELS)

export function isSupportedModel(value: unknown): value is SupportedModel {
	return typeof value === "string" && SUPPORTED_MODEL_SET.has(value)
}

type SupportedModelInfo = {
	modelId: string
	provider: SupportedModelProvider
	canonicalName?: SupportedModel
	/**
	 * Which OpenAI-shaped API the model speaks. OpenAI's own models use the
	 * Responses API; OpenAI-compatible endpoints (OpenRouter, Workers AI) only
	 * implement chat completions.
	 */
	api?: "responses" | "chat"
}

const MODEL_INFO = {
	"grok-4.3": { modelId: "grok-4.3", provider: "xai" },
	"grok-4.5": { modelId: "grok-4.5", provider: "xai" },
	"gpt-5.1": { modelId: "gpt-5.1", provider: "openai" },
	"gpt-5.5": { modelId: "gpt-5.5", provider: "openai" },
	"gpt-5.6": { modelId: "gpt-5.6", provider: "openai" },
	"gpt-5.6-terra": { modelId: "gpt-5.6-terra", provider: "openai" },
	"claude-opus-4.8": {
		modelId: "claude-opus-4-8",
		provider: "anthropic",
	},
	"claude-sonnet-5": {
		modelId: "claude-sonnet-5",
		provider: "anthropic",
	},
	"claude-sonnet-4.6": {
		modelId: "claude-sonnet-4-6",
		provider: "anthropic",
	},
	"claude-haiku-4.5": {
		modelId: "claude-haiku-4-5-20251001",
		provider: "anthropic",
	},
	"gemini-3.1-pro-preview": {
		modelId: "gemini-3.1-pro-preview",
		provider: "google",
	},
	"gemini-3.8-flash": {
		modelId: "gemini-3.8-flash",
		provider: "google",
	},
	"gemini-2.5-pro": {
		modelId: "gemini-3.1-pro-preview",
		provider: "google",
		canonicalName: "gemini-3.1-pro-preview",
	},
	"nemotron-3-ultra-free": {
		modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
		provider: "openai",
		api: "chat",
	},
	"nemotron-3-super-free": {
		modelId: "nvidia/nemotron-3-super-120b-a12b:free",
		provider: "openai",
		api: "chat",
	},
	"qwen3.8-27b-free": {
		modelId: "qwen/qwen3.8-27b:free",
		provider: "openai",
		api: "chat",
	},
	"gemma-4-31b-free": {
		modelId: "google/gemma-4-31b-it:free",
		provider: "openai",
		api: "chat",
	},
	"dots-3-note-free": {
		modelId: "dots-studio/dots-3-note-preview:free",
		provider: "openai",
		api: "chat",
	},
	"glm-5.3-flash": {
		modelId: "z-ai/glm-5.3-flash",
		provider: "openai",
		api: "chat",
	},
	"claude-sonnet-5-openrouter": {
		modelId: "anthropic/claude-sonnet-5",
		provider: "openai",
		api: "chat",
	},
	"@cf/meta/llama-3.2-1b-instruct": {
		modelId: "@cf/meta/llama-3.2-1b-instruct",
		provider: "openai",
		api: "chat",
	},
} as const satisfies Record<SupportedModel, SupportedModelInfo>

export function getModelInfo(modelName: SupportedModel): SupportedModelInfo {
	const known = MODEL_INFO[modelName] ?? DYNAMIC_MODELS.get(modelName)
	if (known) return known
	// An unregistered id must not crash a turn: fall back to a registered,
	// reachable model rather than returning undefined into the provider factory.
	// Logged because this fallback is silent and cross-provider: an id that should
	// have been registered by the catalog overlay otherwise becomes a real request
	// to whichever provider the fallback names, which is how a free OpenRouter
	// model once ended up served by xAI.
	console.warn(
		`[company-brain] unregistered model "${modelName}"; falling back to grok-4.5. Register it via registerOpenRouterModels if it came from the OpenRouter catalog.`,
	)
	return MODEL_INFO["grok-4.5"]
}

// ── Runtime catalog overlay ─────────────────────────────────────────────────
//
// The OpenRouter catalog lists ids like "z-ai/glm-5.3-flash" that are not in
// SUPPORTED_MODELS. Without an overlay they cannot be handed to the provider
// factory, which dispatches on getModelInfo(). The overlay registers them at
// runtime, always as OpenAI-compatible chat-completions models, because that is
// the only shape an OpenRouter id can take.
//
// This is populated from the live catalog before the answering turn builds its
// model chain (see primeOpenRouterCatalog), so the chain is decided from a
// settled catalog rather than depending on whether a fetch happened to land
// first. An unregistered id resolves to the registered fallback rather than
// crashing the turn.
const DYNAMIC_MODELS = new Map<string, SupportedModelInfo>()

/**
 * Register OpenRouter ids discovered at runtime. Idempotent per id.
 *
 * Ids that already exist in the static registry are skipped: a registered model
 * keeps its own provider and API shape, and admitting it here too would make
 * `isDynamicModel` claim a model is catalog-discovered when it is not.
 */
export function registerOpenRouterModels(ids: readonly string[]): void {
	for (const id of ids) {
		const trimmed = id?.trim()
		if (!trimmed || DYNAMIC_MODELS.has(trimmed)) continue
		if (isSupportedModel(trimmed)) continue
		DYNAMIC_MODELS.set(trimmed, {
			modelId: trimmed,
			provider: "openai",
			api: "chat",
		})
	}
}

/** True when this id came from the runtime catalog rather than the registry. */
export function isDynamicModel(modelName: string): boolean {
	return DYNAMIC_MODELS.has(modelName)
}

/** Test seam: drop runtime-registered models. */
export function clearDynamicModels(): void {
	DYNAMIC_MODELS.clear()
}

/**
 * True for models that only run against an OpenAI-compatible chat-completions
 * endpoint (configured with OPENAI_BASE_URL), never against api.openai.com.
 */
export function usesChatCompletions(modelName: SupportedModel): boolean {
	return getModelInfo(modelName).api === "chat"
}

/**
 * Keep Nova requests saved by older web clients on the current model lineup.
 * This is intentionally Nova-specific: other callers can still request the
 * legacy models by their exact supported IDs.
 */
export function resolveNovaModel(modelName: SupportedModel): SupportedModel {
	switch (modelName) {
		case "grok-4.3":
			return "grok-4.5"
		case "gpt-5.1":
			return "gpt-5.6-terra"
		case "claude-sonnet-4.6":
			return "claude-sonnet-5"
		case "gemini-2.5-pro":
			return "gemini-3.1-pro-preview"
		default:
			return modelName
	}
}

function boundedEffort(
	effort: ModelReasoningEffort,
): Exclude<ModelReasoningEffort, "xhigh"> {
	return effort === "xhigh" ? "high" : effort
}

/**
 * Translate the shared effort control into options supported by the exact model.
 * Capability differences inside one provider are intentional and must not be
 * collapsed into a provider-prefix switch.
 */
export function getModelReasoningProviderOptions(
	modelName: SupportedModel,
	effort: ModelReasoningEffort,
): SharedV3ProviderOptions {
	switch (modelName) {
		case "grok-4.3":
		case "grok-4.5":
			return {
				xai: {
					reasoningEffort: boundedEffort(effort),
				} satisfies XaiResponsesProviderOptions,
			}
		case "gpt-5.1":
			return {
				openai: {
					reasoningEffort: boundedEffort(effort),
				} satisfies OpenAIResponsesProviderOptions,
			}
		case "gpt-5.5":
		case "gpt-5.6":
		case "gpt-5.6-terra":
			return {
				openai: {
					reasoningEffort: effort,
				} satisfies OpenAIResponsesProviderOptions,
			}
		case "claude-opus-4.8":
		case "claude-sonnet-5":
			return {
				anthropic: {
					thinking: { type: "adaptive" },
					effort,
				} satisfies AnthropicProviderOptions,
			}
		case "claude-sonnet-4.6":
			return {
				anthropic: {
					thinking: { type: "adaptive" },
					effort: effort === "xhigh" ? "max" : effort,
				} satisfies AnthropicProviderOptions,
			}
		case "claude-haiku-4.5":
			// Haiku 4.5 supports manual thinking, but not adaptive thinking or
			// output_config.effort. Brain triage/classification intentionally stays
			// on the fast non-thinking path for this model.
			return {}
		case "gemini-3.1-pro-preview":
		case "gemini-3.8-flash":
		case "gemini-2.5-pro":
			return {
				google: {
					thinkingConfig: {
						thinkingLevel: boundedEffort(effort),
					},
				} satisfies GoogleGenerativeAIProviderOptions,
			}
		case "nemotron-3-ultra-free":
		case "nemotron-3-super-free":
		case "qwen3.8-27b-free":
		case "gemma-4-31b-free":
		case "dots-3-note-free":
		case "glm-5.3-flash":
		case "@cf/meta/llama-3.2-1b-instruct":
		case "claude-sonnet-5-openrouter":
			// Chat-completions endpoints take no Responses-API reasoning options;
			// these models decide their own reasoning behaviour.
			return {}
	}
}

/** Lowest-latency valid request shape for each model. */
export function getModelInstantProviderOptions(
	modelName: SupportedModel,
): SharedV3ProviderOptions {
	switch (modelName) {
		case "grok-4.3":
			return {
				xai: {
					reasoningEffort: "none",
				} satisfies XaiResponsesProviderOptions,
			}
		case "grok-4.5":
			// Grok 4.5 is always a reasoning model and cannot be disabled.
			return {
				xai: {
					reasoningEffort: "low",
				} satisfies XaiResponsesProviderOptions,
			}
		case "gpt-5.1":
		case "gpt-5.5":
		case "gpt-5.6":
		case "gpt-5.6-terra":
			return {
				openai: {
					reasoningEffort: "none",
				} satisfies OpenAIResponsesProviderOptions,
			}
		case "claude-opus-4.8":
		case "claude-sonnet-5":
		case "claude-sonnet-4.6":
		case "claude-haiku-4.5":
			return {
				anthropic: {
					thinking: { type: "disabled" },
				} satisfies AnthropicProviderOptions,
			}
		case "gemini-3.1-pro-preview":
		case "gemini-3.8-flash":
		case "gemini-2.5-pro":
			return {
				google: {
					thinkingConfig: { thinkingLevel: "low" },
				} satisfies GoogleGenerativeAIProviderOptions,
			}
		case "nemotron-3-ultra-free":
		case "nemotron-3-super-free":
		case "qwen3.8-27b-free":
		case "gemma-4-31b-free":
		case "dots-3-note-free":
		case "glm-5.3-flash":
		case "@cf/meta/llama-3.2-1b-instruct":
		case "claude-sonnet-5-openrouter":
			return {}
	}
}

/** Explicit user-facing "thinking" mode, independent of Brain effort controls. */
export function getModelThinkingProviderOptions(
	modelName: SupportedModel,
): SharedV3ProviderOptions {
	if (modelName === "claude-haiku-4.5") {
		return {
			anthropic: {
				thinking: { type: "enabled", budgetTokens: 8_192 },
			} satisfies AnthropicProviderOptions,
		}
	}
	return getModelReasoningProviderOptions(modelName, "high")
}
