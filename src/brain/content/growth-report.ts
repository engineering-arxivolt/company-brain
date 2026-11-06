/**
 * This week's growth report: the five things worth doing, with the numbers that
 * justify each one.
 *
 * The point of a report is not to show metrics, it is to end the argument about
 * what to do next. So this module does the ranking, caps the list at what a
 * person can actually review, and attaches the reason string from the decision
 * model to every row. Rule-based actions (refresh, merge, fix the CTA) are
 * always listed because the rule is the justification — the score only decides
 * the order. New-topic ideas do have to clear the queue band: writing a page is
 * the expensive move, so a weak one must not compete for attention.
 */
import { type ActionBand, type PageRow, type TopicCandidate, bandFor, scorePage, scoreTopic } from "./growth"

export type GrowthActionKind = "refresh" | "merge_redirect" | "cta_fix" | "new_article"

export type GrowthAction = {
	kind: GrowthActionKind
	/** Slug for a page action, keyword for a new article. */
	target: string
	score: number
	band: ActionBand
	reasons: string[]
}

export type GrowthReportInput = {
	pages?: PageRow[]
	topics?: TopicCandidate[]
	maxActions?: number
	/** Include `leave`/ignored rows for debugging; never for the operator view. */
	includeIgnored?: boolean
}

export type GrowthReport = {
	actions: GrowthAction[]
	considered: number
	ignored: number
	/** True when nothing cleared the queue band — a legitimate result. */
	quiet: boolean
}

const PAGE_KINDS: Record<string, GrowthActionKind | null> = {
	refresh: "refresh",
	merge_redirect: "merge_redirect",
	cta_fix: "cta_fix",
	leave: null,
}

export function buildGrowthReport(input: GrowthReportInput): GrowthReport {
	const actions: GrowthAction[] = []
	let considered = 0
	let ignored = 0

	for (const page of input.pages ?? []) {
		considered++
		const decision = scorePage(page)
		const kind = PAGE_KINDS[decision.action] ?? null
		// A rule-based action (refresh, merge, fix the CTA) is its own
		// justification; the score only ranks it against the others. Gating it on
		// the score band would drop the page that most obviously needs work.
		const keep = kind && (input.includeIgnored || decision.action !== "leave" || decision.band !== "ignore")
		if (!keep || !kind) {
			ignored++
			continue
		}
		actions.push({ kind, target: decision.slug, score: decision.score, band: decision.band, reasons: decision.reasons })
	}

	for (const topic of input.topics ?? []) {
		considered++
		const decision = scoreTopic(topic)
		if (!input.includeIgnored && decision.band === "ignore") {
			ignored++
			continue
		}
		actions.push({ kind: "new_article", target: decision.keyword, score: decision.score, band: decision.band, reasons: decision.reasons })
	}

	const ranked = actions.sort((a, b) => b.score - a.score || a.target.localeCompare(b.target))

	const capped = ranked.slice(0, Math.max(1, input.maxActions ?? 5))
	return { actions: capped, considered, ignored, quiet: capped.length === 0 }
}

/** Slack/plain-text rendering; one line per action, score first. */
export function renderGrowthReport(report: GrowthReport): string {
	if (report.quiet) {
		return `No action clears the threshold this week (${report.considered} pages and topics scored, ${report.ignored} ignored). Publishing cadence is not the lever right now.`
	}
	const lines = report.actions.map((action, i) => {
		const band = action.band === "do_now" ? "DO NOW" : action.band === "queue" ? "QUEUE" : "LOW"
		return `${i + 1}. [${band} ${action.score}] ${action.kind.replace(/_/g, " ")} → ${action.target}\n   ${action.reasons.join("; ")}`
	})
	return lines.join("\n")
}

/** Convenience for callers that only want the band of a score. */
export { bandFor }
