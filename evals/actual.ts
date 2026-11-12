import { classifyTurn, TURN_ROUTES } from "../src/brain/turn/route"
import type { FlowExpectation, TurnEvalCase, TurnEvalExpectation } from "./cases"

/**
 * What the turn actually does with a message, in the shape a case asserts.
 *
 * One function so the bun runner and the vitest mirror can never disagree
 * about what "actual" means — a mismatch would make the suite lie.
 */
export function actualFor(question: string): Required<TurnEvalExpectation> {
	const classification = classifyTurn(question)
	const flow = classification.flow
	const flowExpectation: FlowExpectation = flow.queue
		? "queued"
		: flow.blockedPicture
			? "blocked"
			: "not-asked"
	return {
		primary: classification.primary,
		matched: classification.matched,
		flow: flowExpectation,
		clip: flow.queue ? flow.clip : false,
	}
}

/**
 * Every way the turn disagrees with the case, as readable lines.
 *
 * `clip` is only compared when the case states it: most cases do not care, and
 * a diff nobody asked for is noise in the failure output.
 */
export function diffExpectation(
	testCase: TurnEvalCase,
	actual: Required<TurnEvalExpectation>,
): string[] {
	const expected = testCase.expect
	const problems: string[] = []
	if (expected.primary !== actual.primary) {
		problems.push(`primary: expected ${String(expected.primary)}, got ${String(actual.primary)}`)
	}
	if (expected.matched.join(",") !== actual.matched.join(",")) {
		problems.push(
			`matched: expected [${expected.matched.join(", ")}], got [${actual.matched.join(", ")}]`,
		)
	}
	if (expected.flow !== actual.flow) {
		problems.push(`flow: expected ${expected.flow}, got ${actual.flow}`)
	}
	if (expected.clip !== undefined && expected.clip !== actual.clip) {
		problems.push(`clip: expected ${String(expected.clip)}, got ${String(actual.clip)}`)
	}
	for (const route of expected.matched) {
		if (!(TURN_ROUTES as readonly string[]).includes(route)) {
			problems.push(`matched: "${route}" is not a turn route`)
		}
	}
	return problems
}
