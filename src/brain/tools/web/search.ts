import { tool } from "ai"
import { z } from "zod"
import {
	contextSearch,
	creditsUsd,
	hasContextWeb,
	isRateLimited,
} from "@/lib/context-dev"
import type { BrainCostLedger } from "../../billing/cost"
import { logPreview } from "../../observability/log-utils"
import type { SourcedToolOutput } from "../../sources"
import { firecrawlSearch } from "./firecrawl"
import { searchDirect } from "./direct"

const SEARCH_TIMEOUT_MS = 15_000
/** Measured: 5 results of title+url+description is ~330 tokens, vs ~1,070 for the old LLM summary. */
const KEEP_RESULTS = 5

const FRESHNESS = [
	"last_24_hours",
	"last_week",
	"last_month",
	"last_year",
] as const

export function createBrainWebSearchTool(
	env: Env,
	traceId?: string,
	costLedger?: BrainCostLedger,
) {
	// context.dev when its key is set; otherwise Firecrawl, which needs none.
	const useContext = hasContextWeb(env)

	return tool({
		description:
			'Search the public web for external companies, products, people, news, documentation, or market context. Use when the question is about the outside world, or when Company Brain and connected apps did not answer it. Supports search operators: site:, -site:, inurl:, intitle:, "quoted phrases", and OR. Returns ranked results with titles, URLs, and snippets — call web_extract when a snippet is not enough.',
		inputSchema: z.object({
			query: z
				.string()
				.min(1)
				.max(500)
				.describe(
					"Focused web search query, e.g. 'Razorpay payment company overview' or 'site:supermemory.ai/docs ingest API'.",
				),
			freshness: z
				.enum(FRESHNESS)
				.optional()
				.describe(
					"Restrict to recently published content. Prefer this over writing dates into the query.",
				),
		}),
		execute: async ({ query, freshness }) => {
			const t = Date.now()
			const tag = traceId ? `[${traceId}]` : ""
			console.log(
				`[company-brain]${tag} search_web start query="${logPreview(query)}"`,
			)
			// Providers in order of quality, keyless last. Firecrawl's anonymous
			// tier is metered per egress IP and a Worker's address is shared with
			// everyone else on that tier, so a 429 there is the normal answer —
			// not a reason to tell someone their search is unavailable.
			type Hit = {
				title: string
				url: string
				description: string
				label: string
			}
			const providers: Array<{ name: string; run: () => Promise<Hit[]> }> = []
			if (useContext) {
				providers.push({
					name: "context.dev",
					run: async () => {
						const response = await contextSearch(
							env,
							{ query, freshness, timeoutMS: SEARCH_TIMEOUT_MS },
							tag,
						)
						costLedger?.recordVendorUsd("context.dev", creditsUsd(response))
						return response.results.map((r) => ({
							...r,
							label: `${r.title} (${r.relevance} relevance)`,
						}))
					},
				})
			}
			providers.push({
				name: "firecrawl",
				run: async () =>
					(
						await firecrawlSearch(env, {
							query,
							freshness,
							limit: KEEP_RESULTS,
							timeoutMs: SEARCH_TIMEOUT_MS,
						})
					).map((r) => ({ ...r, label: r.title })),
			})
			providers.push({
				name: "keyless",
				run: async () =>
					(
						await searchDirect({
							query,
							freshness,
							limit: KEEP_RESULTS,
							timeoutMs: SEARCH_TIMEOUT_MS,
						})
					).map((r) => ({ ...r, label: r.title })),
			})

			let results: Hit[] | undefined
			let lastError: unknown
			let rateLimited = false
			for (const provider of providers) {
				try {
					results = await provider.run()
					break
				} catch (err) {
					lastError = err
					if (isRateLimited(err)) rateLimited = true
					console.warn(
						`[company-brain]${tag} search_web ${provider.name} failed, trying the next provider:`,
						err,
					)
				}
			}
			if (!results) {
				console.warn(`[company-brain]${tag} search_web error:`, lastError)
				// Rephrasing does nothing for a quota error, so say which it is —
				// and say what still works, because a search quota must not end a
				// task that only needed a page read. A document request that died
				// on a 429 here is a task abandoned for no reason.
				return rateLimited
					? "Web search is rate limited right now (search quota, not the page reader). Do not abandon the task: if the asker supplied a link, call web_extract on that exact URL, which does not use search; if they supplied the text, use it directly. Only ask the person to retry, or to paste the text, when you truly have nothing to read. Searching again will not help."
					: "Web search failed. If the asker supplied a link, call web_extract on it instead of searching; otherwise try rephrasing the query."
			}
			const kept = results.slice(0, KEEP_RESULTS)
			console.log(
				`[company-brain]${tag} search_web finish ms=${Date.now() - t} results=${results.length} kept=${kept.length}`,
			)
			if (!kept.length) {
				return `No web results for "${query}". Try different wording, or drop any site: filter.`
			}
			// Sources travel as data, not as text the card has to scrape back out.
			return {
				output: kept
					.map((r) => `- ${r.label}\n  ${r.url}\n  ${r.description}`)
					.join("\n"),
				sources: kept.map((r) => ({ source: r.url, title: r.title })),
			} satisfies SourcedToolOutput
		},
	})
}
