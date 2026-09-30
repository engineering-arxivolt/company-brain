import { describe, expect, it } from "vitest"
import { elideMiddle, splitBatchBySize } from "./posthog"

const LIMIT = 1_000


function sized(bytes: number) {
	return { event: "x", properties: { blob: "a".repeat(bytes) } }
}

describe("splitBatchBySize", () => {
	it("keeps a small batch in one chunk", () => {
		const batch = [sized(10), sized(10)]
		const chunks = splitBatchBySize(batch, LIMIT)
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toEqual(batch)
	})

	it("splits so no chunk exceeds the limit", () => {
		const batch = Array.from({ length: 10 }, () => sized(400))
		const chunks = splitBatchBySize(batch, LIMIT)
		expect(chunks.length).toBeGreaterThan(1)
		// Nothing dropped, nothing duplicated, and order preserved.
		expect(chunks.flat()).toEqual(batch)
	})

	// A single event larger than the limit cannot be made to fit. Sending it
	// alone at least keeps it from taking everyone else's batch down with it.
	it("isolates an event that cannot fit", () => {
		const huge = sized(5_000)
		const batch = [sized(10), huge, sized(10)]
		const chunks = splitBatchBySize(batch, LIMIT)
		expect(chunks.flat()).toEqual(batch)
		const hugeChunk = chunks.find((c) => c.includes(huge))
		expect(hugeChunk).toHaveLength(1)
	})

	it("keeps the other events when one is oversized", () => {
		const small = [sized(10), sized(10)]
		const chunks = splitBatchBySize([...small, sized(5_000)], LIMIT)
		expect(chunks.flat().slice(0, 2)).toEqual(small)
	})
})

describe("elideMiddle", () => {
	const LIMIT = 4_000

	it("leaves short text untouched", () => {
		const value = "short enough"
		expect(elideMiddle(value, LIMIT)).toBe(value)
	})

	it("never exceeds the limit", () => {
		const huge = "x".repeat(500_000)
		expect(elideMiddle(huge, LIMIT).length).toBeLessThanOrEqual(LIMIT)
	})

	// The reason this exists: a turn prompt is ~68k chars, mostly system-prompt
	// boilerplate, with the user's actual question at the very end. Plain
	// head-truncation would keep only the boilerplate.
	it("preserves the tail, where the live question is", () => {
		const question = "WHAT-IS-THE-ACTUAL-USER-QUESTION"
		const prompt = `${"boilerplate instructions ".repeat(2_000)}${question}`
		const result = elideMiddle(prompt, LIMIT)
		expect(result).toContain(question)
		expect(result).toContain("boilerplate instructions")
	})

	it("preserves the tail of a tool result too", () => {
		const tail = "MCP-SERVER-ERROR-DETAIL"
		const result = elideMiddle(`${"a".repeat(700_000)}${tail}`, LIMIT)
		expect(result).toContain(tail)
	})

	it("reports how much was elided", () => {
		const result = elideMiddle("x".repeat(50_000), LIMIT)
		expect(result).toMatch(/elided/)
	})
})
