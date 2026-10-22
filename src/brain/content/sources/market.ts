/**
 * Market research through Context.dev's `web-answers` tool.
 *
 * This is the Trend Hunter's read side: one focused question, a fixed JSON
 * shape, and a small set of sourced signals. The weekly loop will run it with
 * no human prompt; the `content_market_scan` tool exposes the same call for
 * "what is the market talking about this week?"
 */
import type { McpConnectionRow } from "../../tools/mcp/store"
import {
	extractMcpJson,
	extractMcpText,
	findContentConnection,
	findProviderTool,
	mcpError,
	parseFirstJsonValue,
	withContentMcp,
} from "./mcp"

export type MarketSignal = {
	topic: string
	whyItMatters: string
	sourceUrl: string | null
	quote: string | null
	icpRelevance: string | null
}

export type MarketScan =
	| {
			ok: true
			signals: MarketSignal[]
			asOf: string
			/** Raw answer when the provider ignored the JSON shape. */
			raw: string | null
	  }
	| { ok: false; error: string }

const MARKET_JSON_FORMAT = {
	signals: [
		{
			topic: "",
			why_it_matters: "",
			source_url: "",
			quote: "",
			icp_relevance: "",
		},
	],
}

export function isContextConnection(connection: McpConnectionRow): boolean {
	const slug = (connection.serverSlug ?? "").toLowerCase()
	const url = (connection.serverUrl ?? "").toLowerCase()
	return (
		slug.includes("context") ||
		url.includes("context.dev") ||
		url.includes("contextdev")
	)
}

export function buildMarketTask(args: {
	positioning?: string | null
	icp?: string | null
	focus?: string | null
	now?: Date
}): string {
	const now = args.now ?? new Date()
	const date = now.toISOString().slice(0, 10)
	const positioning = args.positioning?.trim().slice(0, 700)
	const icp = args.icp?.trim().slice(0, 500)
	const focus = args.focus?.trim().slice(0, 500)
	return [
		`You are the market scout for a founder's content system. Today is ${date}.`,
		positioning ? `What the founder's company does: ${positioning}` : "",
		icp ? `The audience the content is for: ${icp}` : "",
		focus
			? `Focus this scan on: ${focus}`
			: "Focus on the audience's live conversations about the problem the company solves.",
		"Find 3 to 5 specific, recent signals from the last 14 days: what the audience is talking about, competitor moves, new data, or a shift in the conversation. Prefer primary sources (company posts, reports, launches, news) over listicles and SEO pages.",
		"Each signal needs a real source URL and, when possible, an exact quote. Do not invent a source or a quote. If you cannot find enough sourced signals, return fewer.",
		"Return JSON only with this shape: {\"signals\":[{\"topic\":\"\",\"why_it_matters\":\"\",\"source_url\":\"\",\"quote\":\"\",\"icp_relevance\":\"\"}]}.",
	]
		.filter(Boolean)
		.join("\n\n")
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim()
	}
	return null
}

function findSignalsArray(payload: unknown, depth = 0): unknown[] | null {
	if (payload == null || depth > 5) return null
	if (Array.isArray(payload)) {
		const signalish = payload.some(
			(item) =>
				item &&
				typeof item === "object" &&
				("topic" in item ||
					"title" in item ||
					"signal" in item ||
					"why_it_matters" in item),
		)
		return signalish ? payload : null
	}
	if (typeof payload !== "object") return null
	const record = payload as Record<string, unknown>
	if (Array.isArray(record.signals)) return record.signals
	if (Array.isArray(record.results)) return record.results
	if (Array.isArray(record.items)) return record.items
	for (const key of [
		"json_content",
		"jsonContent",
		"answer",
		"data",
		"result",
		"output",
	]) {
		const nested = findSignalsArray(record[key], depth + 1)
		if (nested) return nested
	}
	return null
}

function clean(value: unknown, max = 600): string {
	return typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, max)
		: ""
}

export function normaliseMarketSignals(payload: unknown): MarketSignal[] {
	let parsed = payload
	if (typeof parsed === "string") {
		parsed = parseFirstJsonValue(parsed) ?? parsed
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		typeof (parsed as Record<string, unknown>).answer === "string"
	) {
		const answer = (parsed as Record<string, unknown>).answer
		if (typeof answer === "string") {
			const nested = parseFirstJsonValue(answer)
			if (nested != null) parsed = nested
		}
	}
	const array = findSignalsArray(parsed)
	if (!array) return []
	const out: MarketSignal[] = []
	const seen = new Set<string>()
	for (const item of array) {
		if (!item || typeof item !== "object") continue
		const record = item as Record<string, unknown>
		const topic = clean(
			record.topic ?? record.title ?? record.signal ?? record.name,
			300,
		)
		if (!topic) continue
		const sourceUrl = firstString(
			record.source_url,
			record.sourceUrl,
			record.url,
			record.link,
			record.source,
		)
		const key = `${topic.toLowerCase()}|${sourceUrl?.toLowerCase() ?? ""}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push({
			topic,
			whyItMatters: clean(
				record.why_it_matters ?? record.whyItMatters ?? record.why,
				600,
			),
			sourceUrl: sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : null,
			quote: clean(record.quote ?? record.excerpt, 500) || null,
			icpRelevance:
				clean(
					record.icp_relevance ??
						record.icpRelevance ??
						record.relevance ??
						record.audience,
					400,
				) || null,
		})
		if (out.length >= 5) break
	}
	return out
}

export function formatMarketSignals(signals: readonly MarketSignal[]): string {
	if (!signals.length) return "No sourced signals came back."
	return signals
		.map((signal, index) => {
			const source = signal.sourceUrl ? ` — ${signal.sourceUrl}` : ""
			const why = signal.whyItMatters ? `\n   Why it matters: ${signal.whyItMatters}` : ""
			const relevance = signal.icpRelevance
				? `\n   For the audience: ${signal.icpRelevance}`
				: ""
			return `${index + 1}. ${signal.topic}${source}${why}${relevance}`
		})
		.join("\n")
}

/** Run one Context.dev scan. Never throws. */
export async function scanMarket(
	env: Env,
	orgId: string,
	userId: string | undefined,
	args: {
		positioning?: string | null
		icp?: string | null
		focus?: string | null
	},
): Promise<MarketScan> {
	try {
		const connection = await findContentConnection(
			env,
			orgId,
			userId,
			isContextConnection,
		)
		if (!connection) {
			return {
				ok: false,
				error:
					"Context.dev isn't connected to this workspace. Connect it under Settings → Connectors, then ask again.",
			}
		}
		return await withContentMcp(env, connection, async (handle) => {
			const tools = await handle.listTools()
			const tool = findProviderTool(tools, "web-answers", /web.?answers?/i)
			if (!tool) {
				return {
					ok: false,
					error:
						"Context.dev's web-answers tool wasn't found on the connection — try reconnecting it.",
				}
			}
			const task = buildMarketTask(args)
			const result = await handle.callTool(
				tool.name,
				{
					task,
					json_format: MARKET_JSON_FORMAT,
					mode: "fast",
					timeoutOpts: { milliseconds: 90000, behavior: "return-partial" },
				},
				{ retryOnTimeout: true },
			)
			const error = mcpError(result)
			if (error) return { ok: false, error }
			const payload = extractMcpJson(result)
			const signals = normaliseMarketSignals(payload)
			const raw = signals.length
				? null
				: extractMcpText(result).slice(0, 4000) || null
			return {
				ok: true,
				signals,
				asOf: new Date().toISOString(),
				raw,
			}
		})
	} catch (err) {
		return {
			ok: false,
			error: `Couldn't reach Context.dev: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}
