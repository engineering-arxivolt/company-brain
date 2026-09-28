import type { BrainSource } from "../sources"
import type { TurnCardSource } from "./types"

// Tool results are usually structured: brain tools return { output, success },
// MCP tools return { content: [{ text }] }. Pull the human-readable text out.
function toDisplayText(output: unknown): string | undefined {
	if (typeof output === "string") return output
	if (!output || typeof output !== "object") return undefined
	const o = output as Record<string, unknown>
	if (typeof o.output === "string") return o.output
	if (typeof o.value === "string") return o.value
	if (typeof o.text === "string") return o.text
	if (Array.isArray(o.content)) {
		const parts = o.content
			.map((c) =>
				c &&
				typeof c === "object" &&
				typeof (c as Record<string, unknown>).text === "string"
					? ((c as Record<string, unknown>).text as string)
					: "",
			)
			.filter(Boolean)
		if (parts.length) return parts.join("\n")
	}
	return undefined
}

/** First meaningful line of a tool's output, cleaned of list/markdown noise. */
export function summarizeToolOutput(output: unknown): string | undefined {
	const text = toDisplayText(output)
	if (!text) return undefined
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0)
	if (!firstLine) return undefined
	const cleaned = firstLine
		.replace(/^[-*\d.)\s]+/, "")
		.replace(/[*_`>#]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
	return cleaned ? cleaned.slice(0, 140) : undefined
}

const SLACK_LINK_RE = /<(https?:\/\/[^|>]+)\|([^>]+)>/gi
const URL_RE = /https?:\/\/[^\s<>|)\]]+/gi
const MAX_SOURCES = 3

/**
 * Sources the tool supplied as data. Present means the tool knew exactly what it
 * read, so trust it; absent means fall back to scraping, which is a guess.
 */
function suppliedSources(output: unknown): TurnCardSource[] | undefined {
	if (!output || typeof output !== "object") return undefined
	const sources = (output as Record<string, unknown>).sources
	if (!Array.isArray(sources)) return undefined
	const seen = new Set<string>()
	const out: TurnCardSource[] = []
	for (const entry of sources) {
		if (!entry || typeof entry !== "object") continue
		const record = entry as Partial<BrainSource>
		const url = typeof record.source === "string" ? record.source.trim() : ""
		if (!url || seen.has(url)) continue
		seen.add(url)
		if (out.length >= MAX_SOURCES) break
		const title =
			typeof record.title === "string" && record.title.trim()
				? record.title.trim()
				: sourceLabel(url)
		out.push({ url, text: title.slice(0, 60) })
	}
	return out
}

/** Up to 3 sources for the card's row, from tool data when available. */
export function extractCardSources(output: unknown): TurnCardSource[] {
	const supplied = suppliedSources(output)
	if (supplied) return supplied
	const text = toDisplayText(output)
	if (!text) return []
	const seen = new Set<string>()
	const sources: TurnCardSource[] = []
	const push = (rawUrl: string, label: string) => {
		if (sources.length >= MAX_SOURCES) return
		const url = rawUrl.replace(/[.,)]+$/, "")
		if (seen.has(url)) return
		seen.add(url)
		sources.push({ url, text: label.slice(0, 60) })
	}
	for (const m of text.matchAll(SLACK_LINK_RE)) {
		if (m[1]) push(m[1], sourceLabel(m[1], m[2]))
	}
	for (const m of text.matchAll(URL_RE)) {
		if (m[0]) push(m[0], sourceLabel(m[0]))
	}
	return sources
}

// Public cards leak personal-connection data, so only these tools show raw output.
const PUBLIC_CARD_PAYLOAD_TOOLS = new Set(["search_web"])

/**
 * Raw output stays restricted, but sources do not: a citation is provenance, and
 * hiding it would leave the card asserting an answer with no visible evidence.
 */
export function cardOutputPayload(
	toolName: string,
	output: unknown,
): { output?: string; sources?: TurnCardSource[] } {
	const sources = extractCardSources(output)
	return {
		...(PUBLIC_CARD_PAYLOAD_TOOLS.has(toolName)
			? { output: summarizeToolOutput(output) }
			: {}),
		...(sources.length ? { sources } : {}),
	}
}

function sourceLabel(url: string, fallback?: string): string {
	if (fallback && !/^https?:/i.test(fallback)) return fallback.trim()
	try {
		const host = new URL(url).hostname.replace(/^www\./, "")
		return host.includes("slack.com") ? "Slack message" : host
	} catch {
		return "Source"
	}
}
