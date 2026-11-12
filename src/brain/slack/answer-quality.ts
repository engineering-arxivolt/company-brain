import type { CompanyBrainAgent } from "../turn/agent"

/**
 * What the team thought of the answers, and what the brain does about it.
 *
 * 👍/👎 reactions were already durable per answer (`brain_answer_feedback`), and
 * the decision log already knows which route, model and playbook produced that
 * answer — they share a `trace_id`. Nothing joined them, so the votes were a
 * dashboard nobody opened: the same playbook could keep being preloaded while
 * people kept down-voting what it wrote.
 *
 * This module joins them (in the DO's own SQL, so it costs one query), folds the
 * votes into a score per route/model/playbook, and exposes the one judgement
 * that is allowed to change behaviour: a playbook with enough votes and a
 * clearly negative score stops being preloaded.
 *
 * Thresholds are deliberately blunt and few. A quality signal that silently
 * matters is worse than none.
 */
export const FEEDBACK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
/** Below this many votes, a score is noise. */
export const MIN_FEEDBACK_SAMPLES = 3
/** At or below this, a playbook is doing more harm than good. */
export const SUPPRESS_AT_SCORE = -0.5

export type VoteTally = { positive: number; negative: number }

export type QualityScore = VoteTally & {
	key: string
	samples: number
	/** (positive - negative) / samples, or null with no votes. */
	score: number | null
}

/** Fold raw votes into per-key tallies. */
export function tallyVotes(
	rows: ReadonlyArray<{ key: string; kind: string }>,
): Map<string, VoteTally> {
	const tallies = new Map<string, VoteTally>()
	for (const row of rows) {
		if (row.kind !== "positive" && row.kind !== "negative") continue
		const tally = tallies.get(row.key) ?? { positive: 0, negative: 0 }
		if (row.kind === "positive") tally.positive += 1
		else tally.negative += 1
		tallies.set(row.key, tally)
	}
	return tallies
}

/** -1 (all down) … 1 (all up); null when nobody voted. */
export function scoreFromTally(tally: VoteTally): number | null {
	const samples = tally.positive + tally.negative
	if (!samples) return null
	return (tally.positive - tally.negative) / samples
}

export function qualityScores(
	rows: ReadonlyArray<{ key: string; kind: string }>,
): QualityScore[] {
	return [...tallyVotes(rows)].map(([key, tally]) => {
		const samples = tally.positive + tally.negative
		return {
			key,
			positive: tally.positive,
			negative: tally.negative,
			samples,
			score: scoreFromTally(tally),
		}
	})
}

/** Enough evidence, and it is all going the wrong way. */
export function shouldSuppress(score: QualityScore | undefined): boolean {
	if (!score || score.score === null) return false
	return score.samples >= MIN_FEEDBACK_SAMPLES && score.score <= SUPPRESS_AT_SCORE
}

/** One row of the join: a vote, and what the turn did to earn it. */
export type QualityRow = {
	kind: string
	decisionKind: string
	choice: string
}

/**
 * Read the org's recent votes, attributed to the choice that produced them.
 *
 * One SQL statement: the feedback table and the decision log are both in this
 * Durable Object, and the join key (`trace_id`) is the one thing they share.
 * Never throws — a quality read that breaks a turn is worse than a missing
 * signal.
 */
export function readQualityRows(
	agent: CompanyBrainAgent,
	options: { sinceMs?: number } = {},
): QualityRow[] {
	const since = Date.now() - (options.sinceMs ?? FEEDBACK_LOOKBACK_MS)
	try {
		const rows = agent.sql<{
			kind: string
			decision_kind: string
			choice: string
		}>`
			SELECT f.kind AS kind, d.kind AS decision_kind, d.choice AS choice
			FROM brain_answer_feedback f
			JOIN brain_decision_log d ON d.trace_id = f.trace_id
			WHERE f.kind IN ('positive', 'negative')
				AND f.created_at >= ${since}
				AND d.kind IN ('turn_route', 'model_selection', 'skill_selection')
		`
		return rows.map((row) => ({
			kind: row.kind,
			decisionKind: row.decision_kind,
			choice: row.choice,
		}))
	} catch (error) {
		console.warn(
			`[company-brain] quality read failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
	}
}

export type AnswerQuality = {
	routes: QualityScore[]
	models: QualityScore[]
	skills: QualityScore[]
}

const KEY_FOR_DECISION: Record<string, keyof AnswerQuality> = {
	turn_route: "routes",
	model_selection: "models",
	skill_selection: "skills",
}

/** Votes per route, model and playbook, over the lookback window. */
export function answerQuality(
	agent: CompanyBrainAgent,
	options: { sinceMs?: number } = {},
): AnswerQuality {
	const rows = readQualityRows(agent, options)
	const buckets: AnswerQuality = { routes: [], models: [], skills: [] }
	for (const key of Object.keys(KEY_FOR_DECISION) as string[]) {
		const bucket = KEY_FOR_DECISION[key]
		if (!bucket) continue
		const rowsForKind = rows
			.filter((row) => row.decisionKind === key)
			.map((row) => ({ key: row.choice, kind: row.kind }))
		if (!rowsForKind.length) continue
		buckets[bucket] = qualityScores(rowsForKind).sort(
			(a, b) => b.samples - a.samples,
		)
	}
	return buckets
}

/** The score for one playbook key, as the resolver sees it. */
export function skillQuality(
	agent: CompanyBrainAgent,
	choice: string,
): QualityScore | undefined {
	const rows = readQualityRows(agent)
		.filter((row) => row.decisionKind === "skill_selection" && row.choice === choice)
		.map((row) => ({ key: row.choice, kind: row.kind }))
	return qualityScores(rows)[0]
}
