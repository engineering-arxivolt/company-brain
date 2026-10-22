/**
 * Seed material for the Founder Brain, pulled from the company memory.
 *
 * The weekly interview is still the best source of founder context. This is the
 * shortcut for everything the workspace already knows: run a handful of broad
 * memory searches, return the strongest snippets grouped by the kind of claim
 * they support, then let the turn synthesise the sections.
 *
 * It deliberately returns evidence rather than writing sections itself. Memory
 * contains stale claims, other people's words, and facts that are not safe to
 * publish. The model (and the operator) should decide what belongs in the
 * Founder Brain, not a keyword matcher.
 */
import type { SlackOrg } from "../slack/workspace"
import type { CompanyBrainAgent } from "./agent"
import { searchBrain } from "../memory/search-brain"
import type { SlackMemoryScope } from "../memory/writeback"
import {
	FOUNDER_BRAIN_SECTIONS,
	FOUNDER_SECTION_LABELS,
	type FounderBrainSection,
} from "../content/founder-brain"

export type FounderMemoryGroup = {
	id: string
	label: string
	/** Sections these snippets are most likely to support. */
	sections: FounderBrainSection[]
	query: string
	items: Array<{
		text: string
		source: string | null
		similarity: number | null
	}>
	error?: string
}

export type FounderMemoryPacket = {
	groups: FounderMemoryGroup[]
	searched: number
	returned: number
	/** The operator's positioning/topic hint, when they gave one. */
	focus?: string
}

const MEMORY_GROUPS: Array<{
	id: string
	label: string
	sections: FounderBrainSection[]
	query: string
}> = [
	{
		id: "positioning",
		label: "Positioning, ICP, problems, and offers",
		sections: ["positioning", "icp", "problems", "offers"],
		query:
			"company positioning, ideal customer, ICP, target market, customer problems, products, services, offers, pricing, what the company does",
	},
	{
		id: "proof",
		label: "Proof, client results, and stories",
		sections: ["proof", "client_results", "stories"],
		query:
			"customer results, proof, case studies, launches, wins, milestones, founder stories, decisions, failures, turning points",
	},
	{
		id: "opinions",
		label: "Opinions, frameworks, voice, and feedback",
		sections: ["opinions", "frameworks", "voice", "feedback"],
		query:
			"founder opinions, beliefs, contrarian views, repeatable frameworks, how the team works, tone of voice, writing feedback, phrases",
	},
	{
		id: "content",
		label: "What worked and what fell flat",
		sections: ["winners", "losers"],
		query:
			"SEO, content marketing, posts that performed well, posts that fell flat, engagement, search traffic, social media, newsletter",
	},
]

function cleanMemoryText(value: unknown): string {
	return typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, 420)
		: ""
}

function sourceFor(result: {
	id?: string
	filepath?: string | null
	resultType?: string
}): string | null {
	if (result.filepath?.trim()) return result.filepath.trim()
	if (result.id?.trim()) return result.id.trim()
	return null
}

function dedupeKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.slice(0, 180)
}

function itemsFromResults(
	results: ReadonlyArray<{
		id?: string
		memory?: string
		chunk?: string
		filepath?: string | null
		similarity?: number
	}>,
	limit = 4,
): FounderMemoryGroup["items"] {
	const seen = new Set<string>()
	const items: FounderMemoryGroup["items"] = []
	for (const result of results) {
		const text = cleanMemoryText(result.memory ?? result.chunk)
		if (!text) continue
		const key = dedupeKey(text)
		if (!key || seen.has(key)) continue
		seen.add(key)
		items.push({
			text,
			source: sourceFor(result),
			similarity:
				typeof result.similarity === "number" ? result.similarity : null,
		})
		if (items.length >= limit) break
	}
	return items
}

/**
 * Run the broad searches. A failed group is returned with its error instead of
 * failing the whole seed: partial context is still useful, and the caller can
 * ask a follow-up question for the missing part.
 *
 * The threshold is deliberately lower than interactive search. A broad seed
 * question ("what does the company do?") is semantically vague, and the normal
 * 0.3 cutoff rejects useful context before the model gets a chance to judge it.
 * The returned items are evidence, not automatic writes.
 */
export async function collectFounderBrainMemory(args: {
	agent: CompanyBrainAgent
	org: SlackOrg
	userId: string
	scope?: SlackMemoryScope
	containerTags?: string[]
	traceId?: string
	focus?: string | null
}): Promise<FounderMemoryPacket> {
	const startedAt = Date.now()
	const focus = args.focus?.trim().slice(0, 300) || undefined
	const groups: FounderMemoryGroup[] = []

	// The operator's own words are the strongest signal we have. Search them
	// separately instead of appending them to every section query: a long
	// positioning paragraph otherwise dominates the embedding and every group
	// returns the same handful of memories.
	if (focus) {
		try {
			const brain = await searchBrain(
				args.agent,
				args.org,
				args.userId,
				focus,
				args.scope,
				args.traceId,
				undefined,
				args.containerTags,
				{ threshold: 0.15, limit: 20 },
			)
			groups.push({
				id: "focus",
				label: "Operator focus and company context",
				sections: [...FOUNDER_BRAIN_SECTIONS],
				query: focus,
				items: itemsFromResults(brain.results, 8),
			})
		} catch (err) {
			groups.push({
				id: "focus",
				label: "Operator focus and company context",
				sections: [...FOUNDER_BRAIN_SECTIONS],
				query: focus,
				items: [],
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	for (const group of MEMORY_GROUPS) {
		// Keep the section queries short and distinct. The full focus was already
		// searched above; repeating it here made the groups converge on the same
		// few names and miss the actual company evidence.
		const query = group.query
		try {
			const brain = await searchBrain(
				args.agent,
				args.org,
				args.userId,
				query,
				args.scope,
				args.traceId,
				undefined,
				args.containerTags,
				{ threshold: 0.15, limit: 12 },
			)
			groups.push({
				...group,
				query,
				items: itemsFromResults(brain.results),
			})
		} catch (err) {
			groups.push({
				...group,
				query,
				items: [],
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	// A memory can support more than one section, but repeating the same sentence
	// four times wastes the model's context and makes a thin packet look rich.
	const seen = new Set<string>()
	for (const group of groups) {
		group.items = group.items.filter((item) => {
			const key = dedupeKey(item.text)
			if (!key || seen.has(key)) return false
			seen.add(key)
			return true
		})
	}

	// If every targeted query came back empty, the memories may use different
	// vocabulary. One permissive general search is a better answer than telling
	// the operator "nothing found" when the brain clearly has company context.
	if (groups.every((group) => group.items.length === 0)) {
		const fallbackQuery =
			focus ||
			"company, product, customer, positioning, strategy, SEO, AI, cloud, compliance"
		try {
			const brain = await searchBrain(
				args.agent,
				args.org,
				args.userId,
				fallbackQuery,
				args.scope,
				args.traceId,
				undefined,
				args.containerTags,
				{ threshold: 0.05, limit: 24 },
			)
			const items = itemsFromResults(brain.results, 8)
			if (items.length) {
				groups.push({
					id: "general",
					label: "General company memories",
					sections: [...FOUNDER_BRAIN_SECTIONS],
					query: fallbackQuery,
					items,
				})
			}
		} catch (err) {
			groups.push({
				id: "general",
				label: "General company memories",
				sections: [...FOUNDER_BRAIN_SECTIONS],
				query: fallbackQuery,
				items: [],
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const returned = groups.reduce((total, group) => total + group.items.length, 0)
	if (args.traceId) {
		console.log(
			`[company-brain][${args.traceId}] founder_brain seed groups=${groups.length} items=${returned} focus=${focus ? "yes" : "no"} ms=${Date.now() - startedAt}`,
		)
	}
	return { groups, searched: groups.length, returned, focus }
}

/** A compact, section-oriented packet the turn can read without another call. */
export function formatFounderMemoryPacket(packet: FounderMemoryPacket): string {
	const lines: string[] = [
		"Company memory evidence for the Founder Brain. Synthesise; do not copy wholesale.",
	]
	if (packet.focus) lines.push(`Operator focus: ${packet.focus}`)
	for (const group of packet.groups) {
		lines.push(
			`\n## ${group.label}`,
			`Likely sections: ${group.sections.map((section) => `${section} (${FOUNDER_SECTION_LABELS[section]})`).join(", ")}`,
		)
		if (group.error) {
			lines.push(`Search failed: ${group.error}`)
			continue
		}
		if (!group.items.length) {
			lines.push("No relevant memories found.")
			continue
		}
		group.items.forEach((item, index) => {
			const score =
				item.similarity != null
					? ` ${Math.round(item.similarity * 100)}%`
					: ""
			const source = item.source ? ` (${item.source})` : ""
			lines.push(`${index + 1}.${score} ${item.text}${source}`)
		})
	}
	return lines.join("\n")
}
