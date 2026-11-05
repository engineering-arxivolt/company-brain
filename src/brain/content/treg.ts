/**
 * Keyword research through the treg connection (treg.to — Google Search
 * Console and keyword data over MCP).
 *
 * The campaign pack needs keywords that people actually search for, not ones
 * a model guesses. treg is connected as a remote MCP server, so the pack
 * builder asks it for the topic first and hands the real numbers to the model.
 * Every failure is non-fatal: the pack falls back to the model's own choices.
 */
import { findProviderTool, withContentMcp } from "./sources/mcp"

export type TregKeyword = {
	keyword: string
	volume?: number
	difficulty?: number
}

/** The topic keywords treg can enrich: short search phrases, not sentences. */
function topicPhrases(topic: string): string[] {
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

const KEYWORD_TOOL_PATTERN =
	/keyword|volume|serp|search.?console|research|suggest/i

/** Turn whatever treg returns into a plain keyword list. */
function parseKeywords(payload: unknown): TregKeyword[] {
	const out: TregKeyword[] = []
	const visit = (node: unknown, depth: number) => {
		if (out.length >= 12 || depth > 6) return
		if (Array.isArray(node)) {
			for (const item of node) visit(item, depth + 1)
			return
		}
		if (typeof node === "object" && node !== null) {
			const record = node as Record<string, unknown>
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
				const volume =
					typeof record.volume === "number"
						? record.volume
						: typeof record.search_volume === "number"
							? record.search_volume
							: undefined
				const difficulty =
					typeof record.difficulty === "number"
						? record.difficulty
						: typeof record.kd === "number"
							? record.kd
							: undefined
				out.push({
					keyword: keyword.slice(0, 80),
					...(volume !== undefined ? { volume } : {}),
					...(difficulty !== undefined ? { difficulty } : {}),
				})
				return
			}
			// No keyword field here — walk the values (MCP results wrap real
			// payloads in {content:[{type:"text",text:...}]} envelopes).
			for (const value of Object.values(record)) visit(value, depth + 1)
			return
		}
		// A string may be a bare keyword — or a nested JSON payload (MCP text
		// results), which is parsed and walked before giving up.
		if (typeof node === "string" && node.trim()) {
			const trimmed = node.trim()
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					visit(JSON.parse(trimmed), depth + 1)
					return
				} catch {}
			}
			if (
				trimmed.length <= 80 &&
				!trimmed.includes("\n") &&
				!/^(ok|true|false|null|\d+)$/.test(trimmed)
			) {
				out.push({ keyword: trimmed })
			}
		}
	}
	visit(payload, 0)
	return out
}

/**
 * Ask treg for keyword data on the topic. Discovers the keyword tool at
 * runtime (the connection may expose any of several shapes), tries a few
 * argument spellings, and returns null on any failure.
 */
export async function tregKeywords(
	env: Env,
	orgId: string,
	userId: string | undefined,
	topic: string,
	traceId: string,
): Promise<TregKeyword[]> {
	try {
		const { findContentConnection } = await import("./sources/mcp")
		const connection = await findContentConnection(
			env,
			orgId,
			userId,
			(connection) => connection.serverSlug === "treg",
		)
		if (!connection) {
			console.log(
				`[company-brain][${traceId}] treg: no connection, skipping keyword grounding`,
			)
			return []
		}
		return await withContentMcp(env, connection, async (handle) => {
			const tools = await handle.listTools()
			const tool =
				findProviderTool(tools, "", KEYWORD_TOOL_PATTERN) ??
				findProviderTool(tools, "", /search/i)
			if (!tool) {
				console.log(
					`[company-brain][${traceId}] treg tools=${tools.map((t) => t.name).join(",") || "(none)"} — no keyword tool matched`,
				)
				return []
			}
			for (const phrase of topicPhrases(topic)) {
				for (const argShape of [
					{ keyword: phrase },
					{ query: phrase },
					{ topic: phrase },
				]) {
					try {
						const result = await handle.callTool(tool.name, argShape, {
							retryOnTimeout: false,
						})
						// The MCP result nests content: text payloads and structured
						// JSON; parseKeywords unwraps both shapes.
						const keywords = parseKeywords(result)
						if (keywords.length) {
							console.log(
								`[company-brain][${traceId}] treg keywords=${keywords.length} via ${tool.name}`,
							)
							return keywords
						}
						console.log(
							`[company-brain][${traceId}] treg ${tool.name} answered without usable keywords: ${JSON.stringify(result).slice(0, 220)}`,
						)
					} catch (error) {
						console.log(
							`[company-brain][${traceId}] treg ${tool.name} arg-shape failed:`,
							error instanceof Error ? error.message : String(error),
						)
					}
				}
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