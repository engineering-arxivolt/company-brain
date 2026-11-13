import type { CompanyBrainAgent } from "./agent"
import { turnCostSummary, type TurnCostTotals } from "./turn-cost"

/**
 * One call that answers "is anything stuck, and what are we spending?".
 *
 * Everything the brain persists lives in its own Durable Object SQL, which no
 * command-line tool can read — so production questions were being answered by
 * reading code and hoping. This assembles the same facts the DO sees: how many
 * turns are paused, which long jobs are still running or exhausted, whether
 * sandbox sessions are leaking, how much the decision log has recorded, what the
 * last dream did, and what the last day/week cost.
 *
 * Every read is individually guarded. An audit surface that fails as a whole
 * because one table is missing (a fresh deploy, an old org) tells you nothing.
 */
const DAY_MS = 24 * 60 * 60 * 1000

export type BrainAudit = {
	/** Paused turns by status — a "waiting" pile is a stalled job, not a queue. */
	pausedTurns: Record<string, number>
	longJobs: Record<string, number>
	sandboxSessions: number
	/** Sessions past their expiry that nobody removed — a leak, if it grows. */
	sandboxSessionsExpired: number
	/** Decisions recorded, by kind (turn_route, model_selection, dream, …). */
	decisions: Record<string, number>
	cost: { last24h: TurnCostTotals; last7d: TurnCostTotals }
	lastDream: { traceId: string; choice: string; reason: string | null; at: number } | null
	/** Flow/doodle jobs still waiting for the VPS render agent. */
	renderJobsQueued: number
	/** Heavy-build leases currently held, per key. */
	leasesHeld: string[]
}

function groupCounts(
	rows: ReadonlyArray<{ status?: string | null; kind?: string | null }>,
): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const row of rows) {
		const key = row.status ?? row.kind ?? "unknown"
		counts[key] = (counts[key] ?? 0) + 1
	}
	return counts
}

export async function auditBrain(
	agent: CompanyBrainAgent,
	options: { env: Env; now?: number },
): Promise<BrainAudit> {
	const now = options.now ?? Date.now()

	const count = (query: () => unknown): Record<string, number> => {
		try {
			return groupCounts(query() as Array<{ status?: string | null; kind?: string | null }>)
		} catch (error) {
			console.warn(
				"[company-brain] audit count failed:",
				error instanceof Error ? error.message : String(error),
			)
			return {}
		}
	}

	const pausedTurns = count(
		() => agent.sql<{ status: string }>`
			SELECT status FROM brain_paused_turn
		`,
	)
	const longJobs = count(
		() => agent.sql<{ status: string }>`
			SELECT status FROM brain_long_job
		`,
	)
	const decisions = count(
		() => agent.sql<{ kind: string }>`
			SELECT kind FROM brain_decision_log
		`,
	)

	let sandboxSessions = 0
	let sandboxSessionsExpired = 0
	try {
		const [live] = agent.sql<{ count: number }>`
			SELECT count(*) AS count FROM brain_sandbox_session WHERE expires_at > ${now}
		`
		sandboxSessions = live?.count ?? 0
		const [expired] = agent.sql<{ count: number }>`
			SELECT count(*) AS count FROM brain_sandbox_session WHERE expires_at <= ${now}
		`
		sandboxSessionsExpired = expired?.count ?? 0
	} catch {
		sandboxSessions = 0
		sandboxSessionsExpired = 0
	}

	let lastDream: BrainAudit["lastDream"] = null
	try {
		const [row] = agent.sql<{
			trace_id: string
			choice: string
			reason: string | null
			created_at: number
		}>`
			SELECT trace_id, choice, reason, created_at FROM brain_decision_log
			WHERE kind = 'dream'
			ORDER BY created_at DESC
			LIMIT 1
		`
		if (row) {
			lastDream = {
				traceId: row.trace_id,
				choice: row.choice,
				reason: row.reason,
				at: row.created_at,
			}
		}
	} catch {
		lastDream = null
	}

	// KV is where the render queue and the build leases actually live.
	const [renderKeys, leaseKeys] = await Promise.all([
		options.env.BRAIN_KV.list({ prefix: "render:job:" }).catch(() => ({ keys: [] })),
		options.env.BRAIN_KV.list({ prefix: "sandbox:lease:" }).catch(() => ({ keys: [] })),
	])

	return {
		pausedTurns,
		longJobs,
		sandboxSessions,
		sandboxSessionsExpired,
		decisions,
		cost: {
			last24h: turnCostSummary(agent, { sinceMs: DAY_MS, now }),
			last7d: turnCostSummary(agent, { sinceMs: 7 * DAY_MS, now }),
		},
		lastDream,
		renderJobsQueued: renderKeys.keys.length,
		leasesHeld: leaseKeys.keys.map((key) => key.name),
	}
}
