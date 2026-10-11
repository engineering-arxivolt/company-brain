import { describe, expect, it } from "vitest"
import type { ModelMessage } from "ai"
import {
	appendKeepingApprovalLast,
	elideStaleToolResults,
	replaceTrailingTurnState,
	STALE_TOOL_RESULT_CHAR_LIMIT,
	stubTextForToolResult,
} from "./context"
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

function toolResultMessage(toolName: string, value: string): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: `call-${toolName}`,
				toolName,
				output: { type: "text", value },
			},
		],
	} as unknown as ModelMessage
}

describe("elideStaleToolResults", () => {
	it("stubs results older than 2 tool turns that exceed 2,000 characters", () => {
		const big = "x".repeat(STALE_TOOL_RESULT_CHAR_LIMIT + 100)
		const input = [
			toolResultMessage("d1_database_query", big),
			toolResultMessage("search_brain", big),
			toolResultMessage("read_memory", big),
		]
		const result = elideStaleToolResults(input)
		const stub = stubTextForToolResult(
			"d1_database_query",
			STALE_TOOL_RESULT_CHAR_LIMIT + 100,
		)
		expect(result[0]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-d1_database_query",
					toolName: "d1_database_query",
					// AI SDK v6: output stays an object. The OpenAI-compatible
					// converter sends output.value as the plain tool string.
					output: { type: "text", value: stub },
				},
			],
		})
		// The two most recent tool turns stay verbatim.
		expect(result[1]).toBe(input[1])
		expect(result[2]).toBe(input[2])
	})

	it("keeps small results and is idempotent", () => {
		const small = toolResultMessage("search_brain", "tiny")
		const big = "y".repeat(STALE_TOOL_RESULT_CHAR_LIMIT + 1)
		const once = elideStaleToolResults([
			toolResultMessage("d1_database_query", big),
			small,
			toolResultMessage("read_memory", "recent-big-kept".padEnd(10, "z")),
		])
		// First message stubbed, small + recent untouched.
		const first = once[0] as { content: Array<{ output: { value: string } }> }
		expect(first.content[0]?.output.value).toContain("[elided:")
		expect(once[1]).toEqual(small)
		const twice = elideStaleToolResults(once)
		expect(twice).toEqual(once)
	})
})
