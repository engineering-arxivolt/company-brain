import { describe, expect, it } from "vitest"
import type { ModelMessage } from "ai"
import { appendKeepingApprovalLast, replaceTrailingTurnState } from "./context"
import { createTurnState } from "./state"

const toolCall: ModelMessage = {
	role: "assistant",
	content: [
		{ type: "tool-call", toolCallId: "c1", toolName: "mcp_execute_tool", input: {} },
	],
}

const approvalResponse: ModelMessage = {
	role: "tool",
	content: [
		{ type: "tool-approval-response", approvalId: "a1", approved: true, reason: "ok" },
	],
} as unknown as ModelMessage

const liveUpdate: ModelMessage = { role: "user", content: "also, do X" }

// The SDK only executes an approved tool call when the approval response is the
// final message. A live update drained mid-step used to be appended after it,
// which re-prompted for approval instead of running the tool -- the user
// approved, and the same action asked again.
describe("appendKeepingApprovalLast", () => {
	it("keeps the approval response last when a live update arrives", () => {
		const result = appendKeepingApprovalLast(
			[toolCall, approvalResponse],
			[liveUpdate],
		)
		expect(result.at(-1)).toBe(approvalResponse)
		expect(result).toHaveLength(3)
		// The update is still present, just not last.
		expect(result).toContainEqual(liveUpdate)
	})

	it("appends normally when there is no trailing approval response", () => {
		const result = appendKeepingApprovalLast([toolCall], [liveUpdate])
		expect(result.at(-1)).toBe(liveUpdate)
	})

	it("is a no-op with no additions", () => {
		const result = appendKeepingApprovalLast([toolCall, approvalResponse], [])
		expect(result).toEqual([toolCall, approvalResponse])
	})

	it("does not mutate its input", () => {
		const input = [toolCall, approvalResponse]
		appendKeepingApprovalLast(input, [liveUpdate])
		expect(input).toHaveLength(2)
	})
})

describe("replaceTrailingTurnState after an approval response", () => {
	it("adds no turn state on top of an approval response", () => {
		const state = createTurnState({
			request: { text: "send it", threadKey: "C1:1.0" },
		})
		const result = replaceTrailingTurnState([toolCall, approvalResponse], state)
		// The turn-state message is deliberately withheld here; appending it
		// would re-prompt just like a live update would.
		expect(result).toHaveLength(2)
		expect(result.at(-1)).toBe(approvalResponse)
	})
})
