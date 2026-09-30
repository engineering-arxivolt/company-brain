import { afterEach, describe, expect, it, vi } from "vitest"
import { TURN_DEADLINE_MS, turnDeadlineSignal } from "./util"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("TURN_DEADLINE_MS", () => {
	// The value is a documented product commitment (see docs/spec.md), so this
	// assertion is deliberately brittle: changing the ceiling must be a
	// conscious edit here and in the doc, not a silent drift.
	it("is ten minutes", () => {
		expect(TURN_DEADLINE_MS).toBe(10 * 60 * 1000)
	})
})

describe("turnDeadlineSignal", () => {
	it("arms the deadline from TURN_DEADLINE_MS", () => {
		const timeout = vi.spyOn(AbortSignal, "timeout")
		turnDeadlineSignal()
		expect(timeout).toHaveBeenCalledWith(TURN_DEADLINE_MS)
	})

	it("is not aborted on creation", () => {
		const { deadline, signal } = turnDeadlineSignal()
		expect(deadline.aborted).toBe(false)
		expect(signal.aborted).toBe(false)
	})

	it("returns the deadline itself as the signal when there is no control", () => {
		const { deadline, signal } = turnDeadlineSignal()
		expect(signal).toBe(deadline)
	})

	// This is the load-bearing behavior for all three callers: the catch blocks
	// tell "timed out" from "cancelled" by testing the deadline alone, so a
	// control abort must fuse into the signal without touching the deadline.
	it("aborts the fused signal on control while leaving the deadline un-aborted", () => {
		const control = new AbortController()
		const { deadline, signal } = turnDeadlineSignal(control.signal)

		control.abort(new Error("superseded"))

		expect(signal.aborted).toBe(true)
		expect(deadline.aborted).toBe(false)
	})

	it("fuses control into a new signal rather than replacing it", () => {
		const control = new AbortController()
		const { signal } = turnDeadlineSignal(control.signal)

		expect(signal).not.toBe(control.signal)
		expect(signal.aborted).toBe(false)
	})
})
