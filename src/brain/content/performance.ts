/**
 * Buffer performance, read back through Buffer's own MCP tools.
 *
 * The review loop already knows which draft became which Buffer post. This
 * adapter closes the loop: pull sent posts with `includeMetrics`, normalise the
 * experimental metrics payload, join it to the draft by `buffer_post_id`, and
 * keep the latest snapshot in the org's SQLite. The weekly scoreboard can then
 * answer "what did the posts we actually published do?" without asking a model
 * to read a Buffer UI.
 */
import type { CompanyBrainAgent } from "../turn/agent"
import { findBufferConnection } from "./buffer"
import { getContentDraftByBufferPostId, type ContentDraft } from "./store"
import type { ContentFunnel, ContentVehicle } from "./taxonomy"
import {
	extractMcpJson,
	findProviderTool,
	mcpError,
	parseFirstJsonValue,
	withContentMcp,
} from "./sources/mcp"

export type BufferPostMetrics = {
	impressions: number
	reactions: number
	comments: number
	shares: number
	clicks: number
	engagementRate: number
	/** Any additional metric Buffer returns, lower-cased by type. */
	[metric: string]: number
}

export type BufferPostPerformance = {
	id: string
	text: string
	status: string
	dueAt: string | null
	sentAt: string | null
	channelId: string | null
	channelService: string | null
	metrics: BufferPostMetrics
	metricsUpdatedAt: string | null
}

export type BufferPerformanceTotals = {
	posts: number
	impressions: number
	reactions: number
	comments: number
	shares: number
	clicks: number
	engagementRate: number
}

type MetricRecord = Record<string, unknown>

function asNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value !== "string") return 0
	const cleaned = value.replace(/[,%\s]/g, "")
	const parsed = Number.parseFloat(cleaned)
	return Number.isFinite(parsed) ? parsed : 0
}

function metricKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

const METRIC_ALIASES: Record<string, keyof BufferPostMetrics> = {
	impressions: "impressions",
	impression: "impressions",
	views: "impressions",
	reach: "impressions",
	reactions: "reactions",
	reaction: "reactions",
	likes: "reactions",
	comments: "comments",
	comment: "comments",
	replies: "comments",
	shares: "shares",
	share: "shares",
	reposts: "shares",
	repost: "shares",
	clicks: "clicks",
	click: "clicks",
	linkclicks: "clicks",
	engagementrate: "engagementRate",
	engrate: "engagementRate",
	engagement: "engagementRate",
}

function emptyMetrics(): BufferPostMetrics {
	return {
		impressions: 0,
		reactions: 0,
		comments: 0,
		shares: 0,
		clicks: 0,
		engagementRate: 0,
	}
}

/** Normalise Buffer's `[{type, value, unit}]` or a plain object of metrics. */
export function normaliseBufferMetrics(raw: unknown): BufferPostMetrics {
	const metrics = emptyMetrics()
	if (!raw) return metrics
	const entries: Array<[string, unknown]> = []
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (!item || typeof item !== "object") continue
			const record = item as MetricRecord
			const type =
				typeof record.type === "string"
					? record.type
					: typeof record.name === "string"
						? record.name
						: ""
			if (type) entries.push([type, record.value])
		}
	} else if (typeof raw === "object") {
		for (const [key, value] of Object.entries(raw as MetricRecord))
			entries.push([key, value])
	}
	for (const [rawKey, value] of entries) {
		const key = metricKey(rawKey)
		const alias = METRIC_ALIASES[key]
		const numeric = asNumber(value)
		if (alias) {
			metrics[alias] = numeric
			continue
		}
		if (key) metrics[key] = numeric
	}
	return metrics
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim()
	}
	return null
}

function findPostsArray(payload: unknown, depth = 0): unknown[] | null {
	if (payload == null || depth > 5) return null
	if (Array.isArray(payload)) {
		const postish = payload.some(
			(item) =>
				item &&
				typeof item === "object" &&
				("id" in item || "postId" in item || "post_id" in item),
		)
		return postish ? payload : null
	}
	if (typeof payload !== "object") return null
	const record = payload as Record<string, unknown>
	if (Array.isArray(record.edges)) {
		const nodes = record.edges
			.map((edge) =>
				edge && typeof edge === "object"
					? (edge as Record<string, unknown>).node
					: null,
			)
			.filter(Boolean)
		if (nodes.length || record.edges.length === 0) return nodes
	}
	if (Array.isArray(record.posts)) return record.posts
	for (const key of ["data", "result", "payload"]) {
		const nested = findPostsArray(record[key], depth + 1)
		if (nested) return nested
	}
	return null
}

function normaliseBufferPost(raw: unknown): BufferPostPerformance | null {
	if (!raw || typeof raw !== "object") return null
	const record = raw as Record<string, unknown>
	const channel =
		record.channel && typeof record.channel === "object"
			? (record.channel as Record<string, unknown>)
			: null
	const id = firstString(record.id, record.postId, record.post_id)
	if (!id) return null
	return {
		id,
		text: firstString(record.text, record.body) ?? "",
		status: firstString(record.status) ?? "sent",
		dueAt: firstString(record.dueAt, record.due_at),
		sentAt: firstString(record.sentAt, record.sent_at),
		channelId: firstString(
			record.channelId,
			record.channel_id,
			channel?.id,
		),
		channelService: firstString(
			record.channelService,
			record.channel_service,
			channel?.service,
		),
		metrics: normaliseBufferMetrics(record.metrics),
		metricsUpdatedAt: firstString(
			record.metricsUpdatedAt,
			record.metrics_updated_at,
		),
	}
}

export function normaliseBufferPosts(payload: unknown): BufferPostPerformance[] {
	const array = findPostsArray(payload)
	if (!array) return []
	const out: BufferPostPerformance[] = []
	const seen = new Set<string>()
	for (const item of array) {
		const post = normaliseBufferPost(item)
		if (!post || seen.has(post.id)) continue
		seen.add(post.id)
		out.push(post)
	}
	return out
}

/** Pull the Buffer organization id out of `get_account`. */
export function normaliseBufferOrganizationId(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null
	const record = payload as Record<string, unknown>
	const orgs = Array.isArray(record.organizations) ? record.organizations : []
	for (const org of orgs) {
		if (!org || typeof org !== "object") continue
		const id = firstString((org as Record<string, unknown>).id)
		if (id) return id
	}
	return firstString(
		record.organizationId,
		record.organization_id,
		record.orgId,
	)
}

export function buildListPostsArgs(
	organizationId: string,
	options: { days?: number; now?: Date } = {},
): Record<string, unknown> {
	const days = Math.max(1, Math.min(options.days ?? 7, 30))
	const now = options.now ?? new Date()
	const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
	return {
		organizationId,
		status: ["sent"],
		includeMetrics: true,
		first: 100,
		sort: [{ field: "dueAt", direction: "desc" }],
		dueAt: { start: start.toISOString(), end: now.toISOString() },
	}
}

export type BufferPerformanceResult =
	| {
			ok: true
			posts: BufferPostPerformance[]
			totals: BufferPerformanceTotals
			organizationId: string
	  }
	| { ok: false; error: string }

export function summariseBufferPerformance(
	posts: readonly BufferPostPerformance[],
): BufferPerformanceTotals {
	const totals: BufferPerformanceTotals = {
		posts: posts.length,
		impressions: 0,
		reactions: 0,
		comments: 0,
		shares: 0,
		clicks: 0,
		engagementRate: 0,
	}
	for (const post of posts) {
		totals.impressions += post.metrics.impressions
		totals.reactions += post.metrics.reactions
		totals.comments += post.metrics.comments
		totals.shares += post.metrics.shares
		totals.clicks += post.metrics.clicks
		totals.engagementRate += post.metrics.engagementRate
	}
	if (posts.length)
		totals.engagementRate =
			Math.round((totals.engagementRate / posts.length) * 100) / 100
	return totals
}

/** Read sent posts + metrics from Buffer. Never throws. */
export async function fetchBufferPerformance(
	env: Env,
	orgId: string,
	userId: string | undefined,
	options: { days?: number } = {},
): Promise<BufferPerformanceResult> {
	try {
		const connection = await findBufferConnection(env, orgId, userId)
		if (!connection) {
			return {
				ok: false,
				error:
					"Buffer isn't connected to this workspace. Connect it under Settings → Connectors.",
			}
		}
		return await withContentMcp(env, connection, async (handle) => {
			const tools = await handle.listTools()
			const accountTool = findProviderTool(tools, "get_account", /account/i)
			if (!accountTool) {
				return {
					ok: false,
					error:
						"Buffer's account tool wasn't found on the connection — try reconnecting Buffer.",
				}
			}
			const accountResult = await handle.callTool(
				accountTool.name,
				{},
				{ retryOnTimeout: true },
			)
			const accountError = mcpError(accountResult)
			if (accountError) return { ok: false, error: accountError }
			const accountPayload =
				extractMcpJson(accountResult) ??
				parseFirstJsonValue(
					typeof accountResult === "object" && accountResult
						? JSON.stringify(accountResult)
						: "",
				)
			const organizationId = normaliseBufferOrganizationId(accountPayload)
			if (!organizationId) {
				return {
					ok: false,
					error:
						"I couldn't find the Buffer organization for this account. Reconnect Buffer and try again.",
				}
			}
			const listTool = findProviderTool(tools, "list_posts", /list.?posts?/i)
			if (!listTool) {
				return {
					ok: false,
					error:
						"Buffer's list-posts tool wasn't found on the connection — try reconnecting Buffer.",
				}
			}
			const args = buildListPostsArgs(organizationId, { days: options.days })
			const listResult = await handle.callTool(listTool.name, args, {
				retryOnTimeout: true,
			})
			const listError = mcpError(listResult)
			if (listError) return { ok: false, error: listError }
			const posts = normaliseBufferPosts(extractMcpJson(listResult))
			return {
				ok: true,
				posts,
				totals: summariseBufferPerformance(posts),
				organizationId,
			}
		})
	} catch (err) {
		return {
			ok: false,
			error: `Couldn't reach Buffer: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

export function ensureContentMetricTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_content_metric (
			buffer_post_id TEXT PRIMARY KEY,
			draft_id TEXT,
			channel_id TEXT,
			channel_service TEXT,
			text_snippet TEXT,
			metrics_json TEXT NOT NULL,
			metrics_updated_at TEXT,
			captured_at INTEGER NOT NULL
		)
	`
	try {
		agent.sql`CREATE INDEX IF NOT EXISTS brain_content_metric_draft ON brain_content_metric (draft_id)`
	} catch {}
}

export type ContentMetricSnapshot = {
	bufferPostId: string
	draftId: string | null
	channelId: string | null
	channelService: string | null
	textSnippet: string
	metrics: BufferPostMetrics
	metricsUpdatedAt: string | null
	capturedAt: number
}

function rowToMetric(row: Record<string, unknown>): ContentMetricSnapshot {
	return {
		bufferPostId: String(row.buffer_post_id ?? ""),
		draftId: typeof row.draft_id === "string" ? row.draft_id : null,
		channelId: typeof row.channel_id === "string" ? row.channel_id : null,
		channelService:
			typeof row.channel_service === "string" ? row.channel_service : null,
		textSnippet: typeof row.text_snippet === "string" ? row.text_snippet : "",
		metrics: normaliseBufferMetrics(
			typeof row.metrics_json === "string"
				? (parseFirstJsonValue(row.metrics_json) ?? {})
				: {},
		),
		metricsUpdatedAt:
			typeof row.metrics_updated_at === "string"
				? row.metrics_updated_at
				: null,
		capturedAt: typeof row.captured_at === "number" ? row.captured_at : 0,
	}
}

/**
 * Persist the latest snapshot per Buffer post. One row per post is deliberate:
 * Buffer refreshes metrics daily, and the scoreboard wants the current number,
 * not a pile of near-identical copies.
 */
export function recordBufferMetrics(
	agent: CompanyBrainAgent,
	posts: readonly BufferPostPerformance[],
): number {
	ensureContentMetricTable(agent)
	const capturedAt = Date.now()
	let written = 0
	for (const post of posts) {
		const draft = getContentDraftByBufferPostId(agent, post.id)
		agent.sql`
			INSERT INTO brain_content_metric (
				buffer_post_id, draft_id, channel_id, channel_service,
				text_snippet, metrics_json, metrics_updated_at, captured_at
			) VALUES (
				${post.id}, ${draft?.id ?? null}, ${post.channelId},
				${post.channelService}, ${post.text.slice(0, 280)},
				${JSON.stringify(post.metrics)}, ${post.metricsUpdatedAt},
				${capturedAt}
			)
			ON CONFLICT(buffer_post_id) DO UPDATE SET
				draft_id = excluded.draft_id,
				channel_id = excluded.channel_id,
				channel_service = excluded.channel_service,
				text_snippet = excluded.text_snippet,
				metrics_json = excluded.metrics_json,
				metrics_updated_at = excluded.metrics_updated_at,
				captured_at = excluded.captured_at
		`
		written++
	}
	return written
}

export function listContentMetrics(
	agent: CompanyBrainAgent,
	limit = 50,
): ContentMetricSnapshot[] {
	ensureContentMetricTable(agent)
	const rows = agent.sql<Record<string, unknown>>`
		SELECT * FROM brain_content_metric
		ORDER BY captured_at DESC
		LIMIT ${Math.max(1, Math.min(limit, 200))}
	`
	return rows.map(rowToMetric)
}

export type PerformancePostWithDraft = BufferPostPerformance & {
	draft: Pick<ContentDraft, "id" | "kind" | "funnel" | "vehicle"> | null
}

export function attachDrafts(
	agent: CompanyBrainAgent,
	posts: readonly BufferPostPerformance[],
): PerformancePostWithDraft[] {
	return posts.map((post) => {
		const draft = getContentDraftByBufferPostId(agent, post.id)
		return {
			...post,
			draft: draft
				? {
						id: draft.id,
						kind: draft.kind,
						funnel: draft.funnel,
						vehicle: draft.vehicle,
					}
				: null,
		}
	})
}

export function funnelOf(
	post: PerformancePostWithDraft,
): ContentFunnel | null {
	return post.draft?.funnel ?? null
}

export function vehicleOf(
	post: PerformancePostWithDraft,
): ContentVehicle | null {
	return post.draft?.vehicle ?? null
}
