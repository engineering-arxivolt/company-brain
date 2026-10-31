import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CompanyBrainAgent } from "./agent"
import type { PausedTurn } from "./pause"

const mocks = vi.hoisted(() => ({
	armLongJob: vi.fn(),
	findLatestLongJob: vi.fn(),
	markLongJobStatus: vi.fn(),
	setLongJobStatusTs: vi.fn(),
	markPausedTurnTerminal: vi.fn(),
	longJobStatusText: vi.fn(
		(_asker: string, step: number, max: number) => `step ${step} of ${max}`,
	),
	postPausedTurnCard: vi.fn(),
	postLongJobCard: vi.fn(),
	updateLongJobCard: vi.fn(),
	markLongJobCardFinished: vi.fn(),
}))

vi.mock("./long-job", () => ({
	armLongJob: mocks.armLongJob,
	findLatestLongJob: mocks.findLatestLongJob,
	markLongJobStatus: mocks.markLongJobStatus,
	setLongJobStatusTs: mocks.setLongJobStatusTs,
}))

vi.mock("./pause", () => ({
	markPausedTurnTerminal: mocks.markPausedTurnTerminal,
}))

vi.mock("../slack/client", () => ({
	longJobStatusText: mocks.longJobStatusText,
	markLongJobCardFinished: mocks.markLongJobCardFinished,
	postLongJobCard: mocks.postLongJobCard,
	postPausedTurnCard: mocks.postPausedTurnCard,
	updateLongJobCard: mocks.updateLongJobCard,
}))

import { finishLongJobCard, postPauseStatus } from "./pause-card"

const AGENT = {} as CompanyBrainAgent

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

const JOB = {
	jobId: "j1",
	orgId: "O-1",
	teamId: "T-1",
	channel: "C-1",
	threadTs: "1.000",
	threadKey: "T-1:C-1:1.000",
	turnId: "turn_1",
	askerUser: "U-1",
	question: "fix the failing test",
	status: "running" as const,
	autoContinues: 2,
	maxAutoContinues: 5,
	deadline: Date.now() + 60_000,
	lastPauseId: "p1",
	statusTs: null as string | null,
	scheduleId: "s1",
	createdAt: 1,
	updatedAt: 1,
}

const args = {
	agent: AGENT,
	botToken: "xoxb-test",
	paused: PAUSED,
	channel: "C-1",
	threadTs: "1.000",
	askerUser: "U-1",
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.postLongJobCard.mockResolvedValue("m1")
	mocks.updateLongJobCard.mockResolvedValue(true)
	mocks.markLongJobCardFinished.mockResolvedValue(true)
	mocks.findLatestLongJob.mockReturnValue(null)
})

describe("postPauseStatus with budget", () => {
	it("posts the status card and remembers its ts", async () => {
		mocks.armLongJob.mockResolvedValue({ mode: "auto", job: JOB })

		const result = await postPauseStatus(args)

		expect(result).toEqual({ auto: true, jobId: "j1" })
		expect(mocks.postLongJobCard).toHaveBeenCalledWith(
			"xoxb-test",
			"C-1",
			"1.000",
			"step 2 of 5",
			"j1",
		)
		expect(mocks.setLongJobStatusTs).toHaveBeenCalledWith(AGENT, "j1", "m1")
		expect(mocks.postPausedTurnCard).not.toHaveBeenCalled()
	})

	it("updates the existing card in place on the next chunk", async () => {
		mocks.armLongJob.mockResolvedValue({
			mode: "auto",
			job: { ...JOB, statusTs: "m0" },
		})

		await postPauseStatus(args)

		expect(mocks.updateLongJobCard).toHaveBeenCalledWith(
			"xoxb-test",
			"C-1",
			"m0",
			"step 2 of 5",
			"j1",
		)
		expect(mocks.postLongJobCard).not.toHaveBeenCalled()
	})

	it("posts a fresh card when the in-place update fails", async () => {
		mocks.updateLongJobCard.mockResolvedValue(false)
		mocks.armLongJob.mockResolvedValue({
			mode: "auto",
			job: { ...JOB, statusTs: "m0" },
		})

		await postPauseStatus(args)

		expect(mocks.postLongJobCard).toHaveBeenCalledTimes(1)
	})

	it("closes the card when the next chunk finished before the post landed", async () => {
		mocks.armLongJob.mockResolvedValue({ mode: "auto", job: JOB })
		mocks.findLatestLongJob.mockReturnValue({ ...JOB, status: "completed" })

		await postPauseStatus(args)

		expect(mocks.markLongJobCardFinished).toHaveBeenCalledWith(
			"xoxb-test",
			"C-1",
			"m1",
			"Background task finished — the answer is above.",
		)
	})

	it("still closes the job row when the card cannot be posted", async () => {
		mocks.postLongJobCard.mockResolvedValue(undefined)
		mocks.armLongJob.mockResolvedValue({ mode: "auto", job: JOB })

		const result = await postPauseStatus(args)

		expect(result).toEqual({ auto: true, jobId: "j1" })
		expect(mocks.setLongJobStatusTs).not.toHaveBeenCalled()
	})
})

describe("postPauseStatus without budget", () => {
	it("closes the status card and hands back a Continue card when exhausted", async () => {
		mocks.armLongJob.mockResolvedValue({
			mode: "manual",
			job: { ...JOB, status: "exhausted", statusTs: "m1" },
			reason: "exhausted",
		})

		const result = await postPauseStatus(args)

		expect(result).toEqual({ auto: false })
		expect(mocks.markLongJobCardFinished).toHaveBeenCalledWith(
			"xoxb-test",
			"C-1",
			"m1",
			expect.stringContaining("background budget"),
		)
		expect(mocks.postPausedTurnCard).toHaveBeenCalledWith(
			"xoxb-test",
			"C-1",
			"1.000",
			"U-1",
			"p1",
		)
	})

	it("does not resurrect a stopped job with a Continue card", async () => {
		mocks.armLongJob.mockResolvedValue({
			mode: "manual",
			job: { ...JOB, status: "cancelled", statusTs: "m1" },
			reason: "cancelled",
		})

		const result = await postPauseStatus(args)

		expect(result).toEqual({ auto: false })
		expect(mocks.markPausedTurnTerminal).toHaveBeenCalledWith(
			AGENT,
			"p1",
			"cancelled",
		)
		expect(mocks.markLongJobCardFinished).toHaveBeenCalledWith(
			"xoxb-test",
			"C-1",
			"m1",
			expect.stringContaining("stopped"),
		)
		expect(mocks.postPausedTurnCard).not.toHaveBeenCalled()
	})

	it("falls back to the Continue card when arming throws", async () => {
		mocks.armLongJob.mockRejectedValue(new Error("boom"))

		const result = await postPauseStatus(args)

		expect(result).toEqual({ auto: false })
		expect(mocks.postPausedTurnCard).toHaveBeenCalledTimes(1)
	})
})

describe("finishLongJobCard", () => {
	it("marks a running job complete and closes its card", async () => {
		mocks.findLatestLongJob.mockReturnValue({ ...JOB, statusTs: "m1" })

		await finishLongJobCard({
			agent: AGENT,
			threadKey: JOB.threadKey,
			botToken: "xoxb-test",
			channel: "C-1",
		})

		expect(mocks.markLongJobStatus).toHaveBeenCalledWith(AGENT, "j1", "completed")
		expect(mocks.markLongJobCardFinished).toHaveBeenCalledWith(
			"xoxb-test",
			"C-1",
			"m1",
			"Background task finished — the answer is above.",
		)
	})

	it("closes the row even when there is no card to update", async () => {
		mocks.findLatestLongJob.mockReturnValue(JOB)

		await finishLongJobCard({
			agent: AGENT,
			threadKey: JOB.threadKey,
			botToken: "xoxb-test",
			channel: "C-1",
			failed: true,
		})

		expect(mocks.markLongJobStatus).toHaveBeenCalledWith(AGENT, "j1", "error")
		expect(mocks.markLongJobCardFinished).not.toHaveBeenCalled()
	})

	it("leaves a stopped job alone", async () => {
		mocks.findLatestLongJob.mockReturnValue({ ...JOB, status: "cancelled" })

		await finishLongJobCard({
			agent: AGENT,
			threadKey: JOB.threadKey,
			botToken: "xoxb-test",
			channel: "C-1",
		})

		expect(mocks.markLongJobStatus).not.toHaveBeenCalled()
	})
})
