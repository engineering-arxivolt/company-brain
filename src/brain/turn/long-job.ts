/**
 * Durable long-running jobs.
 *
 * A Slack turn has a hard wall-clock budget. When it runs out mid-task the
 * turn pauses, hands the asker a Continue button, and waits. That is safe, but
 * it makes the person the scheduler: a task that needs three more minutes only
 * moves when someone clicks.
 *
 * A long job closes that gap. It is a durable row in the org's Durable Object
 * that remembers one requested piece of work across turn chunks, plus a
 * scheduled callback that resumes the paused envelope on its own. The person
 * gets one status card with a Stop button instead of a Continue button after
 * every chunk.
 *
 * The budget is deliberately finite: five automatic continuations inside one
 * hour. Past that the job is exhausted and the old Continue card comes back,
 * so the person opts in to spending more. Nothing here can loop forever.
 */
import { generateId } from "@repo/lib/generate-id"
import { markApprovalTerminal } from "./approval"
import type { CompanyBrainAgent } from "./agent"
import type { PausedTurn } from "./pause"

export const LONG_JOB_MAX_AUTO_CONTINUES = 5
export const LONG_JOB_TTL_MS = 60 * 60 * 1000
/** Let the pausing invocation finish writing before the alarm can resume it. */
export const LONG_JOB_RESUME_DELAY_SECONDS = 3

export type LongJobStatus =
	| "running"
	| "waiting_approval"
	| "completed"
	| "cancelled"
	| "exhausted"
	| "expired"
	| "error"

export type LongJob = {
	jobId: string
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	threadKey: string
	turnId: string
	askerUser: string
	question: string
	status: LongJobStatus
	autoContinues: number
	maxAutoContinues: number
	deadline: number
	lastPauseId: string | null
	statusTs: string | null
	scheduleId: string | null
	createdAt: number
	updatedAt: number
}

export type LongJobStepPayload = {
	jobId: string
	pauseId: string
}

export type LongJobStopPayload = {
	teamId: string
	jobId: string
	userId: string
	responseUrl?: string
}

type LongJobRow = {
	job_id: string
	org_id: string
	team_id: string
	channel: string
	thread_ts: string
	thread_key: string
	turn_id: string
	asker_user: string
	question: string
	status: LongJobStatus
	auto_continues: number
	max_auto_continues: number
	deadline: number
	last_pause_id: string | null
	status_ts: string | null
	schedule_id: string | null
	created_at: number
	updated_at: number
}

export function ensureLongJobTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_long_job (
			job_id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			thread_key TEXT NOT NULL,
			turn_id TEXT NOT NULL,
			asker_user TEXT NOT NULL,
			question TEXT NOT NULL,
			status TEXT NOT NULL,
			auto_continues INTEGER NOT NULL,
			max_auto_continues INTEGER NOT NULL,
			deadline INTEGER NOT NULL,
			last_pause_id TEXT,
			status_ts TEXT,
			schedule_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_long_job_thread_idx
		ON brain_long_job (thread_key, status, updated_at)
	`
}

function rowToLongJob(row: LongJobRow): LongJob {
	return {
		jobId: row.job_id,
		orgId: row.org_id,
		teamId: row.team_id,
		channel: row.channel,
		threadTs: row.thread_ts,
		threadKey: row.thread_key,
		turnId: row.turn_id,
		askerUser: row.asker_user,
		question: row.question,
		status: row.status,
		autoContinues: row.auto_continues,
		maxAutoContinues: row.max_auto_continues,
		deadline: row.deadline,
		lastPauseId: row.last_pause_id,
		statusTs: row.status_ts,
		scheduleId: row.schedule_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function loadLongJob(
	agent: CompanyBrainAgent,
	jobId: string,
): LongJob | null {
	const rows = agent.sql<LongJobRow>`
		SELECT * FROM brain_long_job WHERE job_id = ${jobId}
	`
	return rows[0] ? rowToLongJob(rows[0]) : null
}

export function findActiveLongJob(
	agent: CompanyBrainAgent,
	threadKey: string,
	now = Date.now(),
): LongJob | null {
	// A just-cancelled job has to keep blocking the next pause, or a Stop
	// during a running chunk would be undone by the pause that chunk produces.
	// Ten minutes is long enough to cover the chunk; a genuinely new task after
	// that gets a fresh budget.
	const rows = agent.sql<LongJobRow>`
		SELECT * FROM brain_long_job
		WHERE thread_key = ${threadKey}
			AND (
				status IN ('running', 'waiting_approval')
				OR (status = 'cancelled' AND updated_at > ${now - 10 * 60 * 1000})
			)
		ORDER BY updated_at DESC
		LIMIT 1
	`
	return rows[0] ? rowToLongJob(rows[0]) : null
}

export function findLatestLongJob(
	agent: CompanyBrainAgent,
	threadKey: string,
): LongJob | null {
	const rows = agent.sql<LongJobRow>`
		SELECT * FROM brain_long_job
		WHERE thread_key = ${threadKey}
		ORDER BY updated_at DESC
		LIMIT 1
	`
	return rows[0] ? rowToLongJob(rows[0]) : null
}

function insertLongJob(agent: CompanyBrainAgent, paused: PausedTurn, now: number): LongJob {
	const job: LongJob = {
		jobId: generateId(),
		orgId: paused.orgId,
		teamId: paused.teamId,
		channel: paused.channel,
		threadTs: paused.threadTs,
		threadKey: paused.threadKey,
		turnId: paused.turnId,
		askerUser: paused.askerUser,
		question: paused.question,
		status: "running",
		autoContinues: 0,
		maxAutoContinues: LONG_JOB_MAX_AUTO_CONTINUES,
		deadline: now + LONG_JOB_TTL_MS,
		lastPauseId: paused.pauseId,
		statusTs: null,
		scheduleId: null,
		createdAt: now,
		updatedAt: now,
	}
	agent.sql`
		INSERT INTO brain_long_job (
			job_id, org_id, team_id, channel, thread_ts, thread_key, turn_id,
			asker_user, question, status, auto_continues, max_auto_continues,
			deadline, last_pause_id, status_ts, schedule_id, created_at, updated_at
		) VALUES (
			${job.jobId}, ${job.orgId}, ${job.teamId}, ${job.channel},
			${job.threadTs}, ${job.threadKey}, ${job.turnId}, ${job.askerUser},
			${job.question}, ${job.status}, ${job.autoContinues},
			${job.maxAutoContinues}, ${job.deadline}, ${job.lastPauseId},
			${job.statusTs}, ${job.scheduleId}, ${job.createdAt}, ${job.updatedAt}
		)
	`
	return job
}

export function markLongJobStatus(
	agent: CompanyBrainAgent,
	jobId: string,
	status: LongJobStatus,
	now = Date.now(),
): void {
	agent.sql`
		UPDATE brain_long_job
		SET status = ${status}, updated_at = ${now}
		WHERE job_id = ${jobId}
	`
}

export function setLongJobStatusTs(
	agent: CompanyBrainAgent,
	jobId: string,
	statusTs: string | null,
	now = Date.now(),
): void {
	agent.sql`
		UPDATE brain_long_job
		SET status_ts = ${statusTs}, updated_at = ${now}
		WHERE job_id = ${jobId}
	`
}

export function hasPendingApprovalForJob(
	agent: CompanyBrainAgent,
	job: Pick<LongJob, "teamId" | "channel" | "threadTs">,
): boolean {
	const rows = agent.sql<{ approval_id: string }>`
		SELECT approval_id FROM brain_pending_approval
		WHERE team_id = ${job.teamId}
			AND channel = ${job.channel}
			AND thread_ts = ${job.threadTs}
			AND status = 'pending'
		LIMIT 1
	`
	return rows.length > 0
}

/**
 * A stopped job must not wake up through an approval card. The buttons stay in
 * Slack, but clicking one finds a terminal row instead of resuming the turn.
 */
export function cancelPendingApprovalsForJob(
	agent: CompanyBrainAgent,
	job: Pick<LongJob, "teamId" | "channel" | "threadTs">,
): number {
	const rows = agent.sql<{ approval_id: string }>`
		SELECT approval_id FROM brain_pending_approval
		WHERE team_id = ${job.teamId}
			AND channel = ${job.channel}
			AND thread_ts = ${job.threadTs}
			AND status = 'pending'
	`
	for (const row of rows) markApprovalTerminal(agent, row.approval_id, "cancelled")
	return rows.length
}

export function longJobIsExpired(job: Pick<LongJob, "deadline" | "status">, now = Date.now()): boolean {
	return job.status === "running" && job.deadline <= now
}

export function longJobBudgetExhausted(
	job: Pick<LongJob, "autoContinues" | "maxAutoContinues">,
): boolean {
	return job.autoContinues >= job.maxAutoContinues
}

export type ArmLongJobResult =
	| { mode: "auto"; job: LongJob }
	| {
			mode: "manual"
			job: LongJob | null
			reason: "exhausted" | "expired" | "cancelled" | "schedule_failed"
	  }

/**
 * Decide what happens when a turn pauses, and arm the next chunk if the job
 * still has budget. Called after the pause row is written.
 */
export async function armLongJob(args: {
	agent: CompanyBrainAgent
	paused: PausedTurn
	now?: number
}): Promise<ArmLongJobResult> {
	const now = args.now ?? Date.now()
	ensureLongJobTables(args.agent)
	let job = findActiveLongJob(args.agent, args.paused.threadKey, now)
	if (!job) job = insertLongJob(args.agent, args.paused, now)

	if (job.status === "cancelled") {
		return { mode: "manual", job, reason: "cancelled" }
	}
	if (job.deadline <= now) {
		markLongJobStatus(args.agent, job.jobId, "expired", now)
		return { mode: "manual", job: { ...job, status: "expired" }, reason: "expired" }
	}
	if (longJobBudgetExhausted(job)) {
		markLongJobStatus(args.agent, job.jobId, "exhausted", now)
		return {
			mode: "manual",
			job: { ...job, status: "exhausted" },
			reason: "exhausted",
		}
	}

	// One statement claims the next slot. Two alarm paths racing on the same
	// paused turn cannot both spend a continuation.
	const rows = args.agent.sql<LongJobRow>`
		UPDATE brain_long_job
		SET auto_continues = auto_continues + 1,
			last_pause_id = ${args.paused.pauseId},
			turn_id = ${args.paused.turnId},
			status = 'running',
			updated_at = ${now}
		WHERE job_id = ${job.jobId}
			AND status IN ('running', 'waiting_approval')
			AND auto_continues < max_auto_continues
			AND deadline > ${now}
		RETURNING *
	`
	if (!rows[0]) {
		markLongJobStatus(args.agent, job.jobId, "exhausted", now)
		return {
			mode: "manual",
			job: { ...job, status: "exhausted" },
			reason: "exhausted",
		}
	}
	const armed = rowToLongJob(rows[0])
	try {
		const scheduled = await args.agent.schedule(
			LONG_JOB_RESUME_DELAY_SECONDS,
			"runTurnAutoContinue",
			{ jobId: armed.jobId, pauseId: args.paused.pauseId } satisfies LongJobStepPayload,
		)
		args.agent.sql`
			UPDATE brain_long_job
			SET schedule_id = ${scheduled.id}, updated_at = ${now}
			WHERE job_id = ${armed.jobId}
		`
		return { mode: "auto", job: { ...armed, scheduleId: scheduled.id } }
	} catch (error) {
		console.error(
			`[company-brain] long job ${armed.jobId} could not arm its next step:`,
			error,
		)
		markLongJobStatus(args.agent, armed.jobId, "error", now)
		return { mode: "manual", job: { ...armed, status: "error" }, reason: "schedule_failed" }
	}
}

export async function cancelLongJob(
	agent: CompanyBrainAgent,
	jobId: string,
	now = Date.now(),
): Promise<LongJob | null> {
	const job = loadLongJob(agent, jobId)
	if (!job) return null
	agent.sql`
		UPDATE brain_long_job
		SET status = 'cancelled', updated_at = ${now}
		WHERE job_id = ${jobId}
	`
	if (job.scheduleId) {
		await agent.cancelSchedule(job.scheduleId).catch(() => false)
	}
	return { ...job, status: "cancelled", updatedAt: now }
}

/**
 * Re-arm a job whose alarm was lost to an eviction or deploy. Duplicate alarms
 * are safe: consuming a paused turn is one-shot, so the second one no-ops.
 */
export async function reconcileLongJobs(agent: CompanyBrainAgent): Promise<number> {
	const rows = agent.sql<LongJobRow>`
		SELECT * FROM brain_long_job
		WHERE status = 'running'
			AND deadline > ${Date.now()}
		ORDER BY updated_at ASC
		LIMIT 20
	`
	let rearmed = 0
	for (const row of rows) {
		const job = rowToLongJob(row)
		const pauseId = job.lastPauseId
		if (!pauseId) {
			markLongJobStatus(agent, job.jobId, "expired")
			continue
		}
		const pause = agent.sql<{ status: string; expires_at: number }>`
			SELECT status, expires_at FROM brain_paused_turn WHERE pause_id = ${pauseId}
		`
		const paused = pause[0]
		if (!paused || paused.status !== "paused" || paused.expires_at <= Date.now()) {
			// A consumed or expired envelope cannot be replayed. The chunk that
			// consumed it died with the eviction that stranded this row, so the
			// job is over rather than merely waiting.
			markLongJobStatus(agent, job.jobId, "expired")
			continue
		}
		try {
			await agent.schedule(
				LONG_JOB_RESUME_DELAY_SECONDS,
				"runTurnAutoContinue",
				{ jobId: job.jobId, pauseId } satisfies LongJobStepPayload,
			)
			rearmed++
		} catch (error) {
			console.warn(
				`[company-brain] long job ${job.jobId} reconcile could not arm:`,
				error,
			)
		}
	}
	return rearmed
}
