import { isTypeSafeConfigured, querySystemOne } from "../typesafe/client"
import { registerOpenRouterModels, type SupportedModel } from "@/lib/model-registry"
import { registerDynamicModelPrices } from "../billing/model-prices"
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
	catalogMainTurnModels,
	setCatalogMainTurnModels,
	OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL,
	OPENROUTER_MAIN_MODEL,
	OPENROUTER_ESCALATION_MODEL,
} from "./brain-model"

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
	/**
	 * Optional because the endpoint has been observed to omit it for some
	 * entries. A model with no capability list is treated as incapable rather
	 * than assumed capable — see classifyOpenRouterModels.
	 */
	supported_parameters?: string[]
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

/**
 * Classify OpenRouter models into pricing tiers.
 *
 * Capability filter first, price second. A model that cannot do what the brain
 * asks is not a cheaper option, it is a broken one:
 *
 * - "tools" — the answering turn drives its whole toolset through native tool
 *   calling. Without it the turn cannot act at all.
 * - "response_format" — the decision paths (triage, approval classification,
 *   channel observation, research) parse typed JSON. The model registry is
 *   explicit that a model without structured outputs "can silently degrade"
 *   them, and silently-degrading triage means messages get acked instead of
 *   answered. Tool support alone is not enough.
 *
 * Both checks fail closed: a model whose supported_parameters is absent or
 * incomplete is excluded rather than admitted on an assumption.
 */
// Exported for tests: this filter is the only thing standing between a model
// that cannot call tools or emit structured JSON and the turn that needs both.
export function classifyOpenRouterModels(models: OpenRouterModel[]): {
	free: string[]
	cheap: string[]
	premium: string[]
} {
	const free: string[] = []
	const cheap: string[] = []
	const premium: string[] = []

	for (const m of models) {
		const parameters = m.supported_parameters ?? []
		const supportsTools = parameters.includes("tools")
		const supportsStructuredOutputs = parameters.includes("response_format")

		if (!supportsTools || !supportsStructuredOutputs) continue

		const promptPrice = parseFloat(m.pricing?.prompt ?? "0")
		const completionPrice = parseFloat(m.pricing?.completion ?? "0")
		const avgPrice = (promptPrice + completionPrice) / 2

		if (avgPrice === 0) {
			free.push(m.id)
		} else if (avgPrice < 0.5) {
			// < $0.50/MTok avg
			cheap.push(m.id)
		} else {
			premium.push(m.id)
		}
	}

	return { free, cheap, premium }
}

/**
 * Build the tier config from the live OpenRouter catalog.
 *
 * This used to fetch the catalog, classify it, sort it, and then discard all
 * three buckets and return the same two hardcoded ids — so a deployment with
 * many models on OpenRouter only ever used two of them, and paid a network
 * call to learn nothing. The catalog now decides the tiers.
 *
 * The ids are registered into the runtime overlay first (see
 * registerOpenRouterModels), because raw ids like "z-ai/glm-5.3-flash" are not
 * in SUPPORTED_MODELS and the provider factory dispatches on getModelInfo().
 */
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

	// An empty or failed catalog must not change which model serves a turn.
	// Fall back to the two known-good ids rather than serving something else.
	if (!cheap.length && !premium.length) return hardcodedOpenRouterTiers()

	// Every capable id is registered and priced, including the free bucket: the
	// `fast` tier is served from `free`, and an unregistered id resolves through
	// getModelInfo's fallback to a different provider entirely. Free ids must
	// price at $0 so isFreeModel keeps them off the answering turn's write path.
	registerCatalogModels(models, [...free, ...cheap, ...premium])

	// The answering turn owns tools that write to memory and GitHub/Linear, so
	// the lead model is the cheapest PAID one, never a free model. See
	// isFreeModel. Free models stay on the read-only triage tier.
	const balanced = (cheap[0] ?? premium[0]) as SupportedModel
	const strong = (premium[0] ?? cheap[1] ?? balanced) as SupportedModel

	// Hand the paid hops to the answering chain. Without this the catalog is
	// fetched, classified, registered and priced and then the chain ignores all
	// of it and runs the pinned pair — the whole catalog would decide nothing.
	// setCatalogMainTurnModels rejects a wholly-free pair, so `balanced` cannot
	// put a free model on the write path here.
	setCatalogMainTurnModels([balanced, strong])

	return {
		fast: (free[0] ?? cheap[0] ?? balanced) as SupportedModel,
		balanced,
		strong,
		long: strong,
	}
}

function hardcodedOpenRouterTiers(): ModelTierConfig {
	return {
		fast: OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL,
		balanced: OPENROUTER_MAIN_MODEL,
		strong: OPENROUTER_ESCALATION_MODEL,
		long: OPENROUTER_ESCALATION_MODEL,
	}
}

/** Make raw catalog ids resolvable by the provider factory, and priced. */
function registerCatalogModels(
	models: OpenRouterModel[],
	ids: readonly string[],
): void {
	registerOpenRouterModels(ids)
	registerDynamicModelPrices(
		models
			.filter((m) => ids.includes(m.id))
			.map((m) => ({
				id: m.id,
				// OpenRouter quotes USD per token; the brain prices per MTok.
				inputPerMTok: Number.parseFloat(m.pricing?.prompt ?? "0") * 1_000_000,
				outputPerMTok:
					Number.parseFloat(m.pricing?.completion ?? "0") * 1_000_000,
			})),
	)
}

/**
 * Load the catalog and settle the model tiers before the answering turn builds
 * its chain.
 *
 * `brainChainModelNames` is synchronous — the model factory has to resolve a
 * concrete provider per candidate — so the catalog is fetched here, once, ahead
 * of the chain. That makes the turn's model a function of a settled catalog
 * rather than of whether a fetch happened to land first, which is the
 * cold-start nondeterminism a sync read of the cache would have had.
 *
 * Never throws: a failed or empty catalog leaves the hardcoded tiers in place,
 * so the worst case is today's behaviour.
 */
export async function primeOpenRouterTiers(env: Env): Promise<ModelTierConfig> {
	// The OpenRouter branch keys off the same condition as the sync paths, so a
	// deployment whose primary provider is not openai keeps its own tiers. A
	// non-OpenRouter deployment primes nothing: there is no catalog to settle,
	// and getDefaultTierConfig would not consult one.
	if (!usesOpenRouterPrimary(env)) return nonOpenRouterTierConfig(env)
	return buildOpenRouterTierConfig(env)
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

/**
 * The tier mapping for an OpenAI-compatible deployment.
 *
 * Single source of truth for the three sync/async entry points that used to
 * each hand-roll this same object, which is how they drifted apart. Prefers the
 * catalog's picks when the catalog has been primed, so a primed deployment
 * routes background callers through the same models the answering turn uses.
 */
function openRouterTierConfig(): ModelTierConfig {
	const picked = catalogMainTurnModels()
	return {
		fast: OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL,
		balanced: picked?.[0] ?? OPENROUTER_MAIN_MODEL,
		strong: picked?.[1] ?? OPENROUTER_ESCALATION_MODEL,
		long: picked?.[1] ?? OPENROUTER_ESCALATION_MODEL,
	}
}

/**
 * Tier config for a deployment that is not on an OpenAI-compatible endpoint.
 * The catalog is an OpenRouter concept and has no say here.
 */
function nonOpenRouterTierConfig(env: Env): ModelTierConfig {
	const providers = availableProviders(env)
	if (providers.includes("anthropic")) {
		return {
			fast: TRIAGE_MODEL,
			balanced: "claude-sonnet-5" as SupportedModel,
			strong: BRAIN_MODEL,
			long: BRAIN_MODEL,
		}
	}
	if (providers.includes("google")) {
		const m = "gemini-3.8-flash" as SupportedModel
		return { fast: m, balanced: m, strong: m, long: m }
	}
	if (providers.includes("xai")) {
		const m = "grok-4.5" as SupportedModel
		return { fast: m, balanced: m, strong: m, long: m }
	}
	return {
		fast: TRIAGE_MODEL,
		balanced: BRAIN_FALLBACK_MODEL,
		strong: BRAIN_MODEL,
		long: BRAIN_MODEL,
	}
}

/** True when the OpenAI-compatible endpoint is this deployment's primary route. */
function usesOpenRouterPrimary(env: Env): boolean {
	return Boolean(openAiCompatibleBaseUrl(env)) && availableProviders(env)[0] === "openai"
}

/** Default tier configuration - maps to available models based on provider */
async function getDefaultTierConfig(env: Env): Promise<ModelTierConfig> {
	// On OpenRouter the catalog decides the tiers; everywhere else the catalog is
	// an OpenRouter concept with no say, so the provider table stands.
	if (usesOpenRouterPrimary(env)) return buildOpenRouterTierConfig(env)
	return nonOpenRouterTierConfig(env)
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
	if (usesOpenRouterPrimary(env)) {
		return openRouterTierConfig()[tier]
	}
	return nonOpenRouterTierConfig(env)[tier]
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
	const config = usesOpenRouterPrimary(env)
		? // On OpenRouter: the cheap paid model answers, the frontier model is
			// the escalation hop for hard turns, and the free models stay on the
			// read-only triage path. This previously routed strong and long to
			// the free 550B model, so a "comprehensive research" task silently
			// ran on a free model while the async path escalated to gpt-5.6.
			openRouterTierConfig()
		: nonOpenRouterTierConfig(env)

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