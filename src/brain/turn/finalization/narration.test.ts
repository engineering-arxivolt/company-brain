import type { ModelMessage } from "ai"
import { describe, expect, it } from "vitest"
import { selectTurnReply } from "./output"
import {
	NARRATION_RETRY_INSTRUCTION,
	resolveNarrationOnlyOutput,
} from "./narration"

type FakeOutput = {
	text: string
	terminalReply?: string
}

function modelResult(text: string) {
	return {
		text: Promise.resolve(text),
		response: Promise.resolve({
			messages: [{ role: "assistant", content: text } as ModelMessage],
		}),
	}
}

/** Exercises the same output-resolution contract as computeTurn's model loop. */
async function runFakeTurn(
	outputs: FakeOutput[],
	options: { completedToolSteps?: number; stepsRemaining?: number } = {},
) {
	let messages: ModelMessage[] = [
		{ role: "user", content: "Pull our open threads and summarize them." },
	]
	let retryUsed = false
	const calls: Array<{ messages: ModelMessage[]; activeTools: string[] }> = []

	for (const output of outputs) {
		// The retry uses the ordinary tool-enabled model invocation, not a
		// tool-free answer rewrite.
		calls.push({
			messages,
			activeTools: ["search_messages", "finish_turn"],
		})
		const result = modelResult(output.text)
		const candidate = await selectTurnReply({
			result,
			terminalProposal: output.terminalReply
				? { outcome: "answered", reply: output.terminalReply }
				: undefined,
		})
		const resolution = await resolveNarrationOnlyOutput({
			candidate,
			hasTerminalProposal: output.terminalReply !== undefined,
			stepsRemaining: options.stepsRemaining ?? 5,
			retryUsed,
			pauseRequested: false,
			completedToolSteps: options.completedToolSteps ?? 0,
			messages,
			responseMessages: async () => (await result.response).messages,
			compactMessages: (input) => input,
		})
		if (resolution.action === "retry") {
			retryUsed = true
			messages = resolution.messages
			continue
		}
		return { ...resolution, calls }
	}
	throw new Error("fake turn exhausted its scripted outputs")
}

describe("narration-only turn recovery", () => {
	it("retries with tools and completes when the model then answers", async () => {
		const completed = await runFakeTurn([
			{ text: "Lemme pull our threads…" },
			{
				text: "",
				terminalReply: "I pulled the threads. Three are still open.",
			},
		])

		expect(completed.action).toBe("publish")
		expect(completed.calls).toHaveLength(2)
		expect(completed.calls[1]?.activeTools).toContain("search_messages")
		expect(completed.calls[1]?.activeTools).toContain("finish_turn")
		const retryInstruction = completed.calls[1]?.messages.at(-1)
		expect(retryInstruction).toEqual({
			role: "user",
			content: NARRATION_RETRY_INSTRUCTION,
		})
		expect(NARRATION_RETRY_INSTRUCTION).toContain("Do the work now")
		expect(NARRATION_RETRY_INSTRUCTION).toContain("finish_turn")
		if (completed.action === "publish") {
			expect(completed.candidate.reply).toBe(
				"I pulled the threads. Three are still open.",
			)
		}
	})

	it("narrates twice: exactly one retry, honest status, and no loop", async () => {
		const completed = await runFakeTurn(
			[
				{ text: "Lemme pull our threads…" },
				{ text: "I'll check the open incidents now." },
			],
			{ completedToolSteps: 2 },
		)

		expect(completed.action).toBe("publish")
		expect(completed.calls).toHaveLength(2)
		if (completed.action === "publish") {
			expect(completed.candidate.reply).toContain("2 tool steps")
			expect(completed.candidate.reply).toContain("still unfinished")
			expect(completed.candidate.reply).toContain("complete answer")
			expect(completed.candidate.reply).not.toContain("Lemme")
			expect(completed.candidate.reply).not.toContain("I'll check")
			expect(completed.candidate.reply).not.toContain(
				"Sorry — I couldn't put together an answer",
			)
		}
	})

	it("does not spend a retry when no steps remain", async () => {
		const completed = await runFakeTurn(
			[{ text: "I'll read the report." }],
			{ stepsRemaining: 0 },
		)
		expect(completed.calls).toHaveLength(1)
		expect(completed.action).toBe("publish")
		if (completed.action === "publish") {
			expect(completed.candidate.reply).toContain("No tool work was completed")
		}
	})
})
