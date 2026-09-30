import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "./agent"
import type { ApprovalResumeState } from "./approval"
import {
	ensurePausedTurnTables,
	PAUSED_TURN_TTL_MS,
	loadPausedTurn,
	markPausedTurnResumed,
	markPausedTurnTerminal,
	pausedTurnIsExpired,
	persistPausedTurn,
} from "./pause"

type SqlRun = { text: string; values: unknown[] }

/** Minimal stand-in for the Durable Object's SQL surface. */
function fakeAgent(answer: (run: SqlRun) => unknown[] = () => []) {
	const runs: SqlRun[] = []
	const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
		const run = { text: strings.join("?"), values }
		runs.push(run)
		return answer(run)
	}
	return { agent: { sql } as unknown as CompanyBrainAgent, runs }
}

const ENVELOPE: ApprovalResumeState = {
	userId: "U-1",
	actor: { orgId: "O-1", userId: "U-1" },
	question: "why did the deploy fail",
	messages: [{ role: "user", content: "why did the deploy fail" }],
	approvalIds: [],
	turnState: {
		version: 1,
		nextNativeCallSequence: 0,
		request: { text: "why did the deploy fail", threadKey: "T:C:1" },
		budget: { steps: { limit: 24, used: 4 }, nativeCalls: { limit: 100, used: 0 } },
		apps: { connected: [], discovered: {} },
		nativeCalls: [],
		trajectory: [],
		warnings: [],
		surfacedUpdates: [],
	},
	assembly: {},
	turnControl: { threadKey: "T:C:1", turnId: "turn_1", revision: 3 },
} as unknown as ApprovalResumeState

describe("persistPausedTurn", () => {
	it("writes a paused row whose envelope round-trips", () => {
		const { agent, runs } = fakeAgent()
		const now = 1_700_000_000_000

		const paused = persistPausedTurn({
			agent,
			orgId: "O-1",
			teamId: "T-1",
			channel: "C-1",
			threadTs: "1700000000.000100",
			threadKey: "T:C:1",
			turnId: "turn_1",
			askerUser: "U-1",
			question: "why did the deploy fail",
			envelope: ENVELOPE,
			now,
		})

		expect(paused.status).toBe("paused")
		expect(paused.expiresAt).toBe(now + PAUSED_TURN_TTL_MS)
		expect(JSON.parse(paused.stateJson)).toEqual(ENVELOPE)
		const tables = runs.map((run) => run.text)
		expect(tables.some((text) => text.includes("CREATE TABLE IF NOT EXISTS brain_paused_turn"))).toBe(true)
		expect(tables.some((text) => text.includes("INSERT INTO brain_paused_turn"))).toBe(true)
	})

	it("does not require a table-ensure when the caller already did it", () => {
		const { agent, runs } = fakeAgent()
		ensurePausedTurnTables(agent)
		const ensured = runs.length
		ensurePausedTurnTables(agent)
		expect(runs.length).toBe(ensured * 2)
	})
})

describe("markPausedTurnResumed", () => {
	// One-shot: the Continue button must not be able to resume twice.
	it("is true only when the row was still paused", () => {
		const claimed = fakeAgent((run) =>
			run.text.includes("RETURNING pause_id") ? [{ pause_id: "p1" }] : [],
		)
		expect(markPausedTurnResumed(claimed.agent, "p1")).toBe(true)

		const alreadyResumed = fakeAgent(() => [])
		expect(markPausedTurnResumed(alreadyResumed.agent, "p1")).toBe(false)
	})

	it("targets only a still-paused row", () => {
		const { agent, runs } = fakeAgent(() => [{ pause_id: "p1" }])
		markPausedTurnResumed(agent, "p1")
		const update = runs.find((run) => run.text.includes("UPDATE brain_paused_turn"))
		expect(update?.text).toContain("status = ?")
		expect(update?.text).toContain("AND status = 'paused'")
	})
})

describe("pausedTurnIsExpired", () => {
	it("expires at the boundary, not before", () => {
		expect(pausedTurnIsExpired({ expiresAt: 1_000, status: "paused" }, 1_000)).toBe(true)
		expect(pausedTurnIsExpired({ expiresAt: 1_000, status: "paused" }, 999)).toBe(false)
		// A row already consumed is never expired-looking: it is gone from the
		// paused state entirely.
		expect(pausedTurnIsExpired({ expiresAt: 1_000, status: "resumed" }, 2_000)).toBe(false)
	})
})

describe("loadPausedTurn", () => {
	it("drops a row whose envelope cannot be parsed rather than resuming garbage", () => {
		const { agent } = fakeAgent(() => [
			{
				pause_id: "p1",
				org_id: "O-1",
				team_id: "T-1",
				channel: "C-1",
				thread_ts: "1.000",
				thread_key: "T:C:1",
				turn_id: "turn_1",
				asker_user: "U-1",
				question: "q",
				state_json: "{not json",
				status: "paused",
				created_at: 1,
				expires_at: 2,
				resumed_at: null,
			},
		])
		expect(loadPausedTurn(agent, "p1")).toBeNull()
	})
})

describe("markPausedTurnTerminal", () => {
	it("writes the terminal status with the pause id", () => {
		const { agent, runs } = fakeAgent()
		markPausedTurnTerminal(agent, "p1", "expired")
		const update = runs.find((run) => run.text.includes("UPDATE brain_paused_turn"))
		expect(update?.values).toEqual(["expired", "p1"])
	})
})
