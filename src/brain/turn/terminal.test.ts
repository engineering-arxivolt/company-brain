import { describe, expect, it } from "vitest"
import { createTurnTerminalCapture, FINISH_TURN_TOOL_NAME } from "./terminal"

const record = (input: unknown, toolName = FINISH_TURN_TOOL_NAME) =>
	createTurnTerminalCapture().record({
		toolCallId: "call-1",
		toolName,
		input,
	})

describe("terminal proposal parsing", () => {
	it("keeps the answer and drops nothing when no flourish is proposed", () => {
		expect(
			record({ outcome: "answered", reply: "Done — the report is attached." }),
		).toEqual({ outcome: "answered", reply: "Done — the report is attached." })
	})

	it("normalizes a proposed reaction permissively", () => {
		expect(
			record({ outcome: "answered", reply: "Shipped!", reaction: " :TADA: " }),
		).toMatchObject({ reaction: "tada" })
	})

	it("carries the gif candidate id through for server-side resolution", () => {
		expect(
			record({ outcome: "answered", reply: "Nice work!", gif_id: "g3" }),
		).toMatchObject({ gifId: "g3" })
	})

	it("still rejects proposals without a valid outcome or reply", () => {
		expect(record({ outcome: "celebrating", reply: "hi" })).toBeUndefined()
		expect(record({ outcome: "answered", reply: "   " })).toBeUndefined()
		expect(record({ outcome: "answered", reply: "ok", reaction: 42 })).toMatchObject({
			outcome: "answered",
		})
	})

	it("ignores other tools", () => {
		expect(record({ outcome: "answered", reply: "x" }, "search_web")).toBeUndefined()
	})
})
