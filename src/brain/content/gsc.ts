/**
 * Google Search Console: the only free, first-party source of query-level truth.
 *
 * Everything else we measure is a proxy. Impressions, clicks, CTR and average
 * position per query *and* per page come from here, and that is exactly the
 * input `growth.scorePage` needs. There is no paid tier worth buying before
 * this data is wired, so the client is deliberately small: one Search Analytics
 * call, one table, one aggregation.
 *
 * Auth is a bearer access token with `webmasters.readonly`. The brain already
 * holds Google grants for Gmail, but those tokens do not carry this scope, so a
 * reconnect with the scope added (or a service account) is required before
 * `fetchGscQueries` can return data. Until then it fails closed with a message
 * that says what is missing instead of pretending there is no traffic.
 */
import type { PageRow } from "./growth"

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"

export type GscRow = {
	/** YYYY-MM-DD of the window end; GSC returns ranges, not per-day rows here. */
	date: string
	query: string
	page: string
	clicks: number
	impressions: number
	ctr: number
	position: number
}

function num(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) ? n : 0
}

/**
 * Parse a `searchAnalytics/query` response with dimensions ["query","page"].
 *
 * GSC omits `rows` entirely when a property has no data, and pads keys with
 * empty strings for dimensions that do not apply. Both are normal, not errors.
 */
export function parseGscRows(payload: unknown): GscRow[] {
	const rec = (payload ?? {}) as { rows?: unknown }
	const rows = Array.isArray(rec.rows) ? rec.rows : []
	return rows.map((row) => {
		const r = (row ?? {}) as Record<string, unknown>
		const keys = Array.isArray(r.keys) ? (r.keys as unknown[]) : []
		return {
			date: typeof r.date === "string" ? r.date : "",
			query: String(keys[0] ?? ""),
			page: String(keys[1] ?? ""),
			clicks: num(r.clicks),
			impressions: num(r.impressions),
			ctr: num(r.ctr),
			position: num(r.position),
		}
	})
}

export type GscFetchArgs = {
	siteUrl: string
	accessToken?: string
	startDate: string
	endDate: string
	rowLimit?: number
	fetchImpl?: typeof fetch
}

export type GscFetchResult = { ok: true; rows: GscRow[] } | { ok: false; error: string }

export async function fetchGscQueries(args: GscFetchArgs): Promise<GscFetchResult> {
	const token = args.accessToken?.trim()
	if (!token) return { ok: false, error: `Search Console needs an access token with ${GSC_SCOPE}` }
	const doFetch = args.fetchImpl ?? fetch
	const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(args.siteUrl)}/searchAnalytics/query`
	try {
		const res = await doFetch(endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				startDate: args.startDate,
				endDate: args.endDate,
				dimensions: ["query", "page"],
				rowLimit: args.rowLimit ?? 1_000,
			}),
			signal: AbortSignal.timeout(20_000),
		})
		if (!res.ok) {
			const body = await res.text().catch(() => "")
			return { ok: false, error: `Search Console ${res.status}: ${body.slice(0, 200)}` }
		}
		const rows = parseGscRows(await res.json())
		return { ok: true, rows: rows.map((r) => ({ ...r, date: r.date || args.endDate })) }
	} catch (error) {
		return { ok: false, error: `Search Console request failed: ${error instanceof Error ? error.message : String(error)}` }
	}
}

/** One row per (date, query, page); re-pulling a window overwrites it. */
export type SqlValue = string | number | boolean | null
export type SqlAgent = {
	sql: (strings: TemplateStringsArray, ...values: SqlValue[]) => unknown
}

const schemaReady = new WeakSet<object>()

export function ensureGscTable(agent: SqlAgent): void {
	if (schemaReady.has(agent)) return
	agent.sql`
		CREATE TABLE IF NOT EXISTS seo_gsc_query (
			date TEXT NOT NULL,
			query TEXT NOT NULL,
			page TEXT NOT NULL,
			clicks INTEGER NOT NULL DEFAULT 0,
			impressions INTEGER NOT NULL DEFAULT 0,
			ctr REAL NOT NULL DEFAULT 0,
			position REAL NOT NULL DEFAULT 0,
			PRIMARY KEY (date, query, page)
		)
	`
	try {
		agent.sql`CREATE INDEX IF NOT EXISTS seo_gsc_query_page ON seo_gsc_query (page, date)`
	} catch {}
	schemaReady.add(agent)
}

export function upsertGscRows(agent: SqlAgent, rows: GscRow[]): number {
	ensureGscTable(agent)
	let written = 0
	for (const row of rows) {
		if (!row.query && !row.page) continue
		agent.sql`
			INSERT OR REPLACE INTO seo_gsc_query (date, query, page, clicks, impressions, ctr, position)
			VALUES (${row.date}, ${row.query}, ${row.page}, ${row.clicks}, ${row.impressions}, ${row.ctr}, ${row.position})
		`
		written++
	}
	return written
}

/**
 * Roll query rows up to one row per page, the shape the decision model eats.
 *
 * `position` is impression-weighted, because an unweighted mean lets a query
 * with three impressions at position 2 outvote a query with 4,000 impressions at
 * position 14 — which would report a page as ranking far better than it does.
 */
export function summariseByPage(rows: GscRow[]): PageRow[] {
	const byPage = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>()
	for (const row of rows) {
		if (!row.page) continue
		const acc = byPage.get(row.page) ?? { clicks: 0, impressions: 0, weightedPosition: 0 }
		acc.clicks += row.clicks
		acc.impressions += row.impressions
		acc.weightedPosition += row.position * Math.max(1, row.impressions)
		byPage.set(row.page, acc)
	}
	return [...byPage.entries()].map(([page, acc]) => ({
		slug: page.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "") || "/",
		clicks: acc.clicks,
		impressions: acc.impressions,
		position: acc.weightedPosition / Math.max(1, acc.impressions),
	}))
}

