import { describe, expect, it } from "vitest"
import { TURN_CONTINUE_ACTION_ID, TURN_STOP_ACTION_ID } from "../constants"
import {
	longJobStatusBlocks,
	longJobStatusText,
	pausedTurnContinueBlocks,
	uploadContentType,
} from "./client"

describe("uploadContentType", () => {
	it("tells Slack a PDF is a PDF", () => {
		// Regression: every upload went up as application/octet-stream, so the
		// file landed in the thread as an opaque blob and its viewer showed a
		// black box instead of the document.
		expect(uploadContentType("cv.pdf")).toBe("application/pdf")
		expect(uploadContentType("Cover-Letter.PDF")).toBe("application/pdf")
	})

	it("maps the other types the brain sends", () => {
		expect(uploadContentType("chart.png")).toBe("image/png")
		expect(uploadContentType("photo.jpeg")).toBe("image/jpeg")
		expect(uploadContentType("data.csv")).toBe("text/csv")
		expect(uploadContentType("notes.md")).toBe("text/plain")
		expect(uploadContentType("export.zip")).toBe("application/zip")
	})

	it("falls back to a blob when the name says nothing", () => {
		expect(uploadContentType("artifact")).toBe("application/octet-stream")
		expect(uploadContentType("weird.xyz")).toBe("application/octet-stream")
	})
})

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

describe("longJobStatusBlocks", () => {
	it("shows the status text and a danger Stop button keyed by the job id", () => {
		const blocks = longJobStatusBlocks("working on it", "job_123") as Array<{
			type: string
			block_id?: string
			text?: { type: string; text: string }
			elements?: Array<{
				type: string
				action_id: string
				value: string
				style?: string
				text: { type: string; text: string }
			}>
		}>

		expect(blocks).toHaveLength(2)
		expect(blocks[0]?.type).toBe("section")
		expect(blocks[0]?.text?.text).toBe("working on it")
		const block = blocks[1]!
		expect(block.type).toBe("actions")
		expect(block.block_id).toBe("brain_long_job_actions")
		const button = block.elements![0]!
		expect(button.type).toBe("button")
		expect(button.action_id).toBe(TURN_STOP_ACTION_ID)
		expect(button.value).toBe("job_123")
		expect(button.style).toBe("danger")
		expect(button.text.text).toContain("Stop")
	})

	it("says which background step is running", () => {
		const text = longJobStatusText("U-1", 2, 5)
		expect(text).toContain("step 2 of 5")
		expect(text).toContain("<@U-1>")
	})
})
