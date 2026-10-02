import { describe, expect, it } from "vitest"
import type { ApprovalResumeState } from "./approval"
import { MAX_RESUME_STATE_BYTES, serializeResumeState } from "./approval"

// A tool result is the realistic source of bulk: MCP_SANDBOX_VALUE_CHAR_LIMIT
// is 750k chars, so a couple of them blow past SQLite's per-value ceiling.
function fatMessages(count: number, charsEach: number) {
	return Array.from({ length: count }, (_, index) => ({
		role: "assistant" as const,
		content: [
			{
				type: "tool-result" as const,
				toolCallId: `call_${index}`,
				toolName: "run_app_code",
				output: { type: "json" as const, value: "x".repeat(charsEach) },
			},
		],
	}))
}

function envelope(messages: ApprovalResumeState["messages"]): ApprovalResumeState {
	return {
		userId: "U1",
		actor: { orgId: "O1", userId: "U1" },
		question: "what is the status?",
		messages,
		approvalIds: ["a1"],
	}
}

describe("serializeResumeState", () => {
	it("passes a normal envelope through byte-identical", () => {
		const state = envelope(fatMessages(3, 1_000))
		expect(serializeResumeState(state)).toBe(JSON.stringify(state))
	})

	// The regression this exists for: the envelope embedded the whole
	// conversation, so a fat turn made the INSERT itself throw, which surfaced
	// as an opaque SqlError and killed the turn before the approval card.
	it("keeps an oversized envelope under SQLite's value ceiling", () => {
		const state = envelope(fatMessages(12, 400_000))
		const serialized = serializeResumeState(state)
		expect(serialized.length).toBeLessThanOrEqual(MAX_RESUME_STATE_BYTES)
		// Comfortably under the hard 2,000,000-byte SQLite limit, not merely
		// under our own budget.
		expect(serialized.length).toBeLessThan(2_000_000)
	})

	it("still round-trips to a valid envelope with the approval request intact", () => {
		const messages = [
			...fatMessages(12, 400_000),
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool-approval-request" as const,
						toolCallId: "call_final",
						approvalId: "a1",
					},
				],
			},
		] as unknown as ApprovalResumeState["messages"]
		const parsed = JSON.parse(
			serializeResumeState(envelope(messages)),
		) as ApprovalResumeState
		// The fields a resume depends on must survive intact.
		expect(parsed.approvalIds).toEqual(["a1"])
		expect(parsed.question).toBe("what is the status?")
		expect(parsed.userId).toBe("U1")
		// The tail -- where the pending approval request lives -- is preserved.
		expect(JSON.stringify(parsed.messages.at(-1))).toContain(
			"tool-approval-request",
		)
	})

	// Counts bytes, not characters: a multi-byte conversation must not be
	// measured as if it were ASCII, or the cap silently does nothing.
	it("measures multi-byte text in bytes", () => {
		const state = envelope(fatMessages(6, 300_000))
		const serialized = serializeResumeState(state)
		const bytes = new TextEncoder().encode(serialized).byteLength
		expect(bytes).toBeLessThanOrEqual(MAX_RESUME_STATE_BYTES)
		expect(serialized.length).toBeLessThanOrEqual(MAX_RESUME_STATE_BYTES)
	})

	// A single message too big to save is a real failure, not something to
	// paper over: returning a silently truncated envelope would resume the
	// turn against a corrupt transcript.
	it("throws rather than truncating the final message away", () => {
		const state = envelope(fatMessages(1, MAX_RESUME_STATE_BYTES + 10_000))
		expect(() => serializeResumeState(state)).toThrow(/too large to persist/)
	})
})