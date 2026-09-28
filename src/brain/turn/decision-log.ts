import { createHash } from "node:crypto"
import { captureBrainDecision } from "../observability"
import type { CompanyBrainAgent } from "./agent"

export const DECISION_KINDS = [
	"model_selection",
	"skill_selection",
	"mcp_effect",
] as const

const MAX_REPLAY_ROWS = 200

export type DecisionKind = (typeof DECISION_KINDS)[number]

export type DecisionInput = {
	traceId: string
	orgId: string
	kind: DecisionKind
	/** What the decision was about, e.g. `linear:delete_issue`. */
	subject: string
	choice: string
	reason?: string
	confidence?: number
	/** Full distribution when the decider reported one. */
	alternatives?: Record<string, number>
	/** How the decision was reached, e.g. `jev`, `verb_map`, `llm`. */
	source: string
	actor?: string
	/** Decision this one replaces, if any. */
	supersedes?: string
	sessionId?: string
	distinctId?: string
}

export type DecisionRow = {
	decision_id: string
	trace_id: string
	org_id: string
	kind: string
	subject: string
	choice: string
	reason: string | null
	confidence: number | null
	alternatives_json: string | null
	source: string
	actor: string | null
	supersedes: string | null
	created_at: number
}

export function ensureDecisionTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_decision_log (
			decision_id TEXT PRIMARY KEY,
			trace_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			subject TEXT NOT NULL,
			choice TEXT NOT NULL,
			reason TEXT,
			confidence REAL,
			alternatives_json TEXT,
			source TEXT NOT NULL,
			actor TEXT,
			supersedes TEXT,
			created_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_decision_log_trace
		ON brain_decision_log (trace_id)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_decision_log_org_recent
		ON brain_decision_log (org_id, created_at)
	`
}

/** Stable per-trace id so a retried turn cannot double-log the same decision. */
export function decisionIdFor(
	args: Pick<DecisionInput, "traceId" | "kind" | "subject" | "choice" | "source">,
): string {
	return createHash("sha256")
		.update(
			[args.traceId, args.kind, args.subject, args.choice, args.source].join("\u0000"),
		)
		.digest("hex")
		.slice(0, 32)
}

/**
 * The durable half of the verifiability invariant: a consequential decision gets
 * a row here in the customer's own storage, and the same entry goes to PostHog as
 * a span for replay. PostHog is best-effort and may drop events, so it is never
 * the only copy of a decision that gates an action.
 *
 * Returns the decision id, or null when the log was unreachable. Auditing must
 * never break the decision it records, so a write failure is reported, not thrown.
 */
export function recordDecision(
	agent: CompanyBrainAgent,
	args: DecisionInput,
	now = Date.now(),
): string | null {
	const decisionId = decisionIdFor(args)
	try {
		agent.sql`
			INSERT OR IGNORE INTO brain_decision_log (
				decision_id, trace_id, org_id, kind, subject, choice, reason,
				confidence, alternatives_json, source, actor, supersedes, created_at
			) VALUES (
				${decisionId},
				${args.traceId},
				${args.orgId},
				${args.kind},
				${args.subject},
				${args.choice},
				${args.reason ?? null},
				${args.confidence ?? null},
				${args.alternatives ? JSON.stringify(args.alternatives) : null},
				${args.source},
				${args.actor ?? null},
				${args.supersedes ?? null},
				${now}
			)
		`
		captureBrainDecision({ ...args, distinctId: args.distinctId ?? args.orgId })
		return decisionId
	} catch (error) {
		console.warn(
			`[company-brain][${args.traceId}] decision log write failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return null
	}
}

/** Everything decided during one scenario, oldest first — the audit replay. */
export function decisionsForTrace(
	agent: CompanyBrainAgent,
	traceId: string,
): DecisionRow[] {
	return agent.sql<DecisionRow>`
		SELECT * FROM brain_decision_log
		WHERE trace_id = ${traceId}
		ORDER BY created_at ASC
	`
}

export type DecisionView = {
	traceId: string
	kind: string
	subject: string
	choice: string
	reason: string | null
	confidence: number | null
	alternatives: Record<string, number> | null
	source: string
	actor: string | null
	supersedes: string | null
	createdAt: number
}

function toView(row: DecisionRow): DecisionView {
	let alternatives: Record<string, number> | null = null
	if (row.alternatives_json) {
		try {
			alternatives = JSON.parse(row.alternatives_json)
		} catch {
			alternatives = null
		}
	}
	return {
		traceId: row.trace_id,
		kind: row.kind,
		subject: row.subject,
		choice: row.choice,
		reason: row.reason,
		confidence: row.confidence,
		alternatives,
		source: row.source,
		actor: row.actor,
		supersedes: row.supersedes,
		createdAt: row.created_at,
	}
}

/**
 * The audit read. Pass a traceId to replay one scenario oldest-first, or omit it
 * for this org's most recent decisions. Never throws: an audit surface that can
 * fail the caller is worse than an empty one.
 */
export function getDecisions(
	agent: CompanyBrainAgent,
	args: { orgId: string; traceId?: string; limit?: number },
): DecisionView[] {
	const limit = Math.max(
		1,
		Math.min(args.limit ?? MAX_REPLAY_ROWS, MAX_REPLAY_ROWS),
	)
	try {
		const rows = args.traceId
			? decisionsForTrace(agent, args.traceId)
			: agent.sql<DecisionRow>`
				SELECT * FROM brain_decision_log
				WHERE org_id = ${args.orgId}
				ORDER BY created_at DESC
				LIMIT ${limit}
			`
		const views = rows.map(toView)
		return args.traceId ? views : views.reverse()
	} catch (error) {
		console.error(
			`[company-brain] decision replay failed org=${args.orgId} trace=${args.traceId ?? "-"}:`,
			error instanceof Error ? error.message : String(error),
		)
		return []
	}
}
