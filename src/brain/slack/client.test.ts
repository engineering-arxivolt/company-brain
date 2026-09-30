import { describe, expect, it } from "vitest"
import { TURN_CONTINUE_ACTION_ID } from "../constants"
import { pausedTurnContinueBlocks } from "./client"

describe("pausedTurnContinueBlocks", () => {
	it("raises a primary Continue button keyed by the pause id", () => {
		const blocks = pausedTurnContinueBlocks("pause_123") as Array<{
			type: string
			block_id: string
			elements: Array<{
				type: string
				action_id: string
				value: string
				style?: string
				text: { type: string; text: string }
			}>
		}>

		expect(blocks).toHaveLength(1)
		const block = blocks[0]!
		expect(block.type).toBe("actions")
		const button = block.elements[0]!
		expect(button.type).toBe("button")
		expect(button.action_id).toBe(TURN_CONTINUE_ACTION_ID)
		expect(button.value).toBe("pause_123")
		expect(button.style).toBe("primary")
		expect(button.text.text).toContain("Continue")
	})
})
