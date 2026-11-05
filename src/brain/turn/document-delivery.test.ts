import { describe, expect, it } from "vitest"
import {
	createDocumentDeliveryGuard,
	DOCUMENT_DELIVERY_REFUSAL,
} from "./document-delivery"
import { createTurnTerminalCapture } from "./terminal"

describe("createDocumentDeliveryGuard", () => {
	it("lets an ordinary turn finish", () => {
		const guard = createDocumentDeliveryGuard()
		expect(guard.refusal()).toBeUndefined()
	})

	it("refuses to finish a document turn until a file is delivered", () => {
		const guard = createDocumentDeliveryGuard()
		guard.require()
		expect(guard.required()).toBe(true)
		expect(guard.delivered()).toBe(false)
		expect(guard.refusal()).toBe(DOCUMENT_DELIVERY_REFUSAL)
		expect(guard.refusal()).toContain("sandbox_get_artifact")
	})

	it("allows finishing once the artifact tool reported a delivered file", () => {
		const guard = createDocumentDeliveryGuard()
		guard.require()
		guard.markDelivered("cv.pdf")
		expect(guard.delivered()).toBe(true)
		expect(guard.refusal()).toBeUndefined()
	})
})

describe("terminal capture with a delivery guard", () => {
	const proposal = {
		toolCallId: "call-1",
		toolName: "finish_turn",
		input: { outcome: "answered", reply: "Here are your documents." },
	}

	it("refuses and does not end the turn when nothing was delivered", () => {
		const guard = createDocumentDeliveryGuard()
		guard.require()
		const refused: string[] = []
		const capture = createTurnTerminalCapture({
			refuse: () => guard.refusal(),
			onRefused: (_proposal, reason) => refused.push(reason),
		})

		expect(capture.record(proposal)).toBeUndefined()
		expect(capture.requested()).toBe(false)
		expect(capture.count()).toBe(0)
		expect(refused).toEqual([DOCUMENT_DELIVERY_REFUSAL])
	})

	it("accepts the same proposal after delivery", () => {
		const guard = createDocumentDeliveryGuard()
		guard.require()
		guard.markDelivered("cv.pdf")
		const capture = createTurnTerminalCapture({ refuse: () => guard.refusal() })

		expect(capture.record(proposal)).toMatchObject({ outcome: "answered" })
		expect(capture.requested()).toBe(true)
		expect(capture.count()).toBe(1)
	})
})
