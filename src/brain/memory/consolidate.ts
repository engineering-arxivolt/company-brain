/**
 * The dream's judgement, without the dream.
 *
 * Memory accumulates: the same fact gets written twice from two threads, a
 * decision from eight months ago sits next to today's reversal, and nothing
 * ever removes either. A nightly pass fixes that — but a pass that *merges
 * facts* is how a brain starts asserting things nobody said. So the rules here
 * are deliberately timid:
 *
 * - Duplicates are only ever the **same note twice**: identical after
 *   normalisation (case, bullets, punctuation, accents, whitespace). Nothing
 *   fuzzy, nothing semantic, no merging of near-misses.
 * - When a note exists twice, the **newest copy wins** and the older ones go.
 * - "Stale" is about **age**, not content: a fact nobody has refreshed in
 *   `staleAfterDays` stops being asserted in a reply that cites it.
 *
 * Everything is a pure function of the documents and a clock passed in, so the
 * whole policy is testable and the run itself has no decisions left to make.
 */
export type ConsolidationDoc = {
	id: string
	content: string
	/** Epoch ms. */
	createdAt: number
}

export type ConsolidationDuplicate = {
	/** The normalised form that matched. */
	key: string
	/** The copy that survives — the newest. */
	keep: string
	/** Older copies of the same note. */
	drop: string[]
}

export type ConsolidationPlan = {
	duplicates: ConsolidationDuplicate[]
	stale: Array<{ id: string; ageDays: number }>
	/** Distinct notes after de-duplication: what the brain will still know. */
	distinct: number
}

/** A note older than this has stopped being current unless re-written. */
export const DEFAULT_STALE_AFTER_DAYS = 180

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The shape of a fact, for "is this the same note twice".
 *
 * Normalisation only — no stemming, no synonyms, no similarity threshold. The
 * cost of a missed duplicate is a slightly redundant memory; the cost of a
 * wrong merge is a fact the brain now states that nobody actually said.
 */
export function factKey(content: string): string {
	return content
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/^[\s>*-]+/gm, "")
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
}

/** Plan the nightly pass over one container's documents. */
export function planConsolidation(
	docs: readonly ConsolidationDoc[],
	options: { now: number; staleAfterDays?: number },
): ConsolidationPlan {
	const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS
	const staleAfterMs = staleAfterDays * DAY_MS

	const groups = new Map<string, ConsolidationDoc[]>()
	for (const doc of docs) {
		const key = factKey(doc.content)
		if (!key) continue
		const group = groups.get(key)
		if (group) group.push(doc)
		else groups.set(key, [doc])
	}

	const duplicates: ConsolidationDuplicate[] = []
	for (const [key, group] of groups) {
		if (group.length < 2) continue
		// Newest survives; tie broken by id so the plan is deterministic.
		const ordered = [...group].sort(
			(a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
		)
		const [survivor, ...older] = ordered
		if (!survivor) continue
		duplicates.push({ key, keep: survivor.id, drop: older.map((doc) => doc.id) })
	}

	// Only notes that survive de-duplication can be stale — no point ageing a
	// copy that is about to be deleted.
	const dropped = new Set(duplicates.flatMap((entry) => entry.drop))
	const stale = docs
		.filter((doc) => !dropped.has(doc.id))
		.filter((doc) => factKey(doc.content).length > 0)
		.map((doc) => ({ id: doc.id, ageDays: Math.max(0, Math.floor((options.now - doc.createdAt) / DAY_MS)) }))
		.filter((entry) => entry.ageDays * DAY_MS >= staleAfterMs)

	return {
		duplicates,
		stale,
		// Notes with no words are invisible here: they carry nothing to
		// de-duplicate and nothing to age, so they are not counted as knowledge.
		distinct: groups.size,
	}
}

/** Milliseconds until the next `hourUtc:00` — the dream's own alarm. */
export function msUntilNextDream(
	now: Date,
	hourUtc = 3,
): number {
	const next = new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate(),
			hourUtc,
			0,
			0,
			0,
		),
	)
	if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
	return next.getTime() - now.getTime()
}
