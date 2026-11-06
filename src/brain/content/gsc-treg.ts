/**
 * Search Console through treg — the same Google credential that already serves
 * keyword volumes, so no second OAuth grant and no second secret.
 *
 * treg exposes Google APIs as catalog endpoints (`google-ads.accounts`,
 * `google-ads.keywords`, …) reached with `call`, which is how `treg.ts` gets
 * volumes. Search Console is another such endpoint, but its id is not stable
 * enough to hardcode: treg names them per provider version. So the endpoint is
 * discovered by intent (`catalog_search` → match on "search console" /
 * "webmasters"), described with `catalog_get` to pick up its call template, and
 * then called with the date window and dimensions the decision model needs.
 *
 * Everything user-visible fails as a value: a missing connection, a catalog with
 * no GSC endpoint, or a provider error message all come back as
 * `{ ok: false, error }` so the caller can fall back to a token or tell the
 * operator why the numbers are missing.
 */
import { type GscFetchResult, type GscRow, parseGscRows } from "./gsc"
import {
	extractMcpJson,
	findContentConnection,
	mcpError,
	withContentMcp,
} from "./sources/mcp"
import { parseCallTemplate } from "./treg"

const GSC_ENDPOINT_RE = /(search[\s_.-]?console|webmasters|searchanalytics)/i

type CatalogItem = { endpoint_id?: unknown; name?: unknown; job?: unknown; provider?: unknown }

/**
 * The first catalog endpoint that looks like Search Console.
 *
 * `catalog_search` ranks by relevance, so the order is kept and only identity
 * fields are inspected — a paid DataForSEO row that merely mentions
 * "search console" in prose must not win over Google's own endpoint.
 */
export function pickSearchConsoleEndpoint(payload: unknown): string | null {
	const record = (payload ?? {}) as { results?: unknown }
	const list = Array.isArray(record.results) ? record.results : Array.isArray(payload) ? payload : []
	let fallback: string | null = null
	for (const value of list) {
		const item = (value ?? {}) as CatalogItem
		const id = typeof item.endpoint_id === "string" ? item.endpoint_id.trim() : ""
		if (!id) continue
		// Only the identity fields decide: a provider's description can mention
		// "search console" while being a scraper of somebody else's data.
		const identity = `${id} ${typeof item.name === "string" ? item.name : ""}`
		if (!GSC_ENDPOINT_RE.test(identity)) continue
		if (/^(google|gsc)|webmasters|google-search-console/i.test(id)) return id
		fallback ??= id
	}
	return fallback
}

export type GscCallOptions = {
	siteUrl: string
	startDate: string
	endDate: string
	rowLimit?: number
}

/**
 * `call` arguments for a GSC endpoint, built from its own template.
 *
 * The template's query keeps provider defaults (key, quota project, …) but any
 * site/url/property parameter must be ours — treg's template carries an example
 * property, and keeping it is how a request quietly returns another site's rows
 * or a 403.
 */
export function buildGscCallArgs(
	details: unknown,
	options: GscCallOptions,
): { method: string; query?: Record<string, string>; params: Record<string, unknown> } {
	const template = parseCallTemplate(details)
	const query: Record<string, string> = { ...(template?.query ?? {}) }
	for (const key of Object.keys(query)) {
		if (/site|url|property/i.test(key)) query[key] = options.siteUrl
	}
	const base =
		template?.body && typeof template.body === "object" && !Array.isArray(template.body)
			? (template.body as Record<string, unknown>)
			: {}
	const params: Record<string, unknown> = {
		...base,
		startDate: options.startDate,
		endDate: options.endDate,
		dimensions: ["query", "page"],
		rowLimit: options.rowLimit ?? 1_000,
	}
	// The property may live in the template path rather than query/body.
	if (!Object.keys(query).some((key) => /site|url|property/i.test(key))) {
		params.siteUrl = options.siteUrl
	}
	return {
		method: template?.method ?? "POST",
		...(Object.keys(query).length ? { query } : {}),
		params,
	}
}

export type TregGscArgs = GscCallOptions & {
	orgId: string
	userId?: string
	traceId: string
}

export async function tregSearchConsole(env: Env, args: TregGscArgs): Promise<GscFetchResult> {
	try {
		const connection = await findContentConnection(
			env,
			args.orgId,
			args.userId,
			(candidate) => candidate.serverSlug === "treg",
		)
		if (!connection) {
			return { ok: false, error: "treg isn't connected to this workspace — connect it under Settings → Connectors" }
		}
		return await withContentMcp(env, connection, async (handle) => {
			const names = (await handle.listTools()).map((tool) => tool.name)
			if (!names.includes("catalog_search") || !names.includes("call")) {
				return { ok: false, error: `treg exposes no catalog (tools: ${names.join(", ") || "none"})` }
			}
			const search = await handle.callTool(
				"catalog_search",
				{ query: "google search console search analytics query", limit: 10 },
				{ retryOnTimeout: false },
			)
			const searchError = mcpError(search)
			if (searchError) return { ok: false, error: `treg catalog_search failed: ${searchError}` }
			const endpointId = pickSearchConsoleEndpoint(extractMcpJson(search))
			if (!endpointId) return { ok: false, error: "treg's catalog has no Google Search Console endpoint" }

			const details = await handle.callTool("catalog_get", { endpoint_id: endpointId }, { retryOnTimeout: false })
			const detailsError = mcpError(details)
			if (detailsError) return { ok: false, error: `treg catalog_get failed: ${detailsError}` }

			const callArgs = buildGscCallArgs(extractMcpJson(details), args)
			const result = await handle.callTool("call", { endpoint_id: endpointId, ...callArgs }, { retryOnTimeout: false })
			const callError = mcpError(result)
			if (callError) return { ok: false, error: `Search Console via treg failed: ${callError}` }

			const payload = extractMcpJson(result)
			const body =
				payload && typeof payload === "object" && "body" in (payload as Record<string, unknown>)
					? (payload as { body: unknown }).body
					: payload
			const rows: GscRow[] = parseGscRows(body).map((row) => ({ ...row, date: row.date || args.endDate }))
			if (rows.length === 0) {
				return {
					ok: false,
					error: `Search Console returned no rows for ${args.siteUrl} (${args.startDate}→${args.endDate}); the property may not be listed for this Google account`,
				}
			}
			console.log(`[company-brain][${args.traceId}] gsc via treg endpoint=${endpointId} rows=${rows.length}`)
			return { ok: true, rows }
		})
	} catch (error) {
		return {
			ok: false,
			error: `Search Console via treg failed: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
}
