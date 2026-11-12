/**
 * Golden turns under vitest.
 *
 * The same fixtures `bun run evals` reads, run here so they are part of the
 * ordinary test suite and CI — one source of cases, two ways to run them. Each
 * case becomes its own test, named after its id, so a failure says which
 * promise about routing broke instead of "the eval suite failed".
 */
import { describe, expect, it } from "vitest"
import { actualFor, diffExpectation } from "../../../evals/actual"
import { loadTurnEvals } from "../../../evals/cases"

const cases = loadTurnEvals()

describe("golden turns", () => {
	it("has cases to run", () => {
		expect(cases.length).toBeGreaterThan(0)
	})

	for (const testCase of cases) {
		it(`${testCase.id} — ${testCase.why.slice(0, 72)}`, () => {
			const problems = diffExpectation(testCase, actualFor(testCase.question))
			expect(problems.join("\n") || "ok").toBe("ok")
		})
	}
})
