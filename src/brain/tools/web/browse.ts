import { tool } from "ai"
import { z } from "zod"
import { logPreview } from "../../observability/log-utils"
import type { SourcedToolOutput } from "../../sources"

/**
 * Self-hosted browser agent (browser-use on your own VPS — no Browser-Use
 * Cloud). The Worker cannot run Chromium, so this tool POSTs the task to
 * BROWSER_SERVICE_URL (/run, Bearer BROWSER_SERVICE_TOKEN) where a FastAPI +
 * browser-use sidecar drives headless Chromium with YOUR LLM key.
 *
 * Returns null when unconfigured so the tool simply does not exist.
 */

// A browser run must settle inside the turn's pause budget (7 of 10 minutes),
// so even a slow page leaves room to pause and offer Continue.
const RUN_TIMEOUT_MS = 5 * 60 * 1000
/** Keep one browser run from flooding the turn. */
const RESULT_BUDGET = 12_000

export function hasBrowserService(env: Env): boolean {
	return Boolean(env.BROWSER_SERVICE_URL?.trim() && env.BROWSER_SERVICE_TOKEN?.trim())
}

function clip(text: string, budget = RESULT_BUDGET): string {
	const trimmed = text.trim()
	if (trimmed.length <= budget) return trimmed
	return `${trimmed.slice(0, budget)}\n\n[... ${(
		trimmed.length - budget
	).toLocaleString()} characters truncated. Ask a narrower follow-up to get the rest ...]`
}

export function createBrainBrowserAgentTool(env: Env, traceId?: string) {
	const baseUrl = env.BROWSER_SERVICE_URL?.trim().replace(/\/$/, "")
	const token = env.BROWSER_SERVICE_TOKEN?.trim()
	if (!baseUrl || !token) return null

	return tool({
		description:
			"Drive a real headless browser to do interactive web work that plain page reading cannot: clicking through multi-step flows, filling forms, checking logged-in dashboards, verifying what a page actually shows, or scraping JavaScript-heavy sites. Give a concrete goal and a starting URL. Slow (up to minutes) and one task at a time, so use search_web/web_extract first when those suffice, and put everything needed in a single call.",
		inputSchema: z.object({
			task: z
				.string()
				.min(5)
				.max(2000)
				.describe(
					"Concrete browser goal in one or two sentences, e.g. 'Check the pricing page and list all plan prices' or 'Go through the checkout flow up to the payment step and report what fields are required'.",
				),
			start_url: z
				.string()
				.url()
				.describe("Full https:// URL where the browser starts."),
		}),
		execute: async ({ task, start_url }, options) => {
			const t = Date.now()
			const tag = traceId ? `[${traceId}]` : ""
			// The turn can abort (superseded, paused) while the browser works;
			// stop the request with it instead of orphaning a minutes-long run.
			const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS)
			const turnSignal = (
				options as { abortSignal?: AbortSignal } | undefined
			)?.abortSignal
			const signal =
				turnSignal && typeof AbortSignal.any === "function"
					? AbortSignal.any([timeout, turnSignal])
					: timeout
			console.log(
				`[company-brain]${tag} browse_website start url="${logPreview(start_url)}" task="${logPreview(task)}"`,
			)
			try {
				const response = await fetch(`${baseUrl}/run`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ task, start_url }),
					signal,
				})
				if (response.status === 429) {
					return "The browser is busy with another task right now. Tell the person it is running one job at a time and to retry in a minute."
				}
				if (response.status === 504) {
					return "The browser task took too long and was stopped. Break the goal into a smaller step and try again."
				}
				if (!response.ok) {
					const detail = await response.text().catch(() => "")
					console.warn(
						`[company-brain]${tag} browse_website service error ${response.status}: ${logPreview(detail)}`,
					)
					return "The browser task failed before producing a result. Try a narrower task, or fall back to web_extract on the page URL."
				}
				const data = (await response.json()) as {
					ok?: boolean
					result?: string
					steps?: number
					ms?: number
				}
				const result = (data.result ?? "").trim()
				console.log(
					`[company-brain]${tag} browse_website finish ms=${Date.now() - t} steps=${data.steps ?? "?"} chars=${result.length}`,
				)
				if (!result) {
					return "The browser finished but returned no text. The page may need a login the browser does not have, or the flow changed mid-run."
				}
				return {
					output: `Browser result for ${start_url}:\n\n${clip(result)}`,
					sources: [{ source: start_url, title: start_url }],
				} satisfies SourcedToolOutput
			} catch (err) {
				console.warn(`[company-brain]${tag} browse_website error:`, err)
				const timedOut =
					err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
				return timedOut
					? "The browser task took too long and was stopped. Break the goal into a smaller step and try again."
					: "Could not reach the browser service. It may be down — tell the person to check the VPS sidecar, and offer what search_web/web_extract can answer meanwhile."
			}
		},
	})
}
