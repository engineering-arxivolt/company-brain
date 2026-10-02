import { describe, expect, it } from "vitest"
import {
	MAX_SLACK_TURN_RECOVERY_ATTEMPTS,
	slackTurnRecoveryCanRetry,
	type SlackTurnFiberSnapshot,
} from "./slack-turn-fiber"

function snapshot(
	overrides: Partial<SlackTurnFiberSnapshot> = {},
): SlackTurnFiberSnapshot {
	return {
		version: 1,
		message: { teamId: "T1", event: { type: "message" } },
		attempt: 0,
		phase: "running",
		...overrides,
	} as SlackTurnFiberSnapshot
}

// The agents SDK has no retry for managed fibers — `error` and `aborted` are
// both terminal — so this predicate is the only thing standing between a
// transient recovery failure and a silently dropped turn. Every branch here is
// a case where re-arming would double-answer the user or loop forever.
describe("slackTurnRecoveryCanRetry", () => {
	it("allows a retry while attempts remain", () => {
		expect(slackTurnRecoveryCanRetry(snapshot())).toBe(true)
	})

	it("refuses without a usable snapshot", () => {
		expect(slackTurnRecoveryCanRetry(null)).toBe(false)
	})

	it("refuses once the attempt budget is spent", () => {
		expect(
			slackTurnRecoveryCanRetry(
				snapshot({ attempt: MAX_SLACK_TURN_RECOVERY_ATTEMPTS }),
			),
		).toBe(false)
	})

	it("refuses after the user was already answered", () => {
		expect(
			slackTurnRecoveryCanRetry(snapshot({ replyMessageTs: "1700.1" })),
		).toBe(false)
		expect(
			slackTurnRecoveryCanRetry(snapshot({ approvalMessageTs: "1700.2" })),
		).toBe(false)
	})

	it("refuses when a terminal proposal is waiting to be published", () => {
		expect(
			slackTurnRecoveryCanRetry(
				snapshot({
					terminalProposal: { outcome: "answered", reply: "here you go" },
				}),
			),
		).toBe(false)
	})
})