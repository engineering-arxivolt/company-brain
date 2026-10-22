/**
 * Typed access to the connected apps the content system reads.
 *
 * The model still has the full MCP tool catalog for open-ended work. These
 * helpers are for the deterministic parts of the product: read Buffer metrics,
 * ask Context.dev for market signals, and later query PostHog. They connect,
 * call one named tool, and close the session, so a background round does not
 * leave a provider handle open.
 */
import type { ToolProviderHandle, ProviderTool } from "../../tools/mcp/provider"
import type { McpConnectionRow } from "../../tools/mcp/store"

async function mcpDeps() {
	const [{ listActiveConnectionsForActor }, { connectToolProvider }] =
		await Promise.all([
			import("../../tools/mcp/store"),
			import("../../tools/mcp/provider"),
		])
	return { listActiveConnectionsForActor, connectToolProvider }
}

export function mcpCallbackUrl(env: Env): string {
	return `${env.PUBLIC_URL}/brain/mcp-connections/callback`
}

/**
 * Find the best connection for a content job.
 *
 * A personal connection wins over an org-shared one: the operator's own Buffer
 * account is the one their drafts belong to. `match` decides which provider.
 */
export async function findContentConnection(
	env: Env,
	orgId: string,
	userId: string | undefined,
	match: (connection: McpConnectionRow) => boolean,
): Promise<McpConnectionRow | null> {
	const { listActiveConnectionsForActor } = await mcpDeps()
	const connections = await listActiveConnectionsForActor(
		env,
		orgId,
		userId,
		false,
	)
	const matches = connections.filter(match)
	if (!matches.length) return null
	return matches.find((c) => c.userId !== null) ?? matches[0] ?? null
}

export async function withContentMcp<T>(
	env: Env,
	connection: McpConnectionRow,
	fn: (handle: ToolProviderHandle) => Promise<T>,
): Promise<T> {
	const { connectToolProvider } = await mcpDeps()
	const handle = await connectToolProvider(
		env,
		connection,
		mcpCallbackUrl(env),
	)
	try {
		return await fn(handle)
	} finally {
		await handle.close().catch(() => {})
	}
}

export function findProviderTool(
	tools: readonly ProviderTool[],
	exact: string,
	pattern: RegExp,
): ProviderTool | null {
	return (
		tools.find((tool) => tool.name === exact) ??
		tools.find((tool) => pattern.test(tool.name)) ??
		null
	)
}

/** First complete JSON value in a text blob, ignoring trailing metadata. */
export function parseFirstJsonValue(text: string): unknown {
	const trimmed = text.trim()
	if (!trimmed) return null
	try {
		return JSON.parse(trimmed)
	} catch {}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
	if (fenced?.[1]) {
		try {
			return JSON.parse(fenced[1])
		} catch {}
	}
	const start = trimmed.search(/[[{]/)
	if (start < 0) return null
	const stack: string[] = []
	let inString = false
	let escaped = false
	for (let i = start; i < trimmed.length; i++) {
		const char = trimmed[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
			continue
		}
		if (char === "{" || char === "[") {
			stack.push(char)
			continue
		}
		if (char === "}" || char === "]") {
			const open = stack.pop()
			if (
				(open === "{" && char !== "}") ||
				(open === "[" && char !== "]")
			) {
				return null
			}
			if (!stack.length) {
				try {
					return JSON.parse(trimmed.slice(start, i + 1))
				} catch {
					return null
				}
			}
		}
	}
	return null
}

/** First JSON payload inside an MCP tool result (structuredContent wins). */
export function extractMcpJson(result: unknown): unknown {
	if (!result || typeof result !== "object") return null
	const r = result as { structuredContent?: unknown; content?: unknown }
	if (r.structuredContent != null) return r.structuredContent
	if (Array.isArray(r.content)) {
		const texts: string[] = []
		for (const part of r.content) {
			if (!part || typeof part !== "object") continue
			const p = part as { type?: unknown; text?: unknown }
			if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
		}
		const joined = texts.join("\n").trim()
		if (joined) {
			const parsed = parseFirstJsonValue(joined)
			if (parsed !== undefined && parsed !== null) return parsed
			return joined
		}
	}
	return null
}

/** Plain text from an MCP result, for providers that answer in prose. */
export function extractMcpText(result: unknown): string {
	if (!result || typeof result !== "object") return ""
	const r = result as { content?: unknown }
	if (!Array.isArray(r.content)) return ""
	return r.content
		.map((part) => {
			if (!part || typeof part !== "object") return ""
			const p = part as { type?: unknown; text?: unknown }
			return p.type === "text" && typeof p.text === "string" ? p.text : ""
		})
		.filter(Boolean)
		.join("\n")
		.trim()
}

/** Error text when the MCP result flags one, else null. */
export function mcpError(result: unknown): string | null {
	if (!result || typeof result !== "object") return null
	const r = result as { isError?: unknown; content?: unknown }
	if (r.isError !== true) return null
	const text = extractMcpText(result).replace(/\s+/g, " ").trim().slice(0, 400)
	return text || "The app returned an error"
}
