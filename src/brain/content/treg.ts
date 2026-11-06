/**
 * Keyword research through the treg connection (treg.to — Google Search
 * Console and keyword data over MCP).
 *
 * The campaign pack needs keywords that people actually search for, not ones
 * a model guesses. treg fronts its data with a small catalog API —
 * `catalog_search` finds endpoints, `catalog_get` describes one, `call` runs
 * it — so the pack builder walks that chain (after checking for a direct
 * keyword tool and the team's own registered tools) and hands the real
 * numbers to the model.
 *
 * Every failure is non-fatal: the pack falls back to the model's own choices.
 * Paid catalog calls are priced before they run and only spend from the
 * team's balance, so an empty wallet quietly degrades to no grounding.
 */
import type { ProviderTool, ToolProviderHandle } from "../tools/mcp/provider"
import {
	extractMcpJson,
	findContentConnection,
	mcpError,
	withContentMcp,
} from "./sources/mcp"

export type TregKeyword = {
	keyword: string
	volume?: number
	difficulty?: number
}

/** treg's catalog plumbing — these answer about tools, never with keywords. */
const META_TOOL_PATTERN =
	/^(catalog_search|catalog_get|catalog_request|call|call_media|my_tools|balance|resources_list|feedback|review)$/i

/** Tools that answer with real search phrases. */
const KEYWORD_TOOL_PATTERN =
	/keyword|keyword.?planner|volume|serp|search.?console|rank|research|suggest/i

/** The team's own registered tools that can answer a keyword question. */
const OWN_KEYWORD_TOOL_PATTERN =
	/keyword|google.?ads|adwords|dataforseo|semrush|ahrefs|serp|moz|similarweb/i

/** Which catalog endpoints are about search demand, not people search. */
const KEYWORD_ENDPOINT_PATTERN =
	/keyword|search.?volume|search.?demand|suggest|ideas|serp|rank|search.?console|trend/i

/** The topic keywords treg can enrich: short search phrases, not sentences. */
export function topicPhrases(topic: string): string[] {
	const words = topic
		.replace(
			/\b(run|a|content|campaign|pack|on|the|for|please|make|write|about|biggest|story|right now)\b/gi,
			" ",
		)
		.replace(/[^a-zA-Z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
	if (!words) return [topic.slice(0, 80)]
	return [words.slice(0, 60)]
}

function pickNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value
	}
	return undefined
}

/** Google Ads reports monthly volumes as strings; average them per keyword. */
function averageMonthlyVolume(value: unknown): number | undefined {
	if (!Array.isArray(value)) return undefined
	const months = value
		.map((entry) => {
			if (!entry || typeof entry !== "object") return undefined
			return (entry as Record<string, unknown>).monthlySearches
		})
		.map((raw) => {
			if (typeof raw === "number") return raw
			if (typeof raw === "string") return Number(raw.replace(/[^0-9.]/g, ""))
			return Number.NaN
		})
		.filter((count) => Number.isFinite(count) && count > 0)
	if (!months.length) return undefined
	return Math.round(months.reduce((sum, count) => sum + count, 0) / months.length)
}

/** Turn whatever treg returns into a plain keyword list. */
export function parseKeywords(payload: unknown): TregKeyword[] {
	const out: TregKeyword[] = []
	const seen = new Set<string>()
	const push = (keyword: string, volume?: number, difficulty?: number) => {
		const clean = keyword.trim().slice(0, 80)
		if (!clean || seen.has(clean.toLowerCase())) return
		seen.add(clean.toLowerCase())
		out.push({
			keyword: clean,
			...(volume !== undefined ? { volume } : {}),
			...(difficulty !== undefined ? { difficulty } : {}),
		})
	}
	const visit = (node: unknown, depth: number, bare: boolean) => {
		// MCP envelopes and provider wrappers nest deep: content → text JSON →
		// tasks → result → items → keyword is already ten levels.
		if (out.length >= 12 || depth > 12) return
		if (Array.isArray(node)) {
			// Arrays of strings are keyword lists; object fields are not.
			for (const item of node) visit(item, depth + 1, true)
			return
		}
		if (typeof node === "object" && node !== null) {
			const record = node as Record<string, unknown>
			// Google Ads puts the phrase in `text` and the numbers under
			// `keywordMetrics`; handle that shape before the generic aliases.
			const metrics = record.keywordMetrics
			if (
				typeof record.text === "string" &&
				record.text.trim() &&
				metrics &&
				typeof metrics === "object"
			) {
				const m = metrics as Record<string, unknown>
				push(
					record.text,
					pickNumber(m.avgMonthlySearches, m.avg_monthly_searches) ??
						averageMonthlyVolume(m.monthlySearchVolumes),
					pickNumber(m.competitionIndex, m.competition_index),
				)
				return
			}
			const keyword =
				(typeof record.keyword === "string" && record.keyword.trim()) ||
				(typeof record.keyword_string === "string" &&
					record.keyword_string.trim()) ||
				(typeof record.query === "string" && record.query.trim()) ||
				(typeof record.term === "string" && record.term.trim()) ||
				(typeof record.phrase === "string" && record.phrase.trim()) ||
				(typeof record.name === "string" && record.name.trim()) ||
				null
			if (keyword) {
				push(
					keyword,
					pickNumber(
						record.volume,
						record.search_volume,
						record.avg_monthly_searches,
					),
					pickNumber(record.difficulty, record.kd, record.competition_index),
				)
				return
			}
			// Walk the values, but never the MCP envelope's `type` discriminator:
			// {content:[{type:"text",text:...}]} would otherwise yield "text" as a
			// keyword ahead of the real payload.
			for (const [key, value] of Object.entries(record)) {
				if (key === "type") continue
				visit(value, depth + 1, false)
			}
			return
		}
		// A string may be a bare keyword — or a nested JSON payload (MCP text
		// results), which is parsed and walked before giving up.
		if (typeof node === "string" && node.trim()) {
			const trimmed = node.trim()
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					visit(JSON.parse(trimmed), depth + 1, bare)
					return
				} catch {}
			}
			if (
				bare &&
				trimmed.length <= 80 &&
				!trimmed.includes("\n") &&
				!/^(ok|true|false|null|\d+)$/.test(trimmed) &&
				!/^https?:\/\//i.test(trimmed)
			) {
				push(trimmed)
			}
		}
	}
	visit(payload, 0, false)
	return out
}

/**
 * Whether a provider payload is an error rather than data. treg's `call`
 * reports provider failures inside a 200 response (`status`, `error`,
 * `whose_error`), and parsing those would turn error prose into "keywords".
 */
export function looksLikeProviderError(payload: unknown): boolean {
	const isError = (value: unknown): boolean => {
		if (!value || typeof value !== "object") return false
		const record = value as Record<string, unknown>
		if (typeof record.status === "number" && record.status >= 400) return true
		if (record.error) return true
		if (typeof record.whose_error === "string" && record.whose_error) return true
		if (record.ok === false) return true
		return false
	}
	if (isError(payload)) return true
	return isError((payload as { body?: unknown } | null)?.body)
}

export type CatalogEndpoint = {
	endpointId: string
	name: string
	provider: string
	job: string
	usdPerCall: number | null
	/** treg serves it on its own provider key, so no credential is needed. */
	noKeyNeeded: boolean
}

function toCatalogEndpoint(value: unknown): CatalogEndpoint | null {
	if (!value || typeof value !== "object") return null
	const record = value as Record<string, unknown>
	const endpointId =
		typeof record.endpoint_id === "string" ? record.endpoint_id.trim() : ""
	if (!endpointId) return null
	return {
		endpointId,
		name: typeof record.name === "string" ? record.name : "",
		provider: typeof record.provider === "string" ? record.provider : "",
		job: typeof record.job === "string" ? record.job : "",
		usdPerCall:
			typeof record.usd_per_call === "number" ? record.usd_per_call : null,
		noKeyNeeded: record.no_key_needed === true,
	}
}

/**
 * The catalog endpoints worth calling, best first: on-topic for search
 * demand, affordable from the team's balance, the team's own providers ahead
 * of treg's paid route, then cheapest. Endpoints with no published price are
 * skipped — they cannot be budget-guarded.
 */
export function pickCatalogEndpoints(
	payload: unknown,
	balanceUsd: number,
	ownTools: readonly string[] = [],
	limit = 3,
): CatalogEndpoint[] {
	const record = (payload ?? {}) as Record<string, unknown>
	const list = Array.isArray(record.results)
		? record.results
		: Array.isArray(payload)
			? payload
			: []
	const own = new Set(ownTools.map((name) => name.toLowerCase()))
	const affordable = list
		.map(toCatalogEndpoint)
		.filter((endpoint): endpoint is CatalogEndpoint => endpoint !== null)
		.filter(
			(endpoint) =>
				endpoint.usdPerCall !== null &&
				endpoint.usdPerCall <= balanceUsd &&
				KEYWORD_ENDPOINT_PATTERN.test(
					`${endpoint.name} ${endpoint.job} ${endpoint.provider}`,
				),
		)
	const rank = (endpoint: CatalogEndpoint) =>
		own.has(endpoint.provider.toLowerCase()) ? 0 : 1
	affordable.sort(
		(a, b) => rank(a) - rank(b) || (a.usdPerCall ?? 0) - (b.usdPerCall ?? 0),
	)
	return affordable.slice(0, limit)
}

/** The team's own keyword-capable tool, from a `my_tools` payload. */
export function pickOwnKeywordTool(payload: unknown): string | null {
	const record = (payload ?? {}) as Record<string, unknown>
	const list = Array.isArray(record.tools) ? record.tools : []
	for (const value of list) {
		if (!value || typeof value !== "object") continue
		const tool = value as Record<string, unknown>
		const name = typeof tool.name === "string" ? tool.name.trim() : ""
		if (!name) continue
		const haystack = [
			name,
			typeof tool.base_url === "string" ? tool.base_url : "",
			typeof tool.description === "string" ? tool.description : "",
		].join(" ")
		if (OWN_KEYWORD_TOOL_PATTERN.test(haystack)) return name
	}
	return null
}

/** A keyword tool the connection exposes directly. */
export function pickKeywordTool(
	tools: readonly ProviderTool[],
): ProviderTool | null {
	return (
		tools.find(
			(tool) =>
				!META_TOOL_PATTERN.test(tool.name) && KEYWORD_TOOL_PATTERN.test(tool.name),
		) ?? null
	)
}

/** Customer ids from `customers:listAccessibleCustomers` (`customers/123` → `123`). */
export function parseAccessibleCustomers(payload: unknown): string[] {
	const names = (payload as { resourceNames?: unknown } | null)?.resourceNames
	if (!Array.isArray(names)) return []
	return names
		.map((name) => (typeof name === "string" ? name.trim() : ""))
		.map((name) => name.replace(/^customers\//, ""))
		.filter((id) => /^\d+$/.test(id))
}

/**
 * The customer id to put in an endpoint's path: the template's own id when the
 * team can reach it, otherwise the first account their login actually owns.
 * treg's templates hardcode an example id, which 403s for everyone else.
 */
export function resolveCustomerId(
	templateCustomerId: string | undefined,
	accessible: readonly string[],
): string | undefined {
	if (templateCustomerId && accessible.includes(templateCustomerId)) {
		return templateCustomerId
	}
	return accessible[0] ?? templateCustomerId
}

/** Argument spellings a direct keyword tool might accept. */
function directShapes(phrase: string): Record<string, unknown>[] {
	return [{ keyword: phrase }, { query: phrase }, { topic: phrase }]
}

/**
 * The endpoint's own `call_template` — the authoritative way to call it:
 * `treg call <id> --method POST --query customer_id=… --data '{…}'` yields the
 * query parameters and an example body we can fill with the real phrase.
 */
export function parseCallTemplate(details: unknown): {
	method?: string
	query?: Record<string, string>
	body?: unknown
} | null {
	const endpoint = (details as { endpoint?: Record<string, unknown> } | null)
		?.endpoint
	const template =
		typeof endpoint?.call_template === "string" ? endpoint.call_template : ""
	if (!template) return null
	const method = template.match(/--method\s+([A-Za-z]+)/)?.[1]?.toUpperCase()
	const query: Record<string, string> = {}
	for (const match of template.matchAll(/--query\s+([^\s=]+)=(\S+)/g)) {
		const [, name, value] = match
		if (name && value) query[name] = value
	}
	const data = template.match(/--data\s+'([\s\S]*?)'(?=\s+--|\s*$)/)?.[1]
	let body: unknown
	if (data) {
		try {
			body = JSON.parse(data)
		} catch {}
	}
	return {
		...(method ? { method } : {}),
		...(Object.keys(query).length ? { query } : {}),
		...(body !== undefined ? { body } : {}),
	}
}

/** Body fields that carry the phrase as a list. */
const PHRASE_LIST_KEYS = /^(?:keywords|kw|terms|search_?terms|queries|phrases)$/i

/** Body fields that carry the phrase as a single string. */
const PHRASE_TEXT_KEYS = /^(?:keyword|query|q|term|phrase|search_?term)$/i

/** Fill a template body with the real phrase, keeping its provider defaults. */
export function withPhrase(body: unknown, phrase: string): unknown {
	if (Array.isArray(body)) {
		// DataForSEO live routes take a one-element array body.
		if (body.length === 1 && body[0] && typeof body[0] === "object") {
			return [withPhrase(body[0], phrase)]
		}
		return [phrase]
	}
	if (!body || typeof body !== "object") return { keywords: [phrase] }
	const record = { ...(body as Record<string, unknown>) }
	let replaced = false
	for (const [key, value] of Object.entries(record)) {
		const isText = typeof value === "string"
		const isTextList =
			Array.isArray(value) && value.every((item) => typeof item === "string")
		if (!isText && !isTextList) continue
		// `keywordPlanNetwork` and friends are settings, not the phrase.
		if (PHRASE_LIST_KEYS.test(key)) {
			record[key] = [phrase]
			replaced = true
		} else if (PHRASE_TEXT_KEYS.test(key)) {
			record[key] = phrase
			replaced = true
		}
	}
	if (!replaced) record.keywords = [phrase]
	return record
}

/** `call` arguments for an endpoint: its own template first, then a generic body. */
function callArgsFor(
	endpoint: CatalogEndpoint,
	details: unknown,
	phrase: string,
	customerId?: string,
): Record<string, unknown>[] {
	const template = parseCallTemplate(details)
	const query = { ...(template?.query ?? {}) }
	if (customerId) query.customer_id = customerId
	const base = {
		endpoint_id: endpoint.endpointId,
		method: template?.method ?? "POST",
		...(Object.keys(query).length ? { query } : {}),
	}
	const args: Record<string, unknown>[] = []
	if (template?.body !== undefined) {
		args.push({ ...base, params: withPhrase(template.body, phrase) })
	}
	args.push({ ...base, params: { keywords: [phrase] } })
	return args
}

/** Try every phrase/argument spelling until one answers with keywords. */
async function attemptShapes(
	handle: ToolProviderHandle,
	toolName: string,
	phrases: readonly string[],
	shapes: (phrase: string) => Record<string, unknown>[],
	traceId: string,
	maxAttempts = 4,
): Promise<TregKeyword[]> {
	let attempts = 0
	for (const phrase of phrases) {
		for (const args of shapes(phrase)) {
			// Paid endpoints bill per call: never try more shapes than the
			// caller's budget allows.
			if (attempts >= maxAttempts) return []
			attempts++
			try {
				const result = await handle.callTool(toolName, args, {
					retryOnTimeout: false,
				})
				const error = mcpError(result)
				if (error) {
					console.log(
						`[company-brain][${traceId}] treg ${toolName} returned an error: ${error}`,
					)
					continue
				}
				// The MCP result nests content: text payloads and structured
				// JSON; parseKeywords unwraps both shapes.
				const payload = extractMcpJson(result) ?? result
				// treg reports provider failures inside a 200 response; error
				// prose must never become "keywords".
				if (looksLikeProviderError(payload)) {
					console.log(
						`[company-brain][${traceId}] treg ${toolName} provider error: ${JSON.stringify(payload).slice(0, 220)}`,
					)
					continue
				}
				const keywords = parseKeywords(payload)
				if (keywords.length) return keywords
				console.log(
					`[company-brain][${traceId}] treg ${toolName} answered without usable keywords`,
				)
			} catch (error) {
				console.log(
					`[company-brain][${traceId}] treg ${toolName} arg-shape failed:`,
					error instanceof Error ? error.message : String(error),
				)
			}
		}
	}
	return []
}

/** The team's balance in USD, or 0 when it cannot be read (no paid calls). */
async function readBalance(
	handle: ToolProviderHandle,
	traceId: string,
): Promise<number> {
	try {
		const result = await handle.callTool("balance", {}, { retryOnTimeout: false })
		if (mcpError(result)) return 0
		const payload = extractMcpJson(result) as Record<string, unknown> | null
		const usd = pickNumber(payload?.balance_usd)
		if (usd !== undefined) return usd
		const micro = pickNumber(payload?.balance_micro)
		return micro !== undefined ? micro / 1_000_000 : 0
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] treg balance failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return 0
	}
}

/** The team's own registered tools, and the first that can answer keywords. */
async function readOwnTools(
	handle: ToolProviderHandle,
	traceId: string,
): Promise<{ names: string[]; keywordTool: string | null }> {
	try {
		const result = await handle.callTool("my_tools", {}, {
			retryOnTimeout: false,
		})
		if (mcpError(result)) return { names: [], keywordTool: null }
		const payload = extractMcpJson(result)
		const list = (payload as { tools?: unknown } | null)?.tools
		const names = Array.isArray(list)
			? list
				.map((entry) => {
					if (!entry || typeof entry !== "object") return ""
					const name = (entry as Record<string, unknown>).name
					return typeof name === "string" ? name.trim() : ""
				})
				.filter(Boolean)
			: []
		return { names, keywordTool: pickOwnKeywordTool(payload) }
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] treg my_tools failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return { names: [], keywordTool: null }
	}
}

/**
 * The Google Ads accounts this team's login can reach. treg's catalog
 * templates carry an example customer id, which 403s for everyone else.
 */
async function readAccessibleCustomers(
	handle: ToolProviderHandle,
	traceId: string,
): Promise<string[]> {
	try {
		const result = await handle.callTool(
			"call",
			{ endpoint_id: "google-ads.accounts", method: "GET" },
			{ retryOnTimeout: false },
		)
		if (mcpError(result)) return []
		const payload = extractMcpJson(result)
		if (looksLikeProviderError(payload)) return []
		const ids = parseAccessibleCustomers(
			(payload as { body?: unknown } | null)?.body ?? payload,
		)
		if (ids.length) {
			console.log(
				`[company-brain][${traceId}] treg google-ads: accessible customers ${ids.join(",")}`,
			)
		}
		return ids
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] treg google-ads accounts failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return []
	}
}

/**
 * treg's paid path: find affordable keyword endpoints in the catalog and
 * describe each before anything is spent. The balance comes back with them so
 * the caller can stop when the money runs out.
 */
async function findCatalogCandidates(
	handle: ToolProviderHandle,
	ownTools: readonly string[],
	traceId: string,
): Promise<{
	balanceUsd: number
	candidates: { endpoint: CatalogEndpoint; details: unknown }[]
}> {
	try {
		const search = await handle.callTool(
			"catalog_search",
			{ query: "keyword search volume", limit: 8 },
			{ retryOnTimeout: false },
		)
		const error = mcpError(search)
		if (error) {
			console.log(
				`[company-brain][${traceId}] treg catalog_search failed: ${error}`,
			)
			return { balanceUsd: 0, candidates: [] }
		}
		const balanceUsd = await readBalance(handle, traceId)
		const endpoints = pickCatalogEndpoints(
			extractMcpJson(search),
			balanceUsd,
			ownTools,
		)
		if (!endpoints.length) {
			console.log(
				`[company-brain][${traceId}] treg catalog: no affordable keyword endpoint (balance $${balanceUsd.toFixed(6)})`,
			)
			return { balanceUsd, candidates: [] }
		}
		const candidates: { endpoint: CatalogEndpoint; details: unknown }[] = []
		for (const endpoint of endpoints) {
			// catalog_get is free and carries the authoritative price at
			// endpoint.cost.usd, plus the call template used below.
			const details = await handle
				.callTool(
					"catalog_get",
					{ endpoint_id: endpoint.endpointId },
					{ retryOnTimeout: false },
				)
				.catch(() => null)
			const payload = extractMcpJson(details) as {
				endpoint?: { cost?: { usd?: unknown } }
			} | null
			const price = pickNumber(payload?.endpoint?.cost?.usd)
			console.log(
				`[company-brain][${traceId}] treg catalog: ${endpoint.endpointId} at $${(price ?? endpoint.usdPerCall ?? 0).toFixed(6)}/call`,
			)
			candidates.push({
				endpoint:
					price !== undefined ? { ...endpoint, usdPerCall: price } : endpoint,
				details,
			})
		}
		return { balanceUsd, candidates }
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] treg catalog lookup failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return { balanceUsd: 0, candidates: [] }
	}
}

/**
 * Ask treg for keyword data on the topic.
 *
 * Preference order: a direct keyword tool on the connection, then treg's
 * catalog (`catalog_search` → `catalog_get` → `call`) — preferring endpoints
 * served by the team's own registered tools and never spending past the
 * balance. Returns [] on any failure; the pack then falls back to the model's
 * own keywords.
 */
export async function tregKeywords(
	env: Env,
	orgId: string,
	userId: string | undefined,
	topic: string,
	traceId: string,
): Promise<TregKeyword[]> {
	try {
		const connection = await findContentConnection(
			env,
			orgId,
			userId,
			(candidate) => candidate.serverSlug === "treg",
		)
		if (!connection) {
			console.log(
				`[company-brain][${traceId}] treg: no connection, skipping keyword grounding`,
			)
			return []
		}
		return await withContentMcp(env, connection, async (handle) => {
			const tools = await handle.listTools()
			const names = tools.map((tool) => tool.name)
			const phrases = topicPhrases(topic)
			const grounded = (keywords: TregKeyword[], via: string) => {
				if (!keywords.length) return false
				console.log(
					`[company-brain][${traceId}] treg keywords=${keywords.length} via ${via}`,
				)
				return true
			}

			// 1. A direct keyword tool answers without treg's catalog plumbing.
			const direct = pickKeywordTool(tools)
			if (direct) {
				const keywords = await attemptShapes(
					handle,
					direct.name,
					phrases,
					directShapes,
					traceId,
				)
				if (grounded(keywords, direct.name)) return keywords
			}

			const callTool = tools.find((tool) => tool.name === "call")

			// 2. The team's own registered tools (google-ads, dataforseo, …)
			// are reached through the catalog too: treg routes to them by
			// endpoint id and serves them on the team's own credential, so the
			// catalog below prefers their providers. A bare tool name is
			// rejected by treg, so nothing is called by name here.
			if (!callTool || !names.includes("catalog_search")) {
				console.log(
					`[company-brain][${traceId}] treg tools=${names.join(",") || "(none)"} — no keyword tool matched`,
				)
				return []
			}
			const own = await readOwnTools(handle, traceId)
			if (own.keywordTool) {
				console.log(
					`[company-brain][${traceId}] treg: preferring the team's own ${own.keywordTool} endpoints`,
				)
			}

			// 3. treg's catalog: search → describe → call, inside the balance.
			const { balanceUsd, candidates } = await findCatalogCandidates(
				handle,
				own.names,
				traceId,
			)
			// Google Ads endpoints take the customer id in the path and treg's
			// template carries an example one, so resolve the account this
			// team's login can actually reach before calling.
			const accessible = candidates.some(
				({ endpoint }) => endpoint.provider === "google-ads",
			)
				? await readAccessibleCustomers(handle, traceId)
				: []
			let remaining = balanceUsd
			for (const { endpoint, details } of candidates) {
				const price = endpoint.usdPerCall ?? 0
				if (price > remaining) continue
				const customerId =
					endpoint.provider === "google-ads"
						? resolveCustomerId(
								parseCallTemplate(details)?.query?.customer_id,
								accessible,
							)
						: undefined
				// Two shapes for a free endpoint; a paid one only gets a second
				// try when the balance covers it twice.
				const maxAttempts = price === 0 || remaining >= price * 2 ? 2 : 1
				const keywords = await attemptShapes(
					handle,
					callTool.name,
					phrases,
					(phrase) => callArgsFor(endpoint, details, phrase, customerId),
					traceId,
					maxAttempts,
				)
				if (grounded(keywords, `call:${endpoint.endpointId}`)) return keywords
				remaining -= price
			}
			return []
		})
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] treg keyword lookup failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return []
	}
}
