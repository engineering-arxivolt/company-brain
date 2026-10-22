/**
 * The two labels every Content Studio draft carries.
 *
 * `funnel` is the job the post does for the business:
 *   TOF - earn attention from people who do not know us yet
 *   MOF - build trust with people who do
 *   BOF - give a ready buyer a reason to act
 *
 * `vehicle` is the form the post takes. It is deliberately separate from the
 * draft kind: a "lesson" can be told as a story or as a breakdown, and the
 * weekly loop needs to see both dimensions when a format starts winning.
 *
 * The mapping below is the default, not a cage. A person (or a future weekly
 * plan) can override either label on a draft.
 */
import type { ContentDraftKind } from "./store"

export const CONTENT_FUNNELS = ["TOF", "MOF", "BOF"] as const
export type ContentFunnel = (typeof CONTENT_FUNNELS)[number]

export const CONTENT_VEHICLES = [
	"story",
	"build_log",
	"hot_take",
	"question",
	"breakdown",
	"framework",
	"proof",
	"case_study",
	"listicle",
	"promo",
] as const
export type ContentVehicle = (typeof CONTENT_VEHICLES)[number]

const DEFAULT_FUNNEL: Record<ContentDraftKind, ContentFunnel> = {
	build_log: "MOF",
	lesson: "MOF",
	spotlight: "BOF",
	behind_the_scenes: "TOF",
	hot_take: "TOF",
	question: "TOF",
}

const DEFAULT_VEHICLE: Record<ContentDraftKind, ContentVehicle> = {
	build_log: "build_log",
	lesson: "story",
	spotlight: "proof",
	behind_the_scenes: "story",
	hot_take: "hot_take",
	question: "question",
}

export const FUNNEL_LABELS: Record<ContentFunnel, string> = {
	TOF: "TOF · reach",
	MOF: "MOF · trust",
	BOF: "BOF · action",
}

export const VEHICLE_LABELS: Record<ContentVehicle, string> = {
	story: "Story",
	build_log: "Build log",
	hot_take: "Point of view",
	question: "Question",
	breakdown: "Breakdown",
	framework: "Framework",
	proof: "Proof",
	case_study: "Case study",
	listicle: "Listicle",
	promo: "Offer",
}

/**
 * The writing instruction for the funnel job. This is what stops every post
 * from becoming a product announcement with a different opening line.
 */
export const FUNNEL_BRIEFS: Record<ContentFunnel, string> = {
	TOF:
		"Earn attention from someone who does not know us yet. Lead with a specific, useful or surprising idea from the work. Teach or show something; do not introduce the company or ask for anything.",
	MOF:
		"Build trust with someone who already knows us. Show how we think or how we work through one concrete decision, lesson, or tradeoff. Make the reader believe we know what we are doing.",
	BOF:
		"Give someone who is already interested a reason to act. Name one concrete thing we can do for them, backed by a real proof point, and make the next step obvious without turning the post into an ad.",
}

export const VEHICLE_BRIEFS: Record<ContentVehicle, string> = {
	story: "Tell it as a short story with a specific starting point and a change by the end.",
	build_log:
		"Write it as a build log: what shipped, what it changes for the person using it, and one honest detail from the process.",
	hot_take:
		"Write it as a clear point of view: one claim, the reason behind it, and the tradeoff you accept by taking that position.",
	question:
		"Write it as one genuine question the audience can answer from experience. The answers should teach us something real.",
	breakdown:
		"Break it into a few concrete steps or parts. Each line should add information, not restate the heading.",
	framework:
		"Name the parts of a repeatable way of thinking, in the order someone would actually use them.",
	proof:
		"Lead with the concrete capability or result and the evidence behind it. Keep the claim narrow enough to be true.",
	case_study:
		"Show the before, the decision, and the after for one real situation. Keep names and details within what is public.",
	listicle:
		"Use a short list only when each item is a distinct, specific thing. No filler items and no rule-of-three padding.",
	promo:
		"Make the offer plainly, with who it is for, what they get, and one next step. No hype and no fake scarcity.",
}

export function defaultFunnelForKind(kind: ContentDraftKind): ContentFunnel {
	return DEFAULT_FUNNEL[kind] ?? "MOF"
}

export function defaultVehicleForKind(kind: ContentDraftKind): ContentVehicle {
	return DEFAULT_VEHICLE[kind] ?? "story"
}

export function isContentFunnel(value: unknown): value is ContentFunnel {
	return (
		typeof value === "string" &&
		(CONTENT_FUNNELS as readonly string[]).includes(value)
	)
}

export function isContentVehicle(value: unknown): value is ContentVehicle {
	return (
		typeof value === "string" &&
		(CONTENT_VEHICLES as readonly string[]).includes(value)
	)
}

export function resolveFunnel(
	value: string | null | undefined,
	kind: ContentDraftKind,
): ContentFunnel {
	return isContentFunnel(value) ? value : defaultFunnelForKind(kind)
}

export function resolveVehicle(
	value: string | null | undefined,
	kind: ContentDraftKind,
): ContentVehicle {
	return isContentVehicle(value) ? value : defaultVehicleForKind(kind)
}

export function funnelLabel(funnel: ContentFunnel): string {
	return FUNNEL_LABELS[funnel] ?? funnel
}

export function vehicleLabel(vehicle: ContentVehicle): string {
	return VEHICLE_LABELS[vehicle] ?? vehicle
}

export type FunnelBalance = {
	counts: Record<ContentFunnel, number>
	total: number
	missing: ContentFunnel[]
	/** A one-line diagnosis for a review card, or null for an empty round. */
	note: string | null
}

/**
 * Count the round's funnel mix and name the gap.
 *
 * A round with no BOF is not "bad" in isolation, but a stream of them is how a
 * content system becomes a diary: lots of attention, no path to a customer.
 * The card says it out loud while the draft is still easy to change.
 */
export function funnelBalance(
	drafts: readonly { funnel?: string | null; kind?: ContentDraftKind }[],
): FunnelBalance {
	const counts: Record<ContentFunnel, number> = { TOF: 0, MOF: 0, BOF: 0 }
	for (const draft of drafts) {
		const funnel = isContentFunnel(draft.funnel)
			? draft.funnel
			: draft.kind
				? defaultFunnelForKind(draft.kind)
				: "MOF"
		counts[funnel]++
	}
	const total = drafts.length
	if (!total) {
		return { counts, total, missing: [...CONTENT_FUNNELS], note: null }
	}
	const missing = CONTENT_FUNNELS.filter((funnel) => counts[funnel] === 0)
	const parts = CONTENT_FUNNELS.filter((funnel) => counts[funnel] > 0).map(
		(funnel) => `${counts[funnel]} ${funnel}`,
	)
	const gaps: string[] = []
	if (missing.includes("TOF")) gaps.push("no TOF, so no new people")
	if (missing.includes("MOF")) gaps.push("no MOF, so no depth")
	if (missing.includes("BOF")) gaps.push("no BOF, so no ask")
	const diagnosis = gaps.length ? ` ${gaps.join("; ")}.` : " Balanced."
	return {
		counts,
		total,
		missing,
		note: `Round mix: ${parts.join(" · ")}.${diagnosis}`,
	}
}
