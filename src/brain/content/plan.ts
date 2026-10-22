/**
 * The daily content plan: which kinds of post to draft, and where each lands.
 *
 * Deterministic by design — rotation is a function of the weekday and what the
 * last few days already covered, so the same inputs always produce the same
 * plan and the mix across a week stays varied without the model deciding.
 *
 * The rotation is the floor, not the driver: when the evidence stage found
 * something worth posting, its angles lead and the rotation only fills the
 * gaps. A plan that ignores what actually happened produces posts about the
 * kind of thing that happens on that weekday, which is the failure this
 * replaces.
 */
import { CONTENT_DRAFT_KINDS, type ContentDraftKind } from "./store"
import {
	defaultFunnelForKind,
	defaultVehicleForKind,
	type ContentFunnel,
	type ContentVehicle,
} from "./taxonomy"

export type ContentChannel = {
	id: string
	service: string
	name: string
	/**
	 * Buffer's channel type: page, profile, group. It decides how a post can
	 * be published — Buffer cannot auto-publish to a Facebook group or an
	 * Instagram personal profile, so those channels need a reminder instead.
	 */
	type?: string | null
}

export type PlannedDraft = {
	kind: ContentDraftKind
	funnel: ContentFunnel
	vehicle: ContentVehicle
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
 *
 * When the evidence stage ran, its angles decide what gets written: a post
 * about something that actually happened beats a post about the kind that
 * happens to be scheduled for today. The weekday plan is still the floor —
 * an angle whose kind was covered recently is dropped, and if nothing
 * survives, the plan falls back to the rotation so a quiet day is still a
 * rotation day.
 */
export function planDailyDrafts(args: {
	dayOfWeek: number
	recentKinds?: readonly string[]
	channels?: readonly ContentChannel[]
	count?: number
	/** Angles from the evidence packet, in packet order. */
	angles?: readonly { kind: ContentDraftKind }[]
}): PlannedDraft[] {
	const count = args.count ?? CONTENT_DRAFTS_PER_DAY
	const recent = new Set((args.recentKinds ?? []).slice(0, 6))
	const evidenceKinds: ContentDraftKind[] = []
	for (const angle of args.angles ?? []) {
		if (evidenceKinds.length >= count) break
		if (evidenceKinds.includes(angle.kind)) continue
		// A kind covered in the last few days is skipped: the audience saw it.
		if (recent.has(angle.kind)) continue
		evidenceKinds.push(angle.kind)
	}
	const kinds = evidenceKinds.length
		? evidenceKinds
		: planDailyKinds(args.dayOfWeek, args.recentKinds ?? [], count)
	const channels = args.channels ?? []
	const day = ((args.dayOfWeek % 7) + 7) % 7
	const offset = channels.length ? day % channels.length : 0
	return kinds.map((kind, i) => ({
		kind,
		funnel: defaultFunnelForKind(kind),
		vehicle: defaultVehicleForKind(kind),
		channel: channels.length
			? (channels[(offset + i) % channels.length] ?? null)
			: null,
	}))
}
