/**
 * One bounded, redacted line that explains a failure. The worker bundle is
 * minified, so a bare `Error` reaches Workers Logs as a stack of `worker.js`
 * frames, and the AI SDK's retry wrappers hide the provider status code that
 * actually explains it. `summarizeError` walks that chain and keeps only the
 * fields worth having.
 *
 * Callers pass errors plus small scalar context only: never prompts, Slack
 * text, or generated output.
 */

const MAX_CHAIN_DEPTH = 3

const SECRET_KEY =
	/token|secret|password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie/i
const SECRET_VALUE =
	/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g

export function scrubSecrets(text: string): string {
	return text.replace(SECRET_VALUE, "[redacted]")
}

/** Collapse whitespace and cut to `max`, so a failure stays one log line. */
export function boundedText(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim()
	if (collapsed.length <= max) return collapsed
	return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined
}

function textOf(value: unknown, key: "name" | "message"): string | undefined {
	if (value instanceof Error) {
		const own = key === "name" ? value.name : value.message
		return own || undefined
	}
	const raw = asRecord(value)?.[key]
	return typeof raw === "string" && raw ? raw : undefined
}

function statusOf(record: Record<string, unknown>): string | undefined {
	const status = record.statusCode ?? record.status
	return typeof status === "number" ? `status=${status}` : undefined
}

/** The next link in an error chain: SDK wrappers expose `lastError` or `cause`. */
function nextInChain(record: Record<string, unknown>): unknown {
	if (record.lastError !== undefined) return record.lastError
	if (record.cause !== undefined) return record.cause
	const errors = record.errors
	return Array.isArray(errors) && errors.length
		? errors[errors.length - 1]
		: undefined
}

/**
 * `AI_RetryError: Failed after 3 attempts... | attempts=3 | status=429 | url=...`
 * for an SDK retry wrapper; `Error: boom` for a plain one.
 */
export function summarizeError(error: unknown, max = 500): string {
	if (error === undefined || error === null) return "unknown error"
	const parts: string[] = []
	const seen = new Set<unknown>()
	let current: unknown = error
	for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
		const record = asRecord(current)
		if (!record || seen.has(current)) break
		seen.add(current)
		const name = textOf(current, "name")
		const message = textOf(current, "message")
		if (name && message) parts.push(`${name}: ${message}`)
		else if (name ?? message) parts.push(`${name ?? message}`)
		if (typeof record.reason === "string") parts.push(`reason=${record.reason}`)
		const status = statusOf(record)
		if (status) parts.push(status)
		if (typeof record.url === "string") parts.push(`url=${record.url}`)
		if (typeof record.isRetryable === "boolean") {
			parts.push(`retryable=${record.isRetryable}`)
		}
		const errors = record.errors
		if (Array.isArray(errors) && errors.length) {
			parts.push(`attempts=${errors.length}`)
		}
		current = nextInChain(record)
	}
	const summary = parts.length
		? parts.join(" | ")
		: String(error as string | number | boolean)
	const bounded = boundedText(scrubSecrets(summary), max)
	return bounded || "unknown error"
}

function stringifyRedacted(value: unknown): string {
	try {
		const json = JSON.stringify(value, (key, val) => {
			if (SECRET_KEY.test(key)) return "[redacted]"
			return typeof val === "string" ? scrubSecrets(val) : val
		})
		return json ?? String(value)
	} catch {
		return "[unserializable]"
	}
}

/**
 * `captureException`'s `context.extra` as log text: keys and string values are
 * scrubbed, the result is bounded, and empty context stays silent so the line
 * carries only what the call site actually passed.
 */
export function summarizeContext(value: unknown, max = 400): string | undefined {
	if (value === undefined || value === null) return undefined
	const record = asRecord(value)
	if (record && !Object.keys(record).length) return undefined
	const text = typeof value === "string" ? value : stringifyRedacted(value)
	const bounded = boundedText(scrubSecrets(text), max)
	return bounded || undefined
}
