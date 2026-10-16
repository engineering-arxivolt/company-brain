import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createXai } from "@ai-sdk/xai"
import type { LanguageModel } from "ai"
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
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

/** "1"/"true"/"yes"/"on" (case- and whitespace-insensitive) to let a free
 * OpenRouter model answer the main turn.
 * Off by default: the answering turn writes to memory/GitHub/Linear/Notion.
 * Opt in only when paid hops are out of credits (e.g. GLM exhausted).
 *
 * Parsed forgivingly because the value round-trips through wrangler.jsonc, the
 * dashboard and CI substitutions, where "TRUE " or "1 " must not silently read
 * as "off" — the escape hatch failing closed looks exactly like the outage it
 * exists to survive. */
export function allowFreeMainTurn(env: Env): boolean {
	const v = env.BRAIN_ALLOW_FREE_MAIN_TURN as unknown
	if (v === true) return true
	if (typeof v !== "string") return false
	const normalized = v.trim().toLowerCase()
	return (
		normalized === "1" ||
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on"
	)
}

/**
 * Free models to fall back to when the `openai` provider is really an
 * OpenAI-compatible endpoint (OpenRouter, Workers AI): OpenAI's own model ids
 * don't exist there. Triage runs on every message, so it takes the light one.
 *
 * Live-catalog verified 2026-10-16: `qwen/qwen3.8-27b:free` is GONE (404, the
 * old triage pin resolves via getModelInfo fallback to xAI grok!) and
 * `nemotron-3-ultra:free` lacks `response_format`, so triage/JSON paths
 * silently degrade. `nemotron-3-super:free` (120B MoE, 12B active, 262k ctx)
 * has tools + response_format + structured_outputs — closest free agentic
 * stand-in for GLM-5.3-flash. `gemma-4-31b-it:free` (dense 31B, 262k) is the
 * light triage pin with the same capability pair.
 */
export const OPENAI_COMPATIBLE_FALLBACK_MODEL: SupportedModel = "nemotron-3-super-free"
export const OPENAI_COMPATIBLE_TRIAGE_FALLBACK_MODEL: SupportedModel =
	"gemma-4-31b-free"

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
 *
 * This is the floor used when the OpenRouter catalog has not been primed (or
 * could not be reached). When it has, `setCatalogMainTurnModels` replaces it
 * with the catalog's own picks — see `catalogMainTurnModels`.
 */
const AUTO_ADDED_MAIN_TURN_MODELS: readonly SupportedModel[] = [
	OPENROUTER_MAIN_MODEL,
	OPENROUTER_ESCALATION_MODEL,
]

// ── Catalog-derived answering hops ───────────────────────────────────────────
//
// `brainChainModelNames` is synchronous — the provider factory needs a concrete
// model per candidate — so it cannot itself await the OpenRouter catalog. The
// catalog is therefore settled once, ahead of the chain (see primeOpenRouterTiers
// in model-router), and published here for the chain to read synchronously.
//
// This is what makes the catalog actually decide the answering turn. Without it
// the catalog is fetched, classified, registered and priced, and then the chain
// ignores all of it and runs the hardcoded pair above.
//
// `null` means "not primed or the catalog could not be reached", which is the
// signal to use the pinned pair. A failed catalog must not silently change which
// model serves a turn, so only a successful classification overwrites this.
let catalogMainTurnModelsState: readonly SupportedModel[] | null = null

/**
 * Publish the catalog's chosen answering hops, in chain order.
 *
 * Only ever called with paid models UNLESS the deployment opts into
 * BRAIN_ALLOW_FREE_MAIN_TURN=1 (paid hops out of credits, e.g. GLM exhausted):
 * the answering turn owns the tools that write to memory and to
 * GitHub/Linear/Notion, and a free model's plausible inventions get persisted
 * and served back to the team as fact. A free hop is rejected here rather than
 * downstream, because by the time the chain filters for free models a rejected
 * call would have left the chain one hop short.
 */
export function setCatalogMainTurnModels(
	models: readonly SupportedModel[],
	env?: Env,
): void {
	// Opt-in escape hatch: no paid hops left, operator accepts the risk.
	if (env && allowFreeMainTurn(env)) {
		catalogMainTurnModelsState = [...models]
		return
	}
	const paid = models.filter((name) => !isFreeModel(name))
	if (paid.length === 0) {
		console.log(
			`[company-brain] catalog offered only free models for the answering chain, keeping the pinned models: ${models.join(", ")}`,
		)
		return
	}
	if (paid.length < models.length) {
		console.log(
			`[company-brain] dropping free model(s) from the catalog answering chain: ${models
				.filter(isFreeModel)
				.join(", ")}`,
		)
	}
	catalogMainTurnModelsState = paid
}

/** The catalog's answering hops, or null when the catalog has not settled one. */
export function catalogMainTurnModels(): readonly SupportedModel[] | null {
	return catalogMainTurnModelsState
}

/** Test seam: forget the catalog's picks, restoring the pinned pair. */
export function clearCatalogMainTurnModels(): void {
	catalogMainTurnModelsState = null
}

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
 *
 * Checks the catalog's picks too when they have been primed, since those are
 * what the chain actually uses at that point.
 */
export function autoAddedMainTurnHasFreeModel(): boolean {
	return autoAddedMainTurnModels().some(isFreeModel)
}

/** The hops auto-added to the answering turn right now, catalog or pinned. */
export function autoAddedMainTurnModels(): readonly SupportedModel[] {
	return catalogMainTurnModels() ?? AUTO_ADDED_MAIN_TURN_MODELS
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
			console.log(
				`[company-brain][diag] openai-chat model=${modelName} modelId=${modelId} baseURL=${baseURL} keyPrefix=${apiKey?.slice(0, 7) ?? "none"} keyLen=${apiKey?.length ?? 0}`,
			)
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

/** Why a candidate failed in a way the chain survives by hopping on. */
export type PoolFailure =
	/** Out of credits: a 402, or a 429 whose message names the free daily pool. */
	| "exhausted"
	/** A momentary 429: retry, don't top up. */
	| "rate_limited"

/**
 * Classifies a failure the chain is willing to survive by trying the next
 * candidate. `null` means the error is not a provider capacity problem and
 * must propagate untouched so real bugs stay visible.
 *
 * A 429 is ambiguous: OpenRouter uses it both for "free-models-per-day" (a
 * quota — the fix is credits) and for momentary throttling (the fix is
 * retrying). The message disambiguates. Treating every 429 as exhaustion made
 * a single busy minute look like a drained account and served users the
 * "add credits" notice for a condition that clears itself.
 */
export function classifyPoolFailure(error: unknown): PoolFailure | null {
	const status = errorStatus(error)
	if (status === 402) return "exhausted"
	if (status === 429) return isQuotaMessage(error) ? "exhausted" : "rate_limited"
	return isQuotaMessage(error) ? "exhausted" : null
}

/**
 * True when a failure is one the chain survives by trying the next candidate.
 * Broader than "exhausted": a momentary 429 is worth another hop even though
 * it must not produce the "add credits" notice. See `classifyPoolFailure`.
 */
export function isPoolExhausted(error: unknown): boolean {
	return classifyPoolFailure(error) !== null
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
 * Tries each candidate in order and, only when every one failed with a
 * capacity error AND at least one was genuinely out of quota, answers with
 * `degradedText`. Without an AI Gateway the SDK only ever called the first
 * candidate, so a second provider key bought nothing; this is what makes the
 * chain real. Non-quota errors (bad request, tool failure, network) propagate
 * untouched so real bugs stay visible.
 *
 * The degraded result is tagged in `providerMetadata` so telemetry can record a
 * total outage as the error it is — otherwise it looks in PostHog like a fast,
 * successful generation by whichever model was tried last. The `exhausted`
 * list names the hops that failed, so the marker says which endpoint to top up.
 *
 * `degradedText: null` rethrows the quota error instead of serving a notice.
 * Background callers want that: triage, the post-turn observer and the approval
 * classifier each have their own recovery, and a user-facing notice would be
 * captured as a result — the observer would write "service is degraded" into the
 * team's memory as a durable note.
 *
 * A chain where every failure was a momentary 429 also rethrows: "add credits"
 * is wrong advice for a rate limit, and the caller's own retry — or the user's
 * next message — is the remedy that works.
 */
export function withFallbackChain(
	models: LanguageModel[],
	degradedText: string | null = DEGRADED_NOTICE,
): LanguageModel {
	const chain = models.filter((model): model is LanguageModel => Boolean(model))
	const head = chain[0] as unknown as LanguageModelV3 | undefined
	if (!head) throw new Error("[company-brain] no model candidates provided")

	// Every candidate is a v3 model (verified across the google, anthropic,
	// openai and xai providers), so this wrapper must report v3 too. Labelling
	// it "v2" put the whole chain into the SDK's v2 compatibility shim, which
	// re-converts results that are already v3-shaped: `finishReason` arrived as an
	// object instead of a string, and `usage.inputTokens` arrived as the string
	// "0[object Object]", so token-based billing silently recorded zero. It also
	// printed a spurious "v2 specification compatibility mode" warning naming
	// whichever model was chain head, which read as a routing error.
	const noUsage: LanguageModelV3Usage = {
		inputTokens: {
			total: undefined,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: undefined, text: undefined, reasoning: undefined },
	}

	return {
		specificationVersion: "v3",
		modelId: head.modelId,
		provider: head.provider,
		supportedUrls: head.supportedUrls,
		async doGenerate(options: LanguageModelV3CallOptions) {
			let lastError: unknown
			const exhausted: string[] = []
			const rateLimited: string[] = []
			for (const model of chain) {
				const candidate = model as unknown as LanguageModelV3
				try {
					return await candidate.doGenerate(options)
				} catch (err) {
					const failure = classifyPoolFailure(err)
					if (!failure) throw err
					lastError = err
					const id = `${candidate.provider}/${candidate.modelId}`
					if (failure === "rate_limited") {
						rateLimited.push(id)
						console.log(
							`[company-brain] ${id} rate-limited (status=${errorStatus(err) ?? "unknown"}); trying next candidate`,
						)
					} else {
						exhausted.push(id)
						console.log(
							`[company-brain] ${id} out of quota (status=${errorStatus(err) ?? "unknown"}); trying next candidate`,
						)
					}
				}
			}
			// Background callers opt out of the notice and handle the error themselves.
			if (degradedText === null) throw lastError
			// The notice claims an account problem ("out of quota"). A chain that
			// only ever hit momentary 429s has no exhausted hop to name and will
			// answer on retry, so rethrow instead of telling the user to pay.
			if (exhausted.length === 0) {
				console.log(
					`[company-brain] every model candidate rate-limited (${rateLimited.join(",")}); no hop exhausted, rethrowing`,
				)
				throw lastError
			}
			console.log(
				`[company-brain] every model candidate out of quota; serving degraded notice exhausted=${exhausted.join(",")}${rateLimited.length > 0 ? ` rateLimited=${rateLimited.join(",")}` : ""}`,
			)
			return {
				content: [{ type: "text" as const, text: degradedText }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage: noUsage,
				warnings: [],
				providerMetadata: degradedMetadata(exhausted),
			}
		},
		async doStream(options: LanguageModelV3CallOptions) {
			let lastError: unknown
			const exhausted: string[] = []
			const rateLimited: string[] = []
			for (const model of chain) {
				const candidate = model as unknown as LanguageModelV3
				try {
					return await candidate.doStream(options)
				} catch (err) {
					const failure = classifyPoolFailure(err)
					if (!failure) throw err
					lastError = err
					const id = `${candidate.provider}/${candidate.modelId}`
					if (failure === "rate_limited") {
						rateLimited.push(id)
						console.log(
							`[company-brain] ${id} rate-limited (status=${errorStatus(err) ?? "unknown"}); trying next candidate`,
						)
					} else {
						exhausted.push(id)
						console.log(
							`[company-brain] ${id} out of quota (status=${errorStatus(err) ?? "unknown"}); trying next candidate`,
						)
					}
				}
			}
			if (degradedText === null) throw lastError
			// Same rule as doGenerate: a rate-limit-only chain must not masquerade
			// as a drained account.
			if (exhausted.length === 0) {
				console.log(
					`[company-brain] every model candidate rate-limited (${rateLimited.join(",")}); no hop exhausted, rethrowing`,
				)
				throw lastError
			}
			console.log(
				`[company-brain] every model candidate out of quota; serving degraded notice exhausted=${exhausted.join(",")}${rateLimited.length > 0 ? ` rateLimited=${rateLimited.join(",")}` : ""}`,
			)
			const metadata = degradedMetadata(exhausted)
			const stream = new ReadableStream<LanguageModelV3StreamPart>({
				start(controller) {
					controller.enqueue({ type: "text-start", id: "0" })
					controller.enqueue({ type: "text-delta", id: "0", delta: degradedText })
					controller.enqueue({ type: "text-end", id: "0" })
					controller.enqueue({
						type: "finish",
						finishReason: { unified: "stop", raw: undefined },
						usage: noUsage,
						providerMetadata: metadata,
					})
					controller.close()
				},
			})
			return { stream }
		},
	} satisfies LanguageModelV3 as unknown as LanguageModel
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

function isQuotaMessage(error: unknown): boolean {
	let matched = false
	walkErrorChain(error, (record) => {
		for (const key of ["message", "responseBody"]) {
			const text = record[key]
			if (
				typeof text === "string" &&
				/(free-models-per-day|insufficient[ _-]?(?:credits|quota)|quota exceeded|out of credits)/i.test(
					text,
				)
			) {
				matched = true
			}
		}
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
 *   quota, and never a free model — see `isFreeModel` — with one exception: a
 *   free model the operator picked in Settings is kept as the last hop.
 *   Background callers —
 *   triage, the post-turn observer, the approval classifier — leave it off: they
 *   keep the cheap model they resolved and handle quota errors with their own
 *   recovery rather than showing a user-facing notice. Those paths are
 *   read-only, so a free model is acceptable there.
 *
 * Applies the write-path rule: a free model is dropped unless dropping it
 * would leave nothing — a deployment with no paid provider at all, kept rather
 * than failing the turn outright — or unless the operator explicitly picked
 * that free model in Settings, in which case it is kept as the chain's last
 * hop so an exhausted paid tier falls through to it. Both cases are logged.
 */
export function brainChainModelNames(
	modelName: SupportedModel,
	env: Env,
	options: { mainTurn?: boolean } = {},
): SupportedModel[] {
	const resolved = resolveModel(modelName, env)
	const gateway = hasBrainGateway(env)
	const candidates: SupportedModel[] = []
	// fronts a cheap cached main model and a frontier escalation model, so one
	// key covers more quota than any single provider. The cheap model leads and
	// the frontier model follows as an escalation hop rather than a default.
	//
	// The hops come from the live catalog when it has been primed (see
	// setCatalogMainTurnModels), so the catalog decides the chain rather than
	// being fetched, classified and discarded. The pinned pair is the floor for
	// a deployment that has not primed it or could not reach it.
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
		// Credits exhausted (e.g. GLM out): answer from the free hop first
		// instead of burning two failed paid calls (latency + 429 noise)
		// before falling through to it.
		if (allowFreeMainTurn(env)) {
			candidates.push(OPENAI_COMPATIBLE_FALLBACK_MODEL)
		}
		candidates.push(...autoAddedMainTurnModels())
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
	// Escape hatch: BRAIN_ALLOW_FREE_MAIN_TURN=1 keeps the free hop when paid
	// hops are out of credits (e.g. GLM exhausted) instead of degraded-notice.
	if (!options.mainTurn) return deduped
	// The diag line below must run whatever the branch: BRAIN_ALLOW_FREE_MAIN_TURN
	// was exactly the case where the tail used to show no chain at all, because
	// the flag-on path returned before it.
	let survivors = deduped
	if (!allowFreeMainTurn(env)) {
		const paid = deduped.filter((name) => !isFreeModel(name))
		if (paid.length > 0) {
			// Picking a free model in Settings is consent, not accident: the pick
			// is kept as the chain's LAST hop, so an exhausted paid tier falls
			// through to it instead of the degraded notice. Only a pick that
			// resolved to itself qualifies — a free model `resolveModel`
			// substituted in because the picked provider had no key carries no
			// such consent and stays dropped.
			const pickedFree = resolved === modelName && isFreeModel(resolved)
			survivors = pickedFree ? [...paid, resolved] : paid
			const dropped = deduped.filter(
				(name) => isFreeModel(name) && !survivors.includes(name),
			)
			if (dropped.length > 0) {
				console.log(
					`[company-brain] dropping free model(s) from the answering chain: ${dropped.join(", ")}`,
				)
			}
		}
	}
	console.log(
		`[company-brain][diag] chain=${JSON.stringify(survivors)} mainTurn=${options.mainTurn} flag=${allowFreeMainTurn(env)} baseUrl=${openAiCompatibleBaseUrl(env) ?? "none"} openaiKeyPrefix=${env.OPENAI_API_KEY?.slice(0, 7) ?? "none"}`,
	)
	return survivors
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
					(other as unknown as LanguageModelV3).modelId ===
					(model as unknown as LanguageModelV3).modelId,
			) === i,
	)
	return withFallbackChain(unique, options.mainTurn ? DEGRADED_NOTICE : null)
}

function providerHasKey(modelName: SupportedModel, env: Env): boolean {
	return Boolean(providerKey(getModelInfo(modelName).provider, env)?.trim())
}
