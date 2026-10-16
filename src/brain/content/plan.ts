/**
 * The daily content plan: which kinds of post to draft, and where each lands.
 *
 * Deterministic by design — rotation is a function of the weekday and what the
 * last few days already covered, so the same inputs always produce the same
 * plan and the mix across a week stays varied without the model deciding.
 */
import { CONTENT_DRAFT_KINDS, type ContentDraftKind } from "./store"

export type ContentChannel = {
	id: string
	service: string
	name: string
}

export type PlannedDraft = {
	kind: ContentDraftKind
	channel: ContentChannel | null
}

// Weekday-first mixes. Each day leads with a different kind so content types
// rotate across the week; the other slots add range (a proof point plus a
// conversation starter).
const WEEKLY_PLAN: Record<number, ContentDraftKind[]> = {
	0: ["question", "lesson", "spotlight"],
	1: ["build_log", "lesson", "spotlight"],
	2: ["behind_the_scenes", "build_log", "hot_take"],
	3: ["lesson", "spotlight", "question"],
	4: ["build_log", "behind_the_scenes", "hot_take"],
	5: ["spotlight", "lesson", "question"],
	6: ["behind_the_scenes", "hot_take", "build_log"],
}

export const CONTENT_DRAFTS_PER_DAY = 3

/**
 * Pick the day's kinds, skipping anything the last few days already covered.
 * If the recent window collides with the whole day-plan (a quiet week, a
 * re-run), fall back to whichever kinds are furthest from the recent set.
 */
export function planDailyKinds(
	dayOfWeek: number,
	recentKinds: readonly string[],
	count = CONTENT_DRAFTS_PER_DAY,
): ContentDraftKind[] {
	const day = ((dayOfWeek % 7) + 7) % 7
	const base = WEEKLY_PLAN[day] ?? WEEKLY_PLAN[1] ?? []
	const recent = new Set(recentKinds.slice(0, 6))
	const out: ContentDraftKind[] = []
	const push = (kind: ContentDraftKind) => {
		if (out.length >= count) return
		if (out.includes(kind)) return
		out.push(kind)
	}
	for (const kind of base) {
		if (!recent.has(kind)) push(kind)
	}
	for (const kind of CONTENT_DRAFT_KINDS) {
		if (!recent.has(kind)) push(kind)
	}
	// Everything was recent; the least-recently-used kinds are the tail of the
	// recent list, so take from base first, then anything at all.
	for (const kind of base) push(kind)
	for (const kind of CONTENT_DRAFT_KINDS) push(kind)
	return out
}

/**
 * Build the day's drafts. Channels rotate round-robin from a day-dependent
 * offset so different platforms lead across the week; with no connected
 * channels the drafts are still written (they just aren't channel-targeted).
 */
export function planDailyDrafts(args: {
	dayOfWeek: number
	recentKinds?: readonly string[]
	channels?: readonly ContentChannel[]
	count?: number
}): PlannedDraft[] {
	const kinds = planDailyKinds(
		args.dayOfWeek,
		args.recentKinds ?? [],
		args.count ?? CONTENT_DRAFTS_PER_DAY,
	)
	const channels = args.channels ?? []
	const day = ((args.dayOfWeek % 7) + 7) % 7
	const offset = channels.length ? day % channels.length : 0
	return kinds.map((kind, i) => ({
		kind,
		channel: channels.length
			? (channels[(offset + i) % channels.length] ?? null)
			: null,
	}))
}
