import { describe, expect, it } from "vitest"
import {
	isNarrationOnlySlackReply,
	isPublishableSlackReply,
	stripDraftingSelfTalk,
} from "./reply-quality"

describe("narration-only reply detection", () => {
	it.each([
		"Lemme pull our threads…",
		"Let me check the thread history.",
		"Let me gather the evidence.",
		"I'll read the report.",
		"I’ll build the document.",
		"I'll create the summary.",
		"I'll look into the failing deployment.",
	])("treats %j as an intention, not an answer", (reply) => {
		expect(isNarrationOnlySlackReply(reply)).toBe(true)
		expect(isPublishableSlackReply(reply)).toBe(false)
	})

	it("does not reject an account of completed work", () => {
		const reply = "I pulled our threads. Three are still open."
		expect(isNarrationOnlySlackReply(reply)).toBe(false)
		expect(isPublishableSlackReply(reply)).toBe(true)
	})

	it("strips narration while retaining delivered findings", () => {
		expect(
			stripDraftingSelfTalk(
				"Lemme pull our threads. I found three open incidents.",
			),
		).toBe("I found three open incidents.")
	})
})
