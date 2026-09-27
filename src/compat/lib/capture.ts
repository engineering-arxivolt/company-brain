import { summarizeContext, summarizeError } from "./error-summary"

/**
 * The hosted brain reported to Sentry. Self-hosted deployments log to the
 * Workers console instead, which `wrangler tail` and Workers Logs pick up.
 *
 * One line carries the error's name, cause chain, provider status, and the call
 * site's `extra` (redacted and bounded): enough to diagnose the failure from
 * the log alone, rather than the minified frames a raw `Error` serializes to.
 */
export function captureException(error: unknown, context?: unknown): void {
	const { tags, extra } = (context ?? {}) as {
		tags?: Record<string, string | undefined>
		extra?: unknown
	}
	const tagStr = tags ? Object.values(tags).filter(Boolean).join(" | ") : ""
	const extraStr = summarizeContext(extra)
	console.error(
		`[error] ${tagStr ? `${tagStr} - ` : ""}${summarizeError(error)}${
			extraStr ? ` | ${extraStr}` : ""
		}`,
	)
	if (error instanceof Error && error.stack) console.error(error.stack)
}

export function captureMessage(message: string, context?: unknown): void {
	const level = (context as { level?: string })?.level ?? "info"
	console.log(`[${level}] ${message}`)
}
