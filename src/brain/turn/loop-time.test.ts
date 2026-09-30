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

	it("warns once the headroom is all that is left", () => {
		const s = state()
		const elapsed = TURN_PAUSE_BUDGET_MS - TURN_PAUSE_HEADROOM_MS + 1
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

	it("arms three minutes before the hard deadline", () => {
		expect(TURN_PAUSE_BUDGET_MS + TURN_PAUSE_HEADROOM_MS).toBe(10 * 60 * 1000)
		expect(TURN_PAUSE_HEADROOM_MS).toBe(3 * 60 * 1000)
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
