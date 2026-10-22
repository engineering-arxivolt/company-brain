import { describe, expect, it } from "vitest"
import { allowedValuesSummary } from "./method-contract"

describe("allowedValuesSummary", () => {
	it("lists the values a field accepts", () => {
		// The shape a server rejects: "fields.13: Invalid option: expected
		// one of [...]" — the model needs the list, not a truncated error.
		const summary = allowedValuesSummary({
			type: "object",
			properties: {
				fields: {
					type: "array",
					items: {
						type: "string",
						enum: ["number", "title", "state", "merged", "updated_at"],
					},
				},
				state: { type: "string", enum: ["open", "merged"] },
			},
		})
		expect(summary).toContain("fields: number | title | state | merged | updated_at")
		expect(summary).toContain("state: open | merged")
	})

	it("reads values out of anyOf and oneOf variants", () => {
		const summary = allowedValuesSummary({
			type: "object",
			properties: {
				mode: {
					oneOf: [
						{ type: "string", enum: ["addToQueue"] },
						{ type: "string", enum: ["shareNow"] },
					],
				},
			},
		})
		expect(summary).toContain("mode: addToQueue | shareNow")
	})

	it("says nothing about fields that accept anything", () => {
		const summary = allowedValuesSummary({
			type: "object",
			properties: { query: { type: "string" } },
		})
		expect(summary).toBe("")
	})

	it("survives a schema it cannot read", () => {
		expect(allowedValuesSummary(undefined)).toBe("")
		expect(allowedValuesSummary("nonsense")).toBe("")
	})
})
