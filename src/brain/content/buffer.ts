/**
 * Buffer handoff for Content Studio.
 *
 * The operator connects Buffer as a custom remote MCP server with an API key
 * (https://mcp.buffer.com/mcp), so everything here goes through the standard
 * MCP client: find the connection, list channels, and create the post.
 *
 * Buffer's own tooling is the contract, not ours, so `buildCreatePostArgs`
 * reads the tool's input schema at push time: channel + text land under
 * whatever keys the tool declares, and the safest scheduling posture the
 * schema offers is chosen (a Buffer draft first, the queue second, and a bare
 * create as the last resort).
 */
import type { McpConnectionRow } from "../tools/mcp/store"
import type { ToolProviderHandle } from "../tools/mcp/provider"
import type { ContentChannel } from "./plan"

export type BufferChannel = ContentChannel

const CHANNEL_TYPE_KEYS = ["type", "channelType", "channel_type"]

/**
 * Buffer cannot publish automatically to a Facebook group or an Instagram
 * personal profile: those channels only accept a reminder that a human
 * publishes by hand. Buffer's own schema says as much ("Required for Facebook
 * Groups (type group) and Instagram personal profiles (type profile)"), so
 * the push asks for a notification there instead of failing validation or
 * posting into the void.
 */
export function bufferNeedsHumanPublish(channel: {
	service?: string | null
	type?: string | null
}): boolean {
	const service = (channel.service ?? "").toLowerCase()
	const type = (channel.type ?? "").toLowerCase()
	if (service.includes("facebook") && type === "group") return true
	if (service.includes("instagram") && type === "profile") return true
	return false
}

// The MCP runtime pulls in workerd-only modules ("agents", the SDK client);
// importing it lazily keeps this module (and its pure helpers) loadable
// outside the worker — provider.ts uses the same pattern for its client.
async function mcpDeps() {
	const [{ listActiveConnectionsForActor }, { connectToolProvider }] =
		await Promise.all([
			import("../tools/mcp/store"),
			import("../tools/mcp/provider"),
		])
	return { listActiveConnectionsForActor, connectToolProvider }
}

const CHANNEL_KEYS = [
	"channelId",
	"channel_id",
	"channelIds",
	"channel_ids",
	"channels",
]
const TEXT_KEYS = ["text", "content", "body", "message", "caption"]
const MODE_KEYS = [
	"mode",
	"schedulingType",
	"scheduling_type",
	"schedule",
	"status",
	"type",
]
// Buffer's create-post requires a scheduling type; it is a different field
// from the mode, and leaving it out fails the call for a missing field.
const SCHEDULING_TYPE_KEYS = ["schedulingType", "scheduling_type"]
const FIELD_KEYS = ["id", "channelId", "channel_id"]
const NAME_KEYS = ["name", "displayName", "display_name", "username", "handle"]
const SERVICE_KEYS = [
	"service",
	"platform",
	"network",
	"channelType",
	"channel_type",
]

export function isBufferConnection(connection: McpConnectionRow): boolean {
	const slug = (connection.serverSlug ?? "").toLowerCase()
	const url = (connection.serverUrl ?? "").toLowerCase()
	return slug === "buffer" || slug.startsWith("buffer") || url.includes("buffer.com")
}

/** The connection a push should use: the operator's own wins over shared. */
export async function findBufferConnection(
	env: Env,
	orgId: string,
	userId: string | undefined,
): Promise<McpConnectionRow | null> {
	const { listActiveConnectionsForActor } = await mcpDeps()
	const connections = await listActiveConnectionsForActor(
		env,
		orgId,
		userId,
		false,
	)
	const buffers = connections.filter(isBufferConnection)
	if (!buffers.length) return null
	return buffers.find((c) => c.userId !== null) ?? buffers[0] ?? null
}

function mcpCallbackUrl(env: Env): string {
	return `${env.PUBLIC_URL}/brain/mcp-connections/callback`
}

type JsonSchemaNode = {
	properties?: Record<string, unknown>
	inputSchema?: unknown
	enum?: unknown[]
	const?: unknown
	anyOf?: unknown[]
	oneOf?: unknown[]
}

/** Top-level properties of the tool's input schema, or null when unusable. */
function schemaProps(inputSchema: unknown): Record<string, unknown> | null {
	if (!inputSchema || typeof inputSchema !== "object") return null
	const node = inputSchema as JsonSchemaNode
	if (node.properties && typeof node.properties === "object")
		return node.properties
	if (node.inputSchema) return schemaProps(node.inputSchema)
	return null
}

function collectEnumValues(prop: unknown): string[] {
	if (!prop || typeof prop !== "object") return []
	const node = prop as JsonSchemaNode
	const out: string[] = []
	if (Array.isArray(node.enum))
		for (const value of node.enum)
			if (typeof value === "string") out.push(value)
	if (typeof node.const === "string") out.push(node.const)
	for (const alt of [...(node.anyOf ?? []), ...(node.oneOf ?? [])])
		out.push(...collectEnumValues(alt))
	return out
}

function pickKey(
	props: Record<string, unknown>,
	candidates: string[],
): string | null {
	for (const candidate of candidates)
		if (candidate in props) return candidate
	return null
}

function isDraftToggle(prop: unknown): boolean {
	if (!prop || typeof prop !== "object") return false
	const node = prop as { type?: unknown; default?: unknown }
	return node.type === "boolean"
}

export type BufferPushPlan = {
	args: Record<string, unknown>
	mode: "draft" | "queue" | "standard"
	notes?: string
}

/**
 * Map our intent (text, channel) onto Buffer's create-post tool. Pure and
 * schema-driven so it can't guess wrong key names silently.
 *
 * `schedulingType` is sent whenever the schema declares it, because Buffer's
 * create-post requires it: without it the call is rejected for a missing
 * field, which reads as "Buffer is broken" rather than "the request was
 * incomplete". The value follows the channel: a human-published channel gets
 * a notification, everything else gets the automatic queue.
 *
 * A source URL becomes a link preview card when the schema accepts one. That
 * is the difference between a post that shows what it links to and a bare
 * line of text, and it costs nothing to attach.
 */
export function buildCreatePostArgs(
	inputSchema: unknown,
	input: {
		text: string
		channelId: string | null
		/** Buffer channel type: page, profile, group. */
		channelType?: string | null
		/** Buffer channel service: linkedin, facebook, substack, ... */
		channelService?: string | null
		/** The source the post is grounded in, when there is one. */
		linkUrl?: string | null
		/** Title for the link preview card. */
		linkTitle?: string | null
	},
): BufferPushPlan {
	const props = schemaProps(inputSchema)
	if (!props) {
		const args: Record<string, unknown> = { text: input.text }
		if (input.channelId) args.channelId = input.channelId
		return {
			args,
			mode: "standard",
			notes: "create-post schema unavailable; sent the most common keys",
		}
	}
	const args: Record<string, unknown> = {}
	const channelKey = pickKey(props, CHANNEL_KEYS)
	if (channelKey && input.channelId) {
		args[channelKey] = channelKey.endsWith("s")
			? [input.channelId]
			: input.channelId
	}
	const textKey = pickKey(props, TEXT_KEYS) ?? "text"
	args[textKey] = input.text

	// Buffer's scheduling type: automatic where the platform publishes itself,
	// notification where a human has to (Facebook groups, Instagram personal).
	const schedulingKey = pickKey(props, SCHEDULING_TYPE_KEYS)
	const schedulingValues = schedulingKey
		? collectEnumValues(props[schedulingKey])
		: []
	if (schedulingKey && schedulingValues.length) {
		const needsHuman = bufferNeedsHumanPublish({
			service: input.channelService ?? null,
			type: input.channelType ?? null,
		})
		const notification = schedulingValues.find((v) =>
			/notification|reminder|manual/i.test(v),
		)
		const automatic = schedulingValues.find((v) =>
			/automatic|publish|auto/i.test(v),
		)
		const chosen =
			needsHuman && notification ? notification : (automatic ?? notification)
		if (chosen) args[schedulingKey] = chosen
	}

	// A link preview card, when the schema has a place for one.
	const metadataKey = "metadata"
	if (input.linkUrl && metadataKey in props) {
		const metadataProps = schemaProps(props[metadataKey])
		const attachmentKey = metadataProps ? "linkAttachment" : null
		if (attachmentKey && metadataProps && attachmentKey in metadataProps) {
			const attachment: Record<string, unknown> = { url: input.linkUrl }
			if (input.linkTitle?.trim()) attachment.title = input.linkTitle.trim()
			args[metadataKey] = { [attachmentKey]: attachment }
		}
	}

	// A boolean like saveToDraft is the clearest "don't publish yet" signal.
	const draftToggleKey = Object.keys(props).find(
		(name) =>
			/draft/i.test(name) &&
			isDraftToggle(props[name]) &&
			!(name in args),
	)
	if (draftToggleKey) {
		args[draftToggleKey] = true
		return { args, mode: "draft" }
	}
	const modeKey = pickKey(props, MODE_KEYS.filter((k) => !(k in args)))
	if (modeKey) {
		const values = collectEnumValues(props[modeKey])
		const draftValue = values.find((v) => /draft/i.test(v))
		if (draftValue) {
			args[modeKey] = draftValue
			return { args, mode: "draft" }
		}
		const queueValue = values.find((v) => /queue|next|automatic/i.test(v))
		if (queueValue) {
			args[modeKey] = queueValue
			return { args, mode: "queue" }
		}
	}
	return {
		args,
		mode: "standard",
		notes: "no draft/queue option found in the tool schema",
	}
}

/** First text-JSON payload inside an MCP tool result (structured wins). */
export function extractJsonPayload(result: unknown): unknown {
	if (!result || typeof result !== "object") return null
	const r = result as { structuredContent?: unknown; content?: unknown }
	if (r.structuredContent != null) return r.structuredContent
	if (Array.isArray(r.content)) {
		for (const part of r.content) {
			if (!part || typeof part !== "object") continue
			const p = part as { type?: unknown; text?: unknown }
			if (p.type !== "text" || typeof p.text !== "string") continue
			const parsed = parseJsonLoose(p.text)
			if (parsed !== undefined) return parsed
		}
	}
	return null
}

function parseJsonLoose(text: string): unknown {
	const trimmed = text.trim()
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
	if (start >= 0) {
		try {
			return JSON.parse(trimmed.slice(start))
		} catch {}
	}
	return undefined
}

/** Error text when the MCP result flags one, else null. */
export function toolError(result: unknown): string | null {
	if (!result || typeof result !== "object") return null
	const r = result as { isError?: unknown; content?: unknown }
	if (r.isError !== true) return null
	const texts: string[] = []
	if (Array.isArray(r.content))
		for (const part of r.content) {
			if (!part || typeof part !== "object") continue
			const p = part as { type?: unknown; text?: unknown }
			if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
		}
	return (
		texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300) ||
		"Buffer returned an error"
	)
}

function firstString(...values: unknown[]): string | null {
	for (const value of values)
		if (typeof value === "string" && value.trim()) return value.trim()
	return null
}

/** Tolerant id extraction from whatever create_post echoed back. */
export function findPostId(payload: unknown): string | null {
	const seen = new Set<unknown>()
	const walk = (
		value: unknown,
		depth: number,
		postish: boolean,
	): string | null => {
		if (!value || typeof value !== "object" || depth > 4 || seen.has(value))
			return null
		seen.add(value)
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = walk(item, depth + 1, postish)
				if (found) return found
			}
			return null
		}
		const obj = value as Record<string, unknown>
		for (const key of ["postId", "post_id", "postID"]) {
			const v = obj[key]
			if (typeof v === "string" && v.trim()) return v.trim()
		}
		const hasPostSibling =
			"text" in obj ||
			"channelId" in obj ||
			"channel_id" in obj ||
			"post" in obj
		if (
			typeof obj.id === "string" &&
			obj.id.trim() &&
			(postish || hasPostSibling)
		)
			return obj.id.trim()
		for (const key of ["post", "posts", "data", "result"]) {
			const found = walk(obj[key], depth + 1, true)
			if (found) return found
		}
		return null
	}
	return walk(payload, 0, false)
}

/** Normalize a list_channels payload into our channel shape. */
export function normalizeBufferChannels(payload: unknown): BufferChannel[] {
	const raw = findChannelArray(payload)
	if (!raw) return []
	const out: BufferChannel[] = []
	const seen = new Set<string>()
	for (const item of raw) {
		if (!item || typeof item !== "object") continue
		const c = item as Record<string, unknown>
		const nested =
			c.channel && typeof c.channel === "object"
				? (c.channel as Record<string, unknown>)
				: null
		const id = firstString(
			...FIELD_KEYS.map((k) => c[k]),
			...(nested ? FIELD_KEYS.map((k) => nested[k]) : []),
		)
		if (!id || seen.has(id)) continue
		const service =
			firstString(
				...SERVICE_KEYS.map((k) => c[k]),
				...(nested ? SERVICE_KEYS.map((k) => nested[k]) : []),
			) ?? "social"
		const name =
			firstString(
				...NAME_KEYS.map((k) => c[k]),
				...(nested ? NAME_KEYS.map((k) => nested[k]) : []),
			) ?? service.toLowerCase()
		const type =
			firstString(
				...CHANNEL_TYPE_KEYS.map((k) => c[k]),
				...(nested ? CHANNEL_TYPE_KEYS.map((k) => nested[k]) : []),
			) ?? null
		seen.add(id)
		out.push({
			id,
			service: service.toLowerCase(),
			name,
			...(type ? { type } : {}),
		})
	}
	return out
}

function findChannelArray(payload: unknown, depth = 0): unknown[] | null {
	if (depth > 4 || payload == null) return null
	if (Array.isArray(payload)) return payload
	if (typeof payload !== "object") return null
	const obj = payload as Record<string, unknown>
	if (Array.isArray(obj.channels)) return obj.channels
	if (Array.isArray(obj.accounts)) return obj.accounts
	for (const key of ["data", "result", "account"]) {
		const nested = findChannelArray(obj[key], depth + 1)
		if (nested) return nested
	}
	return null
}

function bufferChannelTool(
	tools: Awaited<ReturnType<ToolProviderHandle["listTools"]>>,
) {
	return (
		tools.find((t) => t.name === "list_channels") ??
		tools.find((t) => /list.?channels?/i.test(t.name)) ??
		tools.find((t) => /channels?/i.test(t.name)) ??
		null
	)
}

function createPostTool(
	tools: Awaited<ReturnType<ToolProviderHandle["listTools"]>>,
) {
	return (
		tools.find((t) => t.name === "create_post") ??
		tools.find((t) => /create.?post/i.test(t.name)) ??
		tools.find(
			(t) =>
				/post/i.test(t.name) &&
				/creat|add|publish|schedule/i.test(
					`${t.name} ${t.description ?? ""}`,
				),
		) ??
		null
	)
}

/** Resolve the Buffer organization id from get_account, for list_channels. */
function bufferOrganizationId(payload: unknown): string | null {
	const candidates: unknown[] = []
	if (Array.isArray(payload)) candidates.push(...payload)
	else if (payload && typeof payload === "object") {
		const obj = payload as Record<string, unknown>
		if (Array.isArray(obj.organizations)) candidates.push(...obj.organizations)
		if (obj.organization && typeof obj.organization === "object")
			candidates.push(obj.organization)
		if (obj.data && typeof obj.data === "object") {
			const d = obj.data as Record<string, unknown>
			if (Array.isArray(d.organizations)) candidates.push(...d.organizations)
			if (d.organization && typeof d.organization === "object")
				candidates.push(d.organization)
		}
	}
	for (const c of candidates) {
		if (!c || typeof c !== "object") continue
		const id = (c as Record<string, unknown>).id
		if (typeof id === "string" && id.trim()) return id.trim()
	}
	return null
}

/** The operator's Buffer channels, best effort — [] when unreachable. */
export async function listBufferChannels(
	env: Env,
	connection: McpConnectionRow,
): Promise<BufferChannel[]> {
	let handle: ToolProviderHandle | undefined
	try {
		const { connectToolProvider } = await mcpDeps()
		handle = await connectToolProvider(env, connection, mcpCallbackUrl(env))
		const tools = await handle.listTools()
		const channelTool = bufferChannelTool(tools)
		if (!channelTool) return []

		// Buffer's list_channels is scoped to an organization. Resolve it
		// from get_account rather than guessing — a bare {} returns nothing.
		let organizationId: string | null = null
		const accountTool =
			tools.find((t) => /get.?account/i.test(t.name)) ??
			tools.find((t) => /account/i.test(t.name))
		if (accountTool) {
			const acctRes = await handle.callTool(
				accountTool.name,
				{},
				{ retryOnTimeout: true },
			)
			if (!toolError(acctRes)) {
				organizationId = bufferOrganizationId(extractJsonPayload(acctRes))
			}
		}

		const args = organizationId ? { organizationId } : {}
		const res = await handle.callTool(channelTool.name, args, {
			retryOnTimeout: true,
		})
		if (toolError(res)) return []
		return normalizeBufferChannels(extractJsonPayload(res))
	} catch (err) {
		console.warn(
			`[company-brain] buffer channel list failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		return []
	} finally {
		await handle?.close().catch(() => {})
	}
}

export type BufferPushResult =
	| { ok: true; mode: BufferPushPlan["mode"]; postId: string | null }
	| { ok: false; error: string }

export async function pushDraftToBuffer(
	env: Env,
	connection: McpConnectionRow,
	input: {
		text: string
		channelId: string | null
		/** Buffer channel type: page, profile, group. */
		channelType?: string | null
		/** Buffer channel service: linkedin, facebook, substack, ... */
		channelService?: string | null
		/** The source the post is grounded in, when there is one. */
		linkUrl?: string | null
		/** Title for the link preview card. */
		linkTitle?: string | null
	},
): Promise<BufferPushResult> {
	if (!input.channelId)
		return {
			ok: false,
			error:
				"This draft isn't targeted at a Buffer channel yet. Re-connect Buffer, then hit Remix to re-target it.",
		}
	let handle: ToolProviderHandle | undefined
	try {
		const { connectToolProvider } = await mcpDeps()
		handle = await connectToolProvider(env, connection, mcpCallbackUrl(env))
		const tools = await handle.listTools()
		const tool = createPostTool(tools)
		if (!tool) {
			console.warn(
				`[company-brain] buffer push: no create-post tool found; tools=${tools.map((t) => t.name).join(",")}`,
			)
			return {
				ok: false,
				error:
					"Buffer's create-post tool wasn't found on the connection — try reconnecting Buffer.",
			}
		}
		const plan = buildCreatePostArgs(tool.inputSchema, input)
		const res = await handle.callTool(tool.name, plan.args, {
			retryOnTimeout: false,
		})
		const errText = toolError(res)
		if (errText) {
			console.warn(
				`[company-brain] buffer push rejected tool=${tool.name} mode=${plan.mode} args=${Object.keys(plan.args).join(",")} err=${errText}`,
			)
			return { ok: false, error: `Buffer rejected the post: ${errText}` }
		}
		const payload = extractJsonPayload(res)
		const postId = findPostId(payload)
		console.log(
			`[company-brain] buffer push ok tool=${tool.name} mode=${plan.mode} postId=${postId ?? "-"}`,
		)
		return { ok: true, mode: plan.mode, postId }
	} catch (err) {
		console.warn(
			`[company-brain] buffer push failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		return {
			ok: false,
			error: `Couldn't reach Buffer: ${err instanceof Error ? err.message : String(err)}`,
		}
	} finally {
		await handle?.close().catch(() => {})
	}
}
