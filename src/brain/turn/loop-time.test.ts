import { describe, expect, it } from "vitest"
import {
	applyTimeBudgetPolicy,
	TURN_PAUSE_BUDGET_MS,
	TURN_PAUSE_HEADROOM_MS,
} from "./loop"
import { beginTurnAttempt, createTurnState } from "./state"

function state() {
	return createTurnState({ request: { text: "q", threadKey: "T:C:1" } })
}

describe("applyTimeBudgetPolicy", () => {
	it("is quiet with plenty of budget left", () => {
		const result = applyTimeBudgetPolicy(state(), 60_000, TURN_PAUSE_BUDGET_MS)
		expect(result).toEqual({ warned: false, wrapUp: false })
		expect(state().warnings).toEqual([])
	})

	it("warns once the model is genuinely short on time", () => {
		const s = state()
		// 90s before the pause budget, not before the hard deadline.
		const elapsed = TURN_PAUSE_BUDGET_MS - 89_000
		const first = applyTimeBudgetPolicy(s, elapsed, TURN_PAUSE_BUDGET_MS)
		expect(first.warned).toBe(true)
		expect(first.wrapUp).toBe(false)
		expect(s.warnings.some((warning) => warning.startsWith("Time: "))).toBe(true)

		// Repeated evaluation does not stack duplicate warnings.
		const second = applyTimeBudgetPolicy(s, elapsed + 5, TURN_PAUSE_BUDGET_MS)
		expect(second.warned).toBe(false)
	})

	it("tells the model how much time is left", () => {
		const s = state()
		applyTimeBudgetPolicy(s, TURN_PAUSE_BUDGET_MS - 45_000, TURN_PAUSE_BUDGET_MS)
		expect(s.warnings.at(-1)).toContain("45s left")
	})

	// The wrap-up flag is what flips suspendRequested, so the pause lands at the
	// step boundary instead of yanking the deadline out from under a tool call.
	it("wraps up only when the budget is spent", () => {
		const s = state()
		const spent = applyTimeBudgetPolicy(s, TURN_PAUSE_BUDGET_MS, TURN_PAUSE_BUDGET_MS)
		expect(spent.wrapUp).toBe(true)
		expect(
			applyTimeBudgetPolicy(s, TURN_PAUSE_BUDGET_MS - 1, TURN_PAUSE_BUDGET_MS).wrapUp,
		).toBe(false)
	})

	it("arms five minutes before the hard deadline", () => {
		// Measured p90 for a single step is 217s, so a 3-minute headroom let the
		// abort fire mid-step and cost the asker the Continue button.
		expect(TURN_PAUSE_BUDGET_MS + TURN_PAUSE_HEADROOM_MS).toBe(10 * 60 * 1000)
		expect(TURN_PAUSE_HEADROOM_MS).toBe(5 * 60 * 1000)
	})

	// The invariant behind the number: once the pause arms, a step of typical
	// worst-case length must still finish before the hard deadline, so the turn
	// lands on a step boundary and returns a resumable envelope. When this
	// fails the asker silently loses the Continue button and gets the plain
	// "reply in the thread" text instead.
	it("leaves room for a p90-length step after the pause arms", () => {
		const P90_STEP_MS = 217_000
		expect(TURN_PAUSE_HEADROOM_MS).toBeGreaterThan(P90_STEP_MS)
		// ...and the pause must arm early enough that reaching it at all is
		// likely, rather than only on the pathological tail.
		expect(TURN_PAUSE_BUDGET_MS).toBeLessThanOrEqual(5 * 60 * 1000)
	})
})

describe("turn state time warnings", () => {
	// A new attempt gets a fresh runway, so the previous attempt's warning must
	// not survive into it.
	it("beginTurnAttempt clears the Time warning", () => {
		const s = state()
		applyTimeBudgetPolicy(s, TURN_PAUSE_BUDGET_MS - 10_000, TURN_PAUSE_BUDGET_MS)
		expect(s.warnings.some((warning) => warning.startsWith("Time: "))).toBe(true)
		beginTurnAttempt(s, 24)
		expect(s.warnings.some((warning) => warning.startsWith("Time: "))).toBe(false)
	})
})
