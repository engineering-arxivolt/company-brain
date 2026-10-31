import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "./agent"
import {
	armLongJob,
	cancelLongJob,
	cancelPendingApprovalsForJob,
	ensureLongJobTables,
	LONG_JOB_MAX_AUTO_CONTINUES,
	LONG_JOB_RESUME_DELAY_SECONDS,
	longJobBudgetExhausted,
	longJobIsExpired,
	reconcileLongJobs,
	type LongJob,
} from "./long-job"
import type { PausedTurn } from "./pause"

type SqlRun = { text: string; values: unknown[] }
type ScheduleCall = { delay: number; callback: string; payload: unknown }

const JOB_ROW = {
	job_id: "j1",
	org_id: "O-1",
	team_id: "T-1",
	channel: "C-1",
	thread_ts: "1.000",
	thread_key: "T-1:C-1:1.000",
	turn_id: "turn_1",
	asker_user: "U-1",
	question: "fix the failing test",
	status: "running",
	auto_continues: 1,
	max_auto_continues: LONG_JOB_MAX_AUTO_CONTINUES,
	deadline: Date.now() + 60_000,
	last_pause_id: "p1",
	status_ts: null,
	schedule_id: null,
	created_at: 1,
	updated_at: 1,
}

function fakeAgent(
	answer: (run: SqlRun) => unknown[] = () => [],
): {
	agent: CompanyBrainAgent
	runs: SqlRun[]
	schedules: ScheduleCall[]
	cancelledSchedules: string[]
} {
	const runs: SqlRun[] = []
	const schedules: ScheduleCall[] = []
	const cancelledSchedules: string[] = []
	const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
		const run = { text: strings.join("?"), values }
		runs.push(run)
		return answer(run)
	}
	const agent = {
		sql,
		schedule: async (delay: number, callback: string, payload: unknown) => {
			schedules.push({ delay, callback, payload })
			return { id: `s${schedules.length}` }
		},
		cancelSchedule: async (id: string) => {
			cancelledSchedules.push(id)
			return true
		},
	} as unknown as CompanyBrainAgent
	return { agent, runs, schedules, cancelledSchedules }
}

const PAUSED: PausedTurn = {
	pauseId: "p1",
	orgId: "O-1",
	teamId: "T-1",
	channel: "C-1",
	threadTs: "1.000",
	threadKey: "T-1:C-1:1.000",
	turnId: "turn_1",
	askerUser: "U-1",
	question: "fix the failing test",
	stateJson: "{}",
	status: "paused",
	createdAt: 1,
	expiresAt: Date.now() + 60_000,
}

describe("ensureLongJobTables", () => {
	it("creates the table and its thread index", () => {
		const { agent, runs } = fakeAgent()
		ensureLongJobTables(agent)
		expect(runs.some((run) => run.text.includes("CREATE TABLE IF NOT EXISTS brain_long_job"))).toBe(true)
		expect(runs.some((run) => run.text.includes("brain_long_job_thread_idx"))).toBe(true)
	})
})

describe("armLongJob", () => {
	it("creates a job and schedules the first background chunk", async () => {
		const { agent, runs, schedules } = fakeAgent((run) =>
			run.text.includes("RETURNING *") ? [JOB_ROW] : [],
		)

		const result = await armLongJob({ agent, paused: PAUSED, now: 10 })

		expect(result.mode).toBe("auto")
		if (result.mode !== "auto") return
		expect(result.job.jobId).toBe("j1")
		expect(schedules).toHaveLength(1)
		expect(schedules[0]).toMatchObject({
			delay: LONG_JOB_RESUME_DELAY_SECONDS,
			callback: "runTurnAutoContinue",
			payload: { jobId: "j1", pauseId: "p1" },
		})
		expect(runs.some((run) => run.text.includes("INSERT INTO brain_long_job"))).toBe(true)
		expect(runs.some((run) => run.text.includes("SET auto_continues = auto_continues + 1"))).toBe(true)
	})

	it("leaves a cancelled job manual instead of starting a new budget", async () => {
		const { agent, schedules } = fakeAgent((run) => {
			if (run.text.includes("SELECT * FROM brain_long_job")) {
				return [{ ...JOB_ROW, status: "cancelled" }]
			}
			return []
		})

		const result = await armLongJob({ agent, paused: PAUSED, now: 10 })

		expect(result.mode).toBe("manual")
		if (result.mode === "manual") expect(result.reason).toBe("cancelled")
		expect(schedules).toHaveLength(0)
	})

	it("exhausts a job that has spent its continuations", async () => {
		const { agent, schedules } = fakeAgent((run) => {
			if (run.text.includes("SELECT * FROM brain_long_job")) {
				return [{ ...JOB_ROW, auto_continues: LONG_JOB_MAX_AUTO_CONTINUES }]
			}
			return []
		})

		const result = await armLongJob({ agent, paused: PAUSED, now: 10 })

		expect(result.mode).toBe("manual")
		if (result.mode === "manual") expect(result.reason).toBe("exhausted")
		expect(schedules).toHaveLength(0)
	})
})

describe("budget helpers", () => {
	it("treats the deadline as inclusive and only for a running job", () => {
		const job = { deadline: 1_000, status: "running" } as Pick<LongJob, "deadline" | "status">
		expect(longJobIsExpired(job, 1_000)).toBe(true)
		expect(longJobIsExpired(job, 999)).toBe(false)
		expect(longJobIsExpired({ ...job, status: "completed" }, 2_000)).toBe(false)
	})

	it("knows when the continuation budget is spent", () => {
		expect(
			longJobBudgetExhausted({
				autoContinues: LONG_JOB_MAX_AUTO_CONTINUES - 1,
				maxAutoContinues: LONG_JOB_MAX_AUTO_CONTINUES,
			}),
		).toBe(false)
		expect(
			longJobBudgetExhausted({
				autoContinues: LONG_JOB_MAX_AUTO_CONTINUES,
				maxAutoContinues: LONG_JOB_MAX_AUTO_CONTINUES,
			}),
		).toBe(true)
	})
})

describe("cancelLongJob", () => {
	it("cancels the stored alarm and marks the row cancelled", async () => {
		const { agent, runs, cancelledSchedules } = fakeAgent((run) => {
			if (run.text.includes("SELECT * FROM brain_long_job WHERE job_id")) {
				return [{ ...JOB_ROW, schedule_id: "s9" }]
			}
			return []
		})

		const job = await cancelLongJob(agent, "j1", 50)

		expect(job?.status).toBe("cancelled")
		expect(cancelledSchedules).toEqual(["s9"])
		expect(runs.some((run) => run.text.includes("SET status = 'cancelled'"))).toBe(true)
	})
})

describe("cancelPendingApprovalsForJob", () => {
	it("cancels every pending approval on the job's thread", () => {
		const { agent, runs } = fakeAgent((run) => {
			if (run.text.includes("SELECT approval_id FROM brain_pending_approval")) {
				return [{ approval_id: "a1" }, { approval_id: "a2" }]
			}
			return []
		})

		expect(
			cancelPendingApprovalsForJob(agent, {
				teamId: "T-1",
				channel: "C-1",
				threadTs: "1.000",
			}),
		).toBe(2)
		const updates = runs.filter((run) =>
			run.text.includes("UPDATE brain_pending_approval"),
		)
		expect(updates).toHaveLength(2)
		expect(updates.every((run) => run.values.includes("cancelled"))).toBe(true)
	})
})

describe("reconcileLongJobs", () => {
	it("re-arms a running job whose pause is still pending", async () => {
		const { agent, schedules } = fakeAgent((run) => {
			if (run.text.includes("SELECT * FROM brain_long_job")) return [JOB_ROW]
			if (run.text.includes("SELECT status, expires_at FROM brain_paused_turn")) {
				return [{ status: "paused", expires_at: Date.now() + 60_000 }]
			}
			return []
		})

		expect(await reconcileLongJobs(agent)).toBe(1)
		expect(schedules).toHaveLength(1)
		expect(schedules[0]?.payload).toEqual({ jobId: "j1", pauseId: "p1" })
	})

	it("does not re-arm a job whose pause was already consumed", async () => {
		const { agent, runs, schedules } = fakeAgent((run) => {
			if (run.text.includes("SELECT * FROM brain_long_job")) return [JOB_ROW]
			if (run.text.includes("SELECT status, expires_at FROM brain_paused_turn")) {
				return [{ status: "resumed", expires_at: Date.now() + 60_000 }]
			}
			return []
		})

		expect(await reconcileLongJobs(agent)).toBe(0)
		expect(schedules).toHaveLength(0)
		expect(runs.some((run) => run.values.includes("expired"))).toBe(true)
	})

	it("expires a job whose pause is gone", async () => {
		const { agent, runs, schedules } = fakeAgent((run) => {
			if (run.text.includes("SELECT * FROM brain_long_job")) return [JOB_ROW]
			return []
		})

		expect(await reconcileLongJobs(agent)).toBe(0)
		expect(schedules).toHaveLength(0)
		expect(runs.some((run) => run.values.includes("expired"))).toBe(true)
	})
})
