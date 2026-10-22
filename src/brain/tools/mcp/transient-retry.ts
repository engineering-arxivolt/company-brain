/**
 * Retrying a connected-app call that failed for a reason that was not the
 * call's fault.
 *
 * Connected apps fail in two very different ways. One is the call being
 * wrong — a bad argument, a missing scope, a 404 — which needs a different
 * request. The other is the upstream blinking: a gateway timeout, a 5xx, a
 * dropped connection. The second kind is what makes a run feel random: the
 * call is recorded as failed, the duplicate-call guard then refuses the
 * obvious retry, and the whole approach dies on a blip a second attempt
 * would have cleared.
 *
 * Only read and metadata calls are retried. A write that failed halfway may
 * already have taken effect, and repeating it could duplicate a side effect
 * nobody asked for twice.
 */

function errorText(error: unknown): string {
	if (error && typeof error === "object") {
		const e = error as Record<string, unknown>
		if (e.data && typeof e.data === "object") {
			const data = e.data as Record<string, unknown>
			if (typeof data.message === "string") return data.message
			if (typeof data.error === "string") return data.error
			if (typeof data.detail === "string") return data.detail
		}
		if (typeof e.message === "string") return e.message
	}
	return error instanceof Error ? error.message : String(error)
}

/**
 * True when a failure looks like the upstream blinked rather than the call
 * being wrong: a gateway timeout, a 5xx, a dropped connection.
 */
export function isTransientUpstreamError(error: unknown): boolean {
	const text = errorText(error).toLowerCase()
	// A rejected or throttled call needs a different fix, not another try.
	if (/\b(400|401|403|404|409|422|429)\b/.test(text)) return false
	return (
		/\b(500|502|503|504)\b/.test(text) ||
		/(timed? ?out|timeout|etimedout|econnreset|econnrefused|socket hang up|network|overloaded|temporarily unavailable|upstream|bad gateway|service unavailable|gateway timeout|internal error)/.test(
			text,
		)
	)
}

/**
 * Runs a connected-app call, retrying once when the upstream merely blinked.
 *
 * A failed retry is reported as the original error, so the model sees the
 * upstream's own words.
 */
export async function callWithTransientRetry<T>(
	call: () => PromiseLike<T>,
	options: { readOnly: boolean; attempt?: number; label?: string },
): Promise<T> {
	const maxAttempts = options.readOnly ? (options.attempt ?? 2) : 1
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await call()
		} catch (error) {
			lastError = error
			if (attempt >= maxAttempts) break
			if (!isTransientUpstreamError(error)) break
			console.log(
				`[company-brain] transient upstream failure on ${
					options.label ?? "connected app"
				}, retrying once: ${errorText(error).slice(0, 160)}`,
			)
		}
	}
	throw lastError
}
