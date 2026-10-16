/**
 * Teammate feedback reactions on delivered answers.
 *
 * One durable row per (channel, message, reactor). 👍/👎 are quality signals
 * tied to the answer's trace id; ❓ is an expand request that starts a real
 * follow-up turn. The row doubles as the dedupe gate: an answer expands at
 * most once per person until the reaction is removed, so re-reacting re-arms
 * it. Storage failures are swallowed — feedback must never break event
 * handling, only lose a signal.
 */
import type { CompanyBrainAgent } from "../turn/agent"

export const BRAIN_FEEDBACK_REACTION_EMOJI = {
	positive: "thumbsup",
	negative: "thumbsdown",
	expand: "question",
} as const

export type BrainAnswerFeedbackKind = keyof typeof BRAIN_FEEDBACK_REACTION_EMOJI

export function feedbackKindForReaction(
	reaction: string | undefined,
): BrainAnswerFeedbackKind | undefined {
	switch (reaction) {
		case BRAIN_FEEDBACK_REACTION_EMOJI.positive:
			return "positive"
		case BRAIN_FEEDBACK_REACTION_EMOJI.negative:
			return "negative"
		case BRAIN_FEEDBACK_REACTION_EMOJI.expand:
			return "expand"
		default:
			return undefined
	}
}

/**
 * Synthetic ask sent when someone reacts ❓. The thread already carries the
 * original question and the answer being expanded, so the nudge only needs to
 * request depth — it is attributed to the reactor as the asker.
 */
export const BRAIN_EXPAND_REQUEST_TEXT =
	"Can you expand on your last answer? Go deeper — the specifics, steps, and examples that would make it most useful."

export type BrainAnswerFeedback = {
	channel: string
	messageTs: string
	reactorUser: string
	reaction: string
	kind: BrainAnswerFeedbackKind
	traceId: string
	threadTs?: string
	createdAt: number
}

export function ensureAnswerFeedbackTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_answer_feedback (
			channel TEXT NOT NULL,
			message_ts TEXT NOT NULL,
			reactor_user TEXT NOT NULL,
			reaction TEXT NOT NULL,
			kind TEXT NOT NULL,
			trace_id TEXT NOT NULL,
			thread_ts TEXT,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (channel, message_ts, reactor_user)
		)
	`
}

/** Upserts the reactor's current vote; a newer reaction replaces the old one. */
export function recordAnswerFeedback(
	agent: CompanyBrainAgent,
	input: BrainAnswerFeedback,
): BrainAnswerFeedback | null {
	try {
		ensureAnswerFeedbackTable(agent)
		agent.sql`
			INSERT INTO brain_answer_feedback (
				channel, message_ts, reactor_user, reaction, kind, trace_id,
				thread_ts, created_at
			) VALUES (
				${input.channel}, ${input.messageTs}, ${input.reactorUser},
				${input.reaction}, ${input.kind}, ${input.traceId},
				${input.threadTs ?? null}, ${input.createdAt}
			)
			ON CONFLICT(channel, message_ts, reactor_user) DO UPDATE SET
				reaction = ${input.reaction},
				kind = ${input.kind},
				trace_id = ${input.traceId},
				thread_ts = ${input.threadTs ?? null},
				created_at = ${input.createdAt}
		`
		return input
	} catch (error) {
		console.warn(
			`[company-brain] answer feedback write failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return null
	}
}

/**
 * Removes the reactor's vote. Only retracts when the removed emoji is the one
 * actually stored, so removing a stale reaction cannot erase a newer vote.
 */
export function retractAnswerFeedback(
	agent: CompanyBrainAgent,
	args: {
		channel: string
		messageTs: string
		reactorUser: string
		reaction: string
	},
): boolean {
	try {
		ensureAnswerFeedbackTable(agent)
		const rows = agent.sql<{ reaction: string }>`
			SELECT reaction FROM brain_answer_feedback
			WHERE channel = ${args.channel}
				AND message_ts = ${args.messageTs}
				AND reactor_user = ${args.reactorUser}
		`
		if (rows[0]?.reaction !== args.reaction) return false
		agent.sql`
			DELETE FROM brain_answer_feedback
			WHERE channel = ${args.channel}
				AND message_ts = ${args.messageTs}
				AND reactor_user = ${args.reactorUser}
		`
		return true
	} catch (error) {
		console.warn(
			`[company-brain] answer feedback retract failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return false
	}
}

export function getAnswerFeedback(
	agent: CompanyBrainAgent,
	args: { channel: string; messageTs: string; reactorUser: string },
): BrainAnswerFeedback | undefined {
	try {
		ensureAnswerFeedbackTable(agent)
		const rows = agent.sql<{
			channel: string
			message_ts: string
			reactor_user: string
			reaction: string
			kind: string
			trace_id: string
			thread_ts: string | null
			created_at: number
		}>`
			SELECT channel, message_ts, reactor_user, reaction, kind, trace_id,
				thread_ts, created_at
			FROM brain_answer_feedback
			WHERE channel = ${args.channel}
				AND message_ts = ${args.messageTs}
				AND reactor_user = ${args.reactorUser}
		`
		const row = rows[0]
		if (!row) return undefined
		return {
			channel: row.channel,
			messageTs: row.message_ts,
			reactorUser: row.reactor_user,
			reaction: row.reaction,
			kind: row.kind as BrainAnswerFeedbackKind,
			traceId: row.trace_id,
			threadTs: row.thread_ts ?? undefined,
			createdAt: row.created_at,
		}
	} catch (error) {
		console.warn(
			`[company-brain] answer feedback read failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return undefined
	}
}

/**
 * Expansions are one-shot per answer per person: a first ❓ on an answer (or
 * after a removed one clears the row) starts the turn; re-adding ❓ over an
 * existing expand vote does nothing.
 */
export function shouldStartAnswerExpansion(args: {
	action: "added" | "removed"
	kind: BrainAnswerFeedbackKind
	prior?: BrainAnswerFeedback | null
}): boolean {
	return (
		args.action === "added" &&
		args.kind === "expand" &&
		args.prior?.kind !== "expand"
	)
}
