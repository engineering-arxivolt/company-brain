/**
 * The growth decision model: which page to refresh, which topic to write,
 * which page to merge away, and which page to leave alone.
 *
 * This is the deterministic half of the SEO loop. It exists because "what
 * should we do this week?" must be reproducible — the same metrics must produce
 * the same action on every run, and a logged action must be explainable a month
 * later. The model is a proposal engine, not an oracle: the LLM researches and
 * writes, but it never decides priority.
 *
 * Inputs are the free signals we actually have (search impressions, clicks,
 * position, on-site sessions and conversions) and the one paid signal we
 * already buy (treg keyword volume). The CTR curve and conversion benchmark are
 * published medians, deliberately simple, and are meant to be replaced by this
 * site's own measured curve once enough actions have been logged — which is why
 * decisions carry reasons and not just a number.
 */
import { captureSeoEvent } from "@/lib/posthog"

export type SearchIntent = "informational" | "commercial" | "transactional" | "navigational"

/**
 * How much a unit of curiosity is worth to a software foundry. A transactional
 * query ("hire eTIMS integrator Nairobi") is a lead; an informational one is
 * mostly a brand impression, so it is discounted even when it carries volume.
 */
export const INTENT_WEIGHTS: Record<SearchIntent, number> = {
	informational: 0.6,
	commercial: 1,
	transactional: 1.2,
	navigational: 0.3,
}

/**
 * Expected CTR by position. Medians across published studies, banded so a
 * position-7 page and a position-9 page are not treated as different worlds.
 */
export const CTR_BENCHMARK: ReadonlyArray<{ maxPosition: number; ctr: number }> = [
	{ maxPosition: 1, ctr: 0.28 },
	{ maxPosition: 2, ctr: 0.15 },
	{ maxPosition: 3, ctr: 0.11 },
	{ maxPosition: 4, ctr: 0.08 },
	{ maxPosition: 5, ctr: 0.06 },
	{ maxPosition: 10, ctr: 0.04 },
	{ maxPosition: 20, ctr: 0.015 },
]

/** Beyond position 20 a page is not competing; it is background noise. */
const TAIL_CTR = 0.005

export function ctrBenchmark(position: number): number {
	if (!Number.isFinite(position) || position <= 0) return 0
	for (const band of CTR_BENCHMARK) {
		if (position <= band.maxPosition) return band.ctr
	}
	return TAIL_CTR
}

/** Share of sessions a service page should turn into an enquiry. */
export const PAGE_CVR_BENCHMARK = 0.02

export const ACTION_BAND = { doNow: 0.7, queue: 0.4 } as const

export type ActionBand = "do_now" | "queue" | "ignore"

export function bandFor(score: number): ActionBand {
	if (!Number.isFinite(score)) return "ignore"
	if (score >= ACTION_BAND.doNow) return "do_now"
	if (score >= ACTION_BAND.queue) return "queue"
	return "ignore"
}

export type PageRow = {
	slug: string
	/** 28-day totals; the window is fixed so scores are comparable week to week. */
	impressions: number
	clicks: number
	/** Average position across the window. */
	position: number
	/** Previous 28-day clicks, used for decay. */
	prevClicks?: number
	/** On-site sessions, once PostHog is feeding them. */
	sessions?: number
	conversions?: number
	/** Days since publish/refresh. */
	ageDays?: number
	intent?: SearchIntent
}

export type PageAction = "refresh" | "merge_redirect" | "cta_fix" | "leave"

export type PageDecision = {
	slug: string
	action: PageAction
	band: ActionBand
	score: number
	opportunity: number
	decay: number
	conversionGap: number
	reasons: string[]
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0
	return Math.min(1, Math.max(0, n))
}

/** Linear normalisation against a reference value; no magic exponentials. */
function norm(value: number, reference: number): number {
	if (!Number.isFinite(value) || reference <= 0) return 0
	return clamp01(value / reference)
}


function round3(n: number): number {
	return Math.round(n * 1000) / 1000
}

/**
 * Score and classify one page.
 *
 * `opportunity` is the clicks the page is leaving on the table given where it
 * ranks; `decay` catches a page that used to work; `conversionGap` catches a
 * page that gets traffic and wastes it. The weights (0.5/0.3/0.2) favour
 * opportunity because ranking movement is the slowest lever and the one that
 * compounds.
 */
export function scorePage(row: PageRow): PageDecision {
	const intent = row.intent ?? "informational"
	const weight = INTENT_WEIGHTS[intent]
	const impressions = Math.max(0, row.impressions)
	const clicks = Math.max(0, row.clicks)
	const actualCtr = impressions > 0 ? clicks / impressions : 0
	const expectedCtr = ctrBenchmark(row.position)
	const opportunity = Math.max(0, expectedCtr - actualCtr) * impressions * weight
	const decay = row.prevClicks && row.prevClicks > 0 ? clamp01(1 - clicks / row.prevClicks) : 0
	const sessions = Math.max(0, row.sessions ?? 0)
	const conversions = Math.max(0, row.conversions ?? 0)
	const cvr = sessions > 0 ? conversions / sessions : 0
	const conversionGap = sessions > 0 ? Math.max(0, PAGE_CVR_BENCHMARK - cvr) * sessions : 0
	const score = round3(0.5 * norm(opportunity, 500) + 0.3 * decay + 0.2 * norm(conversionGap, 10))

	const reasons: string[] = []
	let action: PageAction = "leave"

	if ((row.ageDays ?? 0) >= 90 && impressions < 10 && clicks === 0) {
		action = "merge_redirect"
		reasons.push(`90d+ with ${impressions} impressions and 0 clicks — fold it into a stronger page`)
	} else if (impressions >= 100 && row.position >= 8 && row.position <= 20 && actualCtr < expectedCtr * 0.6) {
		action = "refresh"
		reasons.push(
			`position ${round3(row.position)} at ${(actualCtr * 100).toFixed(1)}% CTR vs ${(expectedCtr * 100).toFixed(1)}% benchmark`,
		)
	} else if (sessions >= 100 && cvr < 0.005) {
		action = "cta_fix"
		reasons.push(`${sessions} sessions at ${(cvr * 100).toFixed(2)}% conversion — the offer or CTA is the problem`)
	}

	if (decay >= 0.3) reasons.push(`clicks down ${(decay * 100).toFixed(0)}% vs the previous 28 days`)
	if (score >= ACTION_BAND.doNow) reasons.push("score in the do-now band")
	else if (score >= ACTION_BAND.queue) reasons.push("score in the queue band")
	else reasons.push("score below the action threshold")

	return {
		slug: row.slug,
		action,
		band: bandFor(score),
		score,
		opportunity: round3(opportunity),
		decay: round3(decay),
		conversionGap: round3(conversionGap),
		reasons,
	}
}

export type TopicCandidate = {
	keyword: string
	volume: number
	cluster?: string
	intent?: SearchIntent
	/** Slugs that already target or cover this intent — the cannibalisation gate. */
	coveredSlugs?: string[]
	/** Internal pages that could link to a new article. Below 3 it orphans. */
	linkSurface?: number
	/** Regulatory change / deadline content decays and is worth more. */
	freshnessNeed?: boolean
}

export type TopicDecision = {
	keyword: string
	cluster?: string
	volume: number
	score: number
	band: ActionBand
	reasons: string[]
}

/**
 * Score a topic for new coverage.
 *
 * Coverage is a hard gate, not a discount: two pages on one intent split the
 * links and neither ranks, and the publishing API already refuses a second live
 * article per `target_keyword`. A covered topic therefore scores 0 with a
 * reason that says why, instead of being quietly deprioritised.
 */
export function scoreTopic(candidate: TopicCandidate, options: { maxVolume?: number } = {}): TopicDecision {
	const maxVolume = options.maxVolume && options.maxVolume > 0 ? options.maxVolume : 5_000
	const reasons: string[] = []
	const covered = (candidate.coveredSlugs ?? []).filter(Boolean)

	if (covered.length > 0) {
		return {
			keyword: candidate.keyword,
			cluster: candidate.cluster,
			volume: candidate.volume,
			score: 0,
			band: "ignore",
			reasons: [`already covered by ${covered.slice(0, 3).join(", ")} — refreshing beats a second page`],
		}
	}

	const volumeScore = norm(candidate.volume, maxVolume)
	const intent = candidate.intent ?? "informational"
	const intentWeight = INTENT_WEIGHTS[intent] / INTENT_WEIGHTS.transactional
	const linkSurface = candidate.linkSurface ?? 3
	const linkScore = clamp01(linkSurface / 3)
	const freshness = candidate.freshnessNeed ? 1.15 : 1
	const score = round3(clamp01(volumeScore * intentWeight * linkScore * freshness))

	if (volumeScore < 0.02) reasons.push(`${candidate.volume}/mo is too thin to earn a page`)
	if (linkScore < 1) reasons.push(`only ${linkSurface} internal pages can link here`)
	if (candidate.freshnessNeed) reasons.push("regulatory content — freshness compounds")
	if (intent === "transactional" || intent === "commercial") reasons.push(`${intent} intent carries lead value`)
	reasons.push(`score ${score} (${bandFor(score)})`)

	return { keyword: candidate.keyword, cluster: candidate.cluster, volume: candidate.volume, score, band: bandFor(score), reasons }
}

/**
 * Pick this week's topic and record the decision.
 *
 * The event is emitted here rather than at the call site so every pick is
 * traceable in PostHog with the numbers that produced it: `seo_keyword_chosen`
 * carries keyword, volume and score, and the article events that follow join on
 * `slug`. A pick with no event is a pick nobody can audit.
 */
export function chooseTopic(
	candidates: TopicCandidate[],
	options: { maxVolume?: number; minScore?: number; orgId?: string; distinctId?: string } = {},
): TopicDecision | null {
	const limit = options.minScore ?? ACTION_BAND.doNow
	const scored = candidates.map((c) => scoreTopic(c, options)).sort((a, b) => b.score - a.score)
	const best = scored[0] ?? null
	if (!best || best.score < limit) return null
	captureSeoEvent("keyword_chosen", {
		distinctId: options.distinctId ?? options.orgId ?? "arxivolt",
		orgId: options.orgId,
		keyword: best.keyword,
		volume: best.volume,
		cluster: best.cluster,
		score: best.score,
	})
	return best
}

