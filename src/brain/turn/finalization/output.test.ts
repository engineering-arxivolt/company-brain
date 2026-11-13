import { describe, expect, it } from "vitest"
import { selectTurnReply } from "./output"

/** A result whose streams resolve to the given text/messages. */
function result(text: string, messages: Array<Record<string, unknown>> = []) {
	return {
		text: Promise.resolve(text),
		response: Promise.resolve({ messages }),
	} as unknown as Parameters<typeof selectTurnReply>[0]["result"]
}

describe("selectTurnReply", () => {
	it("uses the finished text when there is one", async () => {
		await expect(selectTurnReply({ result: result("Here are the two files.") })).resolves.toEqual({
			reply: "Here are the two files.",
			source: "text",
		})
	})

	it("recovers a reply that only narrated its own drafting", async () => {
		// The live failure: a weak hop narrates, the quality gate rejects the whole
		// message, and the asker gets "sorry, I couldn't put together an answer".
		const painted =
			"Let me write the LaTeX file now. The report has six sections and two charts, and I'll deliver it as a PDF."
		const selected = await selectTurnReply({ result: result(painted) })
		expect(selected.source).toBe("response")
		expect(selected.reply).toContain("six sections")
		expect(selected.reply.toLowerCase()).not.toContain("let me write")
	})

	it("still refuses to publish raw drafting when nothing else remains", async () => {
		const selected = await selectTurnReply({
			result: result("Let me write the JSON."),
		})
		expect(selected).toEqual({ reply: "", source: "empty" })
	})

	it("keeps the largest usable assistant draft", async () => {
		const selected = await selectTurnReply({
			result: result("", [
				{ role: "assistant", content: "Short." },
				{ role: "assistant", content: "A much longer and more useful answer for the asker." },
			]),
		})
		expect(selected.reply).toContain("more useful")
		expect(selected.source).toBe("response")
	})
})
