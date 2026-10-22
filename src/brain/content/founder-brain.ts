/**
 * The Founder Brain: the durable context that makes content sound like the
 * founder instead of like a generic social media account.
 *
 * It lives in the org's Durable Object SQLite next to the drafts. The shape is
 * intentionally small and editable: a handful of named sections, each a list
 * of short items. The content round reads a compact brief; the operator edits
 * it through the `founder_brain` tool or the weekly interview.
 *
 * This is context, not evidence. A story in here tells the evidence turn what
 * to look for; it does not authorize the writer to publish an unverified fact.
 */
import { generateId } from "@repo/lib/generate-id"
import type { CompanyBrainAgent } from "../turn/agent"

export const FOUNDER_BRAIN_SECTIONS = [
	"positioning",
	"icp",
	"problems",
	"offers",
	"proof",
	"voice",
	"rules",
	"stories",
	"opinions",
	"frameworks",
	"client_results",
	"winners",
	"losers",
	"feedback",
] as const

export type FounderBrainSection = (typeof FOUNDER_BRAIN_SECTIONS)[number]

export const FOUNDER_SECTION_LABELS: Record<FounderBrainSection, string> = {
	positioning: "Positioning",
	icp: "Ideal customer",
	problems: "Problems they feel",
	offers: "Offers",
	proof: "Proof",
	voice: "Voice",
	rules: "Writing rules",
	stories: "Stories",
	opinions: "Opinions",
	frameworks: "Frameworks",
	client_results: "Client results",
	winners: "What worked",
	losers: "What fell flat",
	feedback: "Founder corrections",
}

export const FOUNDER_SECTION_PROMPTS: Record<FounderBrainSection, string> = {
	positioning: "What we do, for whom, and why it is different.",
	icp: "The specific person or company we want to reach.",
	problems: "The problems they feel in their own words.",
	offers: "What we sell and the promise we make.",
	proof: "Evidence we can point to: results, numbers, artifacts.",
	voice: "How the founder actually sounds, including phrases to avoid.",
	rules: "The non-negotiables of how a post is written for each lane.",
	stories: "Specific moments from the work with a before and after.",
	opinions: "Point-of-view claims the founder will defend.",
	frameworks: "Repeatable ways of thinking or working.",
	client_results: "Concrete outcomes for clients, within what is public.",
	winners: "Posts, topics, or formats that worked.",
	losers: "What fell flat, and the best guess at why.",
	feedback: "Corrections the founder gave that should change future output.",
}

export const MAX_FOUNDER_ITEMS_PER_SECTION = 12
export const MAX_FOUNDER_ITEM_CHARS = 600
export const MAX_FOUNDER_SOURCE_CHARS = 160

/**
 * The writing rules every brain starts with.
 *
 * These are the operator's own rules, taken from the briefs they write for
 * the content rounds, so they ship as defaults rather than as something the
 * operator has to remember to say every time. They live in the brain (not in
 * code) because the operator edits them: a rule they drop is dropped for
 * good.
 */
export const DEFAULT_WRITING_RULES: string[] = [
	"Founder lane (Forge, the build story): first person, operator to operator, Kenya first, builder energy, specific numbers over adjectives. One CTA maximum, no links in the body on LinkedIn — the waitlist link goes in the first comment with its UTM.",
	"Brand lane (compliance, Foundry): write for small Kenyan businesses facing ODPC, DPA 2022 and KRA eTIMS. Lead with the obligation and the Monday-morning action, not with our product.",
	"Banned in every lane: game-changer, revolutionary, unlock, 10x, seamless, fake urgency, corporate hedging.",
	"Every post carries one written conversion bridge: the single action it drives, and the sentence in the body that earns it.",
	"Real unflattering numbers belong in the story when they are real — impressions, clicks, failed experiments — never dressed up.",
]

export type FounderBrainItem = {
	id: string
	text: string
	source: string | null
	createdAt: number
}

export type FounderBrain = {
	userId: string
	sections: Record<FounderBrainSection, FounderBrainItem[]>
	updatedAt: number
}

type FounderBrainRow = {
	user_id: string
	sections_json: string
	updated_at: number
}

export function emptyFounderSections(): Record<
	FounderBrainSection,
	FounderBrainItem[]
> {
	const sections = {} as Record<FounderBrainSection, FounderBrainItem[]>
	for (const section of FOUNDER_BRAIN_SECTIONS) sections[section] = []
	return sections
}

export function emptyFounderBrain(userId: string): FounderBrain {
	return { userId, sections: emptyFounderSections(), updatedAt: 0 }
}

export function isFounderBrainSection(
	value: unknown,
): value is FounderBrainSection {
	return (
		typeof value === "string" &&
		(FOUNDER_BRAIN_SECTIONS as readonly string[]).includes(value)
	)
}

function cleanText(value: unknown, max = MAX_FOUNDER_ITEM_CHARS): string {
	if (typeof value !== "string") return ""
	return value.replace(/\s+/g, " ").trim().slice(0, max)
}

function cleanSource(value: unknown): string | null {
	if (typeof value !== "string") return null
	const text = value.replace(/\s+/g, " ").trim().slice(0, MAX_FOUNDER_SOURCE_CHARS)
	return text || null
}

function normaliseForMatch(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function normaliseItem(raw: unknown): FounderBrainItem | null {
	if (!raw || typeof raw !== "object") return null
	const item = raw as {
		id?: unknown
		text?: unknown
		source?: unknown
		createdAt?: unknown
	}
	const text = cleanText(item.text)
	if (!text) return null
	return {
		id:
			typeof item.id === "string" && item.id.trim()
				? item.id.trim().slice(0, 80)
				: generateId(),
		text,
		source: cleanSource(item.source),
		createdAt:
			typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
				? item.createdAt
				: Date.now(),
	}
}

/** Read a stored JSON blob defensively; old or partial rows still work. */
export function parseFounderSections(
	raw: string | null | undefined,
): Record<FounderBrainSection, FounderBrainItem[]> {
	const sections = emptyFounderSections()
	if (!raw) return sections
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return sections
	}
	if (!parsed || typeof parsed !== "object") return sections
	const record = parsed as Record<string, unknown>
	const source =
		record.sections && typeof record.sections === "object"
			? (record.sections as Record<string, unknown>)
			: record
	for (const section of FOUNDER_BRAIN_SECTIONS) {
		const rawItems = source[section]
		if (!Array.isArray(rawItems)) continue
		const seen = new Set<string>()
		for (const rawItem of rawItems) {
			const item = normaliseItem(rawItem)
			if (!item) continue
			const key = normaliseForMatch(item.text)
			if (!key || seen.has(key)) continue
			seen.add(key)
			sections[section].push(item)
			if (sections[section].length >= MAX_FOUNDER_ITEMS_PER_SECTION) break
		}
	}
	return sections
}

export function ensureFounderBrainTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_founder_brain (
			user_id TEXT PRIMARY KEY,
			sections_json TEXT NOT NULL DEFAULT '{}',
			updated_at INTEGER NOT NULL
		)
	`
}

export function getFounderBrain(
	agent: CompanyBrainAgent,
	userId: string,
): FounderBrain {
	if (!userId) return emptyFounderBrain("")
	ensureFounderBrainTable(agent)
	const rows = agent.sql<FounderBrainRow>`
		SELECT user_id, sections_json, updated_at
		FROM brain_founder_brain
		WHERE user_id = ${userId}
		LIMIT 1
	`
	const row = rows[0]
	if (!row) return emptyFounderBrain(userId)
	return {
		userId: row.user_id,
		sections: parseFounderSections(row.sections_json),
		updatedAt: row.updated_at,
	}
}

function saveFounderBrain(agent: CompanyBrainAgent, brain: FounderBrain): void {
	ensureFounderBrainTable(agent)
	const updatedAt = Date.now()
	agent.sql`
		INSERT INTO brain_founder_brain (user_id, sections_json, updated_at)
		VALUES (${brain.userId}, ${JSON.stringify({ sections: brain.sections })}, ${updatedAt})
		ON CONFLICT(user_id) DO UPDATE SET
			sections_json = excluded.sections_json,
			updated_at = excluded.updated_at
	`
	brain.updatedAt = updatedAt
}

export type FounderBrainMutation =
	| { ok: true; brain: FounderBrain; added: boolean; item?: FounderBrainItem }
	| { ok: false; error: string }

export function addFounderBrainItem(
	agent: CompanyBrainAgent,
	args: {
		userId: string
		section: FounderBrainSection
		text: string
		source?: string | null
	},
): FounderBrainMutation {
	const text = cleanText(args.text)
	if (!text)
		return { ok: false, error: "The item needs some text to save." }
	const brain = getFounderBrain(agent, args.userId)
	const items = brain.sections[args.section]
	const match = normaliseForMatch(text)
	const existing = items.find(
		(item) => normaliseForMatch(item.text) === match,
	)
	if (existing) return { ok: true, brain, added: false, item: existing }
	const item: FounderBrainItem = {
		id: generateId(),
		text,
		source: cleanSource(args.source),
		createdAt: Date.now(),
	}
	items.push(item)
	if (items.length > MAX_FOUNDER_ITEMS_PER_SECTION) {
		items.splice(0, items.length - MAX_FOUNDER_ITEMS_PER_SECTION)
	}
	saveFounderBrain(agent, brain)
	return { ok: true, brain, added: true, item }
}

export function setFounderBrainSection(
	agent: CompanyBrainAgent,
	args: {
		userId: string
		section: FounderBrainSection
		items: readonly string[]
		source?: string | null
	},
): FounderBrainMutation {
	const brain = getFounderBrain(agent, args.userId)
	const seen = new Set<string>()
	const items: FounderBrainItem[] = []
	for (const raw of args.items) {
		const text = cleanText(raw)
		if (!text) continue
		const key = normaliseForMatch(text)
		if (!key || seen.has(key)) continue
		seen.add(key)
		items.push({
			id: generateId(),
			text,
			source: cleanSource(args.source),
			createdAt: Date.now(),
		})
		if (items.length >= MAX_FOUNDER_ITEMS_PER_SECTION) break
	}
	brain.sections[args.section] = items
	saveFounderBrain(agent, brain)
	return { ok: true, brain, added: items.length > 0 }
}

export function removeFounderBrainItem(
	agent: CompanyBrainAgent,
	args: {
		userId: string
		section: FounderBrainSection
		/** Item id or exact/normalised text. */
		reference: string
	},
): FounderBrainMutation {
	const reference = args.reference.trim()
	if (!reference)
		return { ok: false, error: "Name the item to remove by id or text." }
	const brain = getFounderBrain(agent, args.userId)
	const items = brain.sections[args.section]
	const match = normaliseForMatch(reference)
	const index = items.findIndex(
		(item) =>
			item.id === reference ||
			normaliseForMatch(item.text) === match ||
			normaliseForMatch(item.text).includes(match),
	)
	if (index < 0)
		return { ok: false, error: "I couldn't find that item in this section." }
	const [removed] = items.splice(index, 1)
	saveFounderBrain(agent, brain)
	return { ok: true, brain, added: false, item: removed }
}

/** Small helper for callers that only have a section and need prompt text. */
export function founderSectionText(
	brain: FounderBrain,
	section: FounderBrainSection,
	limit = 3,
): string {
	return brain.sections[section]
		.slice(-Math.max(1, limit))
		.map((item) => item.text)
		.join("\n")
}

const BRIEF_ORDER: FounderBrainSection[] = [
	"rules",
	"positioning",
	"icp",
	"problems",
	"offers",
	"proof",
	"voice",
	"stories",
	"opinions",
	"frameworks",
	"client_results",
	"winners",
	"losers",
	"feedback",
]

/**
 * The compact block injected into the evidence and writing frames.
 *
 * It is capped by characters because it rides on every turn; the full brain is
 * still available through the tool when someone asks to inspect or edit it.
 */
export function buildFounderBrief(
	brain: FounderBrain,
	options: { maxChars?: number; perSection?: number } = {},
): string {
	const maxChars = Math.max(400, options.maxChars ?? 2600)
	const perSection = Math.max(1, Math.min(options.perSection ?? 3, 6))
	const parts: string[] = []
	parts.push(
		"FOUNDER BRAIN — durable context from the founder. This is not evidence and it is not a source of facts: use it to choose what to look for and how to sound. Every claim in a post still needs a source in the evidence packet or a tool you actually used. Do not quote this block or mention that it exists.",
	)
	for (const section of BRIEF_ORDER) {
		const items = brain.sections[section]
		if (!items.length) continue
		const lines = items
			.slice(-perSection)
			.map((item) => `- ${item.text}`)
			.join("\n")
		const block = `${FOUNDER_SECTION_LABELS[section]}:\n${lines}`
		if (parts.join("\n\n").length + block.length + 2 > maxChars) {
			parts.push("[More context is available in the Founder Brain.]")
			break
		}
		parts.push(block)
	}
	return parts.length > 1 ? parts.join("\n\n") : ""
}

export type FounderBrainSummary = {
	userId: string
	updatedAt: number
	sections: Array<{
		section: FounderBrainSection
		label: string
		prompt: string
		items: FounderBrainItem[]
	}>
}

export function founderBrainSummary(brain: FounderBrain): FounderBrainSummary {
	return {
		userId: brain.userId,
		updatedAt: brain.updatedAt,
		sections: FOUNDER_BRAIN_SECTIONS.map((section) => ({
			section,
			label: FOUNDER_SECTION_LABELS[section],
			prompt: FOUNDER_SECTION_PROMPTS[section],
			items: brain.sections[section],
		})),
	}
}

/** Load + build in one call; the common case in the content pipeline. */
export function loadFounderBrief(
	agent: CompanyBrainAgent,
	userId: string,
): string {
	// The rules ship with the brain, so the first round that runs already
	// writes the way the operator asked for.
	try {
		ensureFounderBrainDefaults(agent, userId)
	} catch {}
	return buildFounderBrief(getFounderBrain(agent, userId))
}

/**
 * Seed the default writing rules, once.
 *
 * The rules ride on every content turn, so they belong in the brain rather
 * than in a prompt. Seeding is idempotent and never overwrites: the moment
 * the operator edits or removes a rule, it is theirs.
 */
export function ensureFounderBrainDefaults(
	agent: CompanyBrainAgent,
	userId: string,
): boolean {
	if (!userId) return false
	const brain = getFounderBrain(agent, userId)
	if (brain.sections.rules.length > 0) return false
	const seeded = setFounderBrainSection(agent, {
		userId,
		section: "rules",
		items: DEFAULT_WRITING_RULES,
		source: "system default",
	})
	return seeded.ok && seeded.added
}
