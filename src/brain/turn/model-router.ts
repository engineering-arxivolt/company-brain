import { isTypeSafeConfigured, querySystemOne } from "../typesafe/client"
import { type SupportedModel } from "@/lib/model-registry"
import {
	TRIAGE_MODEL,
	BRAIN_MODEL,
	BRAIN_FALLBACK_MODEL,
	BRAIN_FALLBACK_MODEL_FOR_ANTHROPIC,
} from "./model-profile"
import {
	openAiCompatibleBaseUrl,
	availableProviders,
	providerKey,
	OPENAI_COMPATIBLE_FALLBACK_MODEL,
	OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL,
} from "./brain-model"
import { hasWorkersAI } from "./brain-model"

export type ModelTier = "fast" | "balanced" | "strong" | "long"

export interface ModelTierConfig {
	fast: SupportedModel
	balanced: SupportedModel
	strong: SupportedModel
	long: SupportedModel
}

/** OpenRouter model info from /models endpoint */
interface OpenRouterModel {
	id: string
	name: string
	pricing: {
		prompt: string
		completion: string
	}
	context_length: number
	supported_parameters: string[]
	architecture?: {
		tokenizer: string
	}
}

/** Cached OpenRouter model catalog */
let openRouterModelCache: {
	models: OpenRouterModel[]
	fetchedAt: number
} | null = null

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/** Fetch and cache OpenRouter model catalog */
async function fetchOpenRouterModels(env: Env): Promise<OpenRouterModel[]> {
	const now = Date.now()
	if (openRouterModelCache && now - openRouterModelCache.fetchedAt < CACHE_TTL_MS) {
		return openRouterModelCache.models
	}

	try {
		const res = await fetch(OPENROUTER_MODELS_URL, {
			headers: {
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			},
			cf: { cacheTtl: 3600, cacheEverything: true },
		})
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`)
		}
		const { data } = (await res.json()) as { data: OpenRouterModel[] }
		openRouterModelCache = { models: data, fetchedAt: now }
		return data
	} catch (err) {
		console.warn("[company-brain] OpenRouter model fetch failed, using hardcoded fallback:", err)
		return []
	}
}

/** Classify OpenRouter models into pricing tiers */
function classifyOpenRouterModels(models: OpenRouterModel[]): {
	free: string[]
	cheap: string[]
	premium: string[]
} {
	const free: string[] = []
	const cheap: string[] = []
	const premium: string[] = []

	for (const m of models) {
		const promptPrice = parseFloat(m.pricing?.prompt ?? "0")
		const completionPrice = parseFloat(m.pricing?.completion ?? "0")
		const avgPrice = (promptPrice + completionPrice) / 2

		// Only consider models that support tools/function calling
		const supportsTools = (m.supported_parameters || []).includes("tools")

		if (!supportsTools) continue

		if (avgPrice === 0) {
			free.push(m.id)
		} else if (avgPrice < 0.5) { // < $0.50/MTok avg
			cheap.push(m.id)
		} else {
			premium.push(m.id)
		}
	}

	return { free, cheap, premium }
}

/** Workers AI free models (always available, no daily limits) */
const WORKERS_AI_FREE_MODELS = {
	fast: "@cf/meta/llama-3.2-1b-instruct",
	balanced: "@cf/meta/llama-3.1-8b-instruct",
	strong: "@cf/meta/llama-3.1-8b-instruct",
	long: "@cf/meta/llama-3.1-8b-instruct",
} as const

/** Build tier config preferring Workers AI (no daily limits) over OpenRouter free */
async function buildTierConfigWithWorkersAI(env: Env): Promise<ModelTierConfig> {
	const hasWAI = hasWorkersAI(env)
	
	// If Workers AI available, use it for fast/balanced tiers (no daily limits)
	if (hasWAI) {
		return {
			fast: WORKERS_AI_FREE_MODELS.fast as SupportedModel,
			balanced: WORKERS_AI_FREE_MODELS.balanced as SupportedModel,
			strong: WORKERS_AI_FREE_MODELS.strong as SupportedModel,
			long: WORKERS_AI_FREE_MODELS.long as SupportedModel,
		}
	}

	// Fallback to OpenRouter dynamic config
	return buildOpenRouterTierConfig(env)
}

/** Build dynamic tier config from OpenRouter catalog */
async function buildOpenRouterTierConfig(env: Env): Promise<ModelTierConfig> {
	const models = await fetchOpenRouterModels(env)
	const { free, cheap, premium } = classifyOpenRouterModels(models)

	// Sort by context length (prefer larger context) and name for determinism
	const sortByContext = (a: string, b: string) => {
		const ma = models.find((m) => m.id === a)
		const mb = models.find((m) => m.id === b)
		return (mb?.context_length ?? 0) - (ma?.context_length ?? 0)
	}

	free.sort(sortByContext)
	cheap.sort(sortByContext)
	premium.sort(sortByContext)

	// Build all tiers from actually available models
	// On free plan: free[] has models, cheap/premium are empty
	// Strategy: use best free models for all tiers, different models per tier
	const allAvailable = [...free, ...cheap, ...premium]
	
	// Fallback chain: free[0] → free[1] → free[2] → hardcoded free → hardcoded paid
	const fast = free[0] ?? OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL
	const balanced = free[1] ?? free[0] ?? cheap[0] ?? OPENAI_COMPATIBLE_FALLBACK_MODEL
	const strong = free[2] ?? free[1] ?? free[0] ?? cheap[1] ?? cheap[0] ?? premium[0] ?? "gpt-5.6"
	const long = free[3] ?? free[2] ?? free[1] ?? premium[1] ?? premium[0] ?? "gpt-5.6"

	return {
		fast: fast as SupportedModel,
		balanced: balanced as SupportedModel,
		strong: strong as SupportedModel,
		long: long as SupportedModel,
	}
}
/** JEV question for model tier classification */
const MODEL_TIER_QUESTION = {
	tier: {
		type: "choice" as const,
		instructions: `Classify the computational complexity of this task. Consider:
- fast: Simple lookup, classification, yes/no, short answer, formatting
- balanced: Analysis, synthesis, multi-step reasoning, code review, debugging
- strong: Complex architecture, deep research, creative writing, novel problems
- long: Extremely broad investigation, multi-domain synthesis, book-length output

Select the minimum sufficient tier. Prefer lower tiers when ambiguous.`,
		criteria: {
			fast: "Simple, direct, low-complexity task requiring minimal reasoning",
			balanced: "Moderate complexity requiring analysis, synthesis, or multi-step reasoning",
			strong: "High complexity requiring deep reasoning, creativity, or novel problem solving",
			long: "Extremely complex, open-ended, or massive scope requiring extensive computation",
		},
	},
} as const

/** Default tier configuration - maps to available models based on provider */
async function getDefaultTierConfig(env: Env): Promise<ModelTierConfig> {
	const providers = availableProviders(env)
	const hasAnthropic = providers.includes("anthropic")
	const hasOpenAI = providers.includes("openai")
	const hasOpenRouter = Boolean(openAiCompatibleBaseUrl(env))
	const hasGoogle = providers.includes("google")
	const hasXAI = providers.includes("xai")

	// Workers AI takes priority for free tier (no daily limits)
	if (hasWorkersAI(env)) {
		return buildTierConfigWithWorkersAI(env)
	}

	// Determine primary provider (first available in preference order)
	const primaryProvider = providers[0]

	// If using OpenRouter (OpenAI-compatible), use dynamic model catalog
	if (hasOpenRouter && primaryProvider === "openai") {
		return buildOpenRouterTierConfig(env)
	}

	// Anthropic primary
	if (hasAnthropic) {
		return {
			fast: TRIAGE_MODEL,                                   // claude-haiku-4.5
			balanced: "claude-sonnet-5",
			strong: BRAIN_MODEL,                                  // grok-4.5 or configured main
			long: BRAIN_MODEL,
		}
	}

	// Google primary
	if (hasGoogle) {
		return {
			fast: "gemini-3.1-pro-preview",
			balanced: "gemini-3.1-pro-preview",
			strong: "gemini-3.1-pro-preview",
			long: "gemini-3.1-pro-preview",
		}
	}

	// XAI primary
	if (hasXAI) {
		return {
			fast: "grok-4.5",
			balanced: "grok-4.5",
			strong: "grok-4.5",
			long: "grok-4.5",
		}
	}

	// Fallback - shouldn't happen if providers exist
	return {
		fast: TRIAGE_MODEL,
		balanced: BRAIN_FALLBACK_MODEL,
		strong: BRAIN_MODEL,
		long: BRAIN_MODEL,
	}
}

/**
 * Routes a task to the appropriate model tier using JEV (TypeSafe System 1).
 * Falls back to 'balanced' tier if JEV is unavailable or fails.
 */
export async function routeModelTier(
	env: Env,
	taskDescription: string,
	context?: string,
	traceId?: string,
): Promise<ModelTier> {
	if (!isTypeSafeConfigured(env)) {
		return "balanced"
	}

	try {
		const state = context
			? `Context:\n${context.slice(0, 3000)}\n\nTask:\n${taskDescription.slice(0, 4000)}`
			: `Task:\n${taskDescription.slice(0, 4000)}`

		const res = await querySystemOne({
			apiKey: env.TYPESAFE_API_KEY!,
			state,
			questions: MODEL_TIER_QUESTION,
			timeoutMs: 3_000,
		})

		const answer = res.answers?.tier
		if (!answer || answer.type !== "choice") {
			return "balanced"
		}

		const chosenTier = answer.choice as ModelTier
		const confidence = answer.confidence ?? 0

		console.log(
			`[company-brain][${traceId ?? "model-router"}] JEV tier routing tier=${chosenTier} confidence=${confidence} task="${taskDescription.slice(0, 80)}"`,
		)

		// Only trust high-confidence decisions; default to balanced
		if (confidence >= 0.7) {
			return chosenTier
		}

		return "balanced"
	} catch (err) {
		console.warn(
			`[company-brain][${traceId ?? "model-router"}] JEV model routing failed, defaulting to balanced:`,
			err instanceof Error ? err.message : String(err),
		)
		return "balanced"
	}
}

/**
 * Gets the model for a given tier, respecting the current provider configuration.
 * This replaces the hardcoded fallback logic with tier-aware selection.
 */
/**
 * Gets the model for a given tier (async - uses dynamic config for OpenRouter).
 * Use this instead of `getBrainModel(TRIAGE_MODEL, env)` for triage/classification tasks.
 */
export async function getModelForTier(env: Env, tier: ModelTier): Promise<SupportedModel> {
	const config = await getDefaultTierConfig(env)
	return config[tier]
}

/** Synchronous fallback using hardcoded config (for sync-only contexts) */
export function getModelForTierSync(env: Env, tier: ModelTier): SupportedModel {
	// Use hardcoded config for sync version
	const providers = availableProviders(env)
	const hasAnthropic = providers.includes("anthropic")
	const hasOpenRouter = Boolean(openAiCompatibleBaseUrl(env))
	const primaryProvider = providers[0]

	if (hasOpenRouter && primaryProvider === "openai") {
		const fast = OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL
		const balanced = OPENAI_COMPATIBLE_FALLBACK_MODEL
		const strong = (hasAnthropic ? BRAIN_MODEL : "gpt-5.6") as SupportedModel
		const long = (hasAnthropic ? BRAIN_MODEL : "gpt-5.6") as SupportedModel
		return { fast, balanced, strong, long }[tier]
	}

	if (hasAnthropic) {
		return { fast: TRIAGE_MODEL, balanced: "claude-sonnet-5" as SupportedModel, strong: BRAIN_MODEL, long: BRAIN_MODEL }[tier]
	}

	if (providers.includes("google")) {
		const m = "gemini-3.1-pro-preview" as SupportedModel
		return { fast: m, balanced: m, strong: m, long: m }[tier]
	}

	if (providers.includes("xai")) {
		const m = "grok-4.5" as SupportedModel
		return { fast: m, balanced: m, strong: m, long: m }[tier]
	}

	return { fast: TRIAGE_MODEL, balanced: BRAIN_FALLBACK_MODEL, strong: BRAIN_MODEL, long: BRAIN_MODEL }[tier]
}

/**
 * Convenience function: route and get model in one call.
 * Use this instead of `getBrainModel(TRIAGE_MODEL, env)` for triage/classification tasks.
 */
export async function getRoutedModel(
	env: Env,
	taskDescription: string,
	context?: string,
	traceId?: string,
): Promise<SupportedModel> {
	const tier = await routeModelTier(env, taskDescription, context, traceId)
	return getModelForTier(env, tier)
}

/**
 * Synchronous version for cases where async routing isn't feasible.
 * Uses a simple heuristic based on task description length/complexity keywords.
 */
export function getHeuristicModelForTask(env: Env, taskDescription: string): SupportedModel {
	// Use sync version to avoid async in hot paths
	const config = (() => {
		const providers = availableProviders(env)
		const hasAnthropic = providers.includes("anthropic")
		const hasOpenRouter = Boolean(openAiCompatibleBaseUrl(env))
		const primaryProvider = providers[0]
		const hasWAI = hasWorkersAI(env)

		// Workers AI takes priority (no daily limits)
		if (hasWAI) {
			return {
				fast: WORKERS_AI_FREE_MODELS.fast as SupportedModel,
				balanced: WORKERS_AI_FREE_MODELS.balanced as SupportedModel,
				strong: WORKERS_AI_FREE_MODELS.strong as SupportedModel,
				long: WORKERS_AI_FREE_MODELS.long as SupportedModel,
			}
		}

		if (hasOpenRouter && primaryProvider === "openai") {
			// On OpenRouter free plan: use different free models for each tier
			// Falls back gracefully if fewer free models available
			return {
				fast: OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL,
				balanced: OPENAI_COMPATIBLE_FALLBACK_MODEL,
				strong: OPENAI_COMPATIBLE_FALLBACK_MODEL, // Use best free model
				long: OPENAI_COMPATIBLE_FALLBACK_MODEL,   // Same - best available free
			}
		}

		if (hasAnthropic) {
			return { fast: TRIAGE_MODEL, balanced: "claude-sonnet-5" as SupportedModel, strong: BRAIN_MODEL, long: BRAIN_MODEL }
		}

		if (providers.includes("google")) {
			const m = "gemini-3.1-pro-preview" as SupportedModel
			return { fast: m, balanced: m, strong: m, long: m }
		}

		if (providers.includes("xai")) {
			const m = "grok-4.5" as SupportedModel
			return { fast: m, balanced: m, strong: m, long: m }
		}

		return { fast: TRIAGE_MODEL, balanced: BRAIN_FALLBACK_MODEL, strong: BRAIN_MODEL, long: BRAIN_MODEL }
	})()

	const desc = taskDescription.toLowerCase()

	// Strong indicators for higher tiers
	if (
		desc.includes("architect") ||
		desc.includes("design system") ||
		desc.includes("research") ||
		desc.includes("investigate") ||
		desc.includes("deep dive") ||
		desc.includes("comprehensive") ||
		desc.length > 2000
	) {
		return config.strong
	}

	// Balanced indicators
	if (
		desc.includes("analyze") ||
		desc.includes("compare") ||
		desc.includes("debug") ||
		desc.includes("review") ||
		desc.includes("refactor") ||
		desc.includes("implement") ||
		desc.length > 500
	) {
		return config.balanced
	}

	// Default to fast for simple tasks
	return config.fast
}