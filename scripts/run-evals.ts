#!/usr/bin/env bun
/**
 * run-evals.ts — the golden turns, run for a human.
 *
 *   bun run evals
 *
 * No model, no network, no sandbox: this asserts which deterministic route a
 * message takes (see src/brain/turn/route.ts) against the cases in
 * evals/turns.jsonl. It is the same fixture set the vitest suite runs, but here
 * each failing case prints what it expected, what happened, and why the case
 * exists — the three things you need at 2am.
 *
 * Exit code is the contract: 0 when every case holds, 1 when any does not.
 */
import { actualFor, diffExpectation } from "../evals/actual"
import { loadTurnEvals } from "../evals/cases"

const cases = loadTurnEvals()
const failures: Array<{ id: string; problems: string[]; why: string; question: string }> = []

for (const testCase of cases) {
	const problems = diffExpectation(testCase, actualFor(testCase.question))
	if (problems.length) {
		failures.push({
			id: testCase.id,
			problems,
			why: testCase.why,
			question: testCase.question,
		})
	}
}

const passed = cases.length - failures.length
console.log(`golden turns: ${passed}/${cases.length} hold`)

if (failures.length) {
	console.log("")
	for (const failure of failures) {
		console.log(`✗ ${failure.id}`)
		console.log(`    asked:  "${failure.question}"`)
		for (const problem of failure.problems) console.log(`    ${problem}`)
		console.log(`    why it matters: ${failure.why}`)
		console.log("")
	}
	console.log(
		"Either the case is wrong (fix evals/turns.jsonl) or the routing is (fix\n" +
			"src/brain/turn/route.ts). Do not do both in one commit — then the eval\n" +
			"stops telling you which one changed.",
	)
	process.exit(1)
}
