import { tool } from "ai"
import { z } from "zod"
import { searchGifs, type GifCandidateRegistry } from "./gifs"

const MAX_SEARCHES_PER_TURN = 3
const SEARCH_TIMEOUT_MS = 5_000

/**
 * Live GIF search for personality expression. Candidates are stored in the
 * per-turn registry and referenced by opaque id: raw URLs never travel
 * through model text, so nothing the model writes can put an arbitrary URL
 * into a Slack image block. finish_turn.gif_id resolves against this map.
 */
export function createBrainGifSearchTool(
	env: Env,
	traceId: string | undefined,
	registry: GifCandidateRegistry,
) {
	let searches = 0
	let nextId = registry.size
	return tool({
		description:
			"Search a live GIF catalog (Giphy/Tenor) for one short, specific moment: a shipped win, a thank-you, a welcome, a blocker cleared. Returns numbered candidate ids; pass the best one as gif_id in finish_turn and the GIF is attached to your final message. Use at most once per genuine win, and skip entirely when nothing fits.",
		inputSchema: z.object({
			query: z
				.string()
				.min(2)
				.max(120)
				.describe(
					"Short, specific GIF search query, e.g. 'shipped it celebration', 'thank you high five', 'welcome new teammate'.",
				),
		}),
		execute: async ({ query }) => {
			const tag = traceId ? `[${traceId}]` : ""
			searches += 1
			if (searches > MAX_SEARCHES_PER_TURN) {
				return "GIF search limit reached for this turn. Pick from the candidates already returned, or finish without a GIF."
			}
			const startedAt = Date.now()
			console.log(`[company-brain]${tag} search_gifs start query="${query}"`)
			try {
				const hits = await searchGifs(env, query, {
					limit: 6,
					timeoutMs: SEARCH_TIMEOUT_MS,
				})
				console.log(
					`[company-brain]${tag} search_gifs finish ms=${Date.now() - startedAt} results=${hits.length}`,
				)
				if (!hits.length) {
					return `No GIFs found for "${query}". Continue without a GIF.`
				}
				const lines: string[] = []
				for (const hit of hits) {
					nextId += 1
					const id = `g${nextId}`
					registry.set(id, hit)
					lines.push(`- ${id}: ${hit.altText}`)
				}
				return `Candidates for "${query}" (pass one id as finish_turn.gif_id, or continue without a GIF):\n${lines.join("\n")}`
			} catch (error) {
				console.warn(`[company-brain]${tag} search_gifs error:`, error)
				return "GIF search is unavailable right now. Continue without a GIF."
			}
		},
	})
}
