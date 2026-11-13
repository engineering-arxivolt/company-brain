import { describe, expect, it } from "vitest"
import type { BrainCostEntry } from "../billing/cost"
import { billableModels, sumCostRows, turnCostTotals } from "./turn-cost"

function entry(model: string, usd: number, tokens = { input: 1000, output: 500 }): BrainCostEntry {
	return {
		model,
		usd,
		source: "estimate",
		usage: {
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

describe("turnCostTotals", () => {
	it("sums every entry, whatever priced it", () => {
		const totals = turnCostTotals([
			entry("claude-sonnet-5", 0.02),
			{ ...entry("xai/grok-4.5", 0.008), source: "provider" },
			{ ...entry("tavily", 0.004), source: "vendor", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
		])
		expect(totals.usd).toBeCloseTo(0.032)
		expect(totals.turns).toBe(1)
		expect(totals.inputTokens).toBe(2000)
		expect(totals.outputTokens).toBe(1000)
	})

	it("is empty for a turn that cost nothing", () => {
		expect(turnCostTotals([])).toEqual({
			turns: 0,
			usd: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		})
	})

	it("ignores a non-finite price instead of turning the total into NaN", () => {
		const totals = turnCostTotals([entry("m", Number.NaN)])
		expect(totals.usd).toBe(0)
	})
})

describe("billableModels", () => {
	it("names only what actually cost money, most expensive first", () => {
		expect(
			billableModels([
				entry("cheap", 0.001),
				entry("expensive", 0.05),
				entry("free", 0),
			]),
		).toEqual(["expensive", "cheap"])
	})
})

describe("sumCostRows", () => {
	it("adds stored turns up, and survives a null column", () => {
		const totals = sumCostRows([
			{ usd: 0.02, input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 },
			{ usd: 0.03, input_tokens: 200, output_tokens: 80, cache_read_tokens: 10, cache_write_tokens: 0 },
			// A row written before a column existed must not poison the sum.
			{ usd: 0.01, input_tokens: null as unknown as number, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 },
		])
		expect(totals.turns).toBe(3)
		expect(totals.usd).toBeCloseTo(0.06)
		expect(totals.inputTokens).toBe(300)
		expect(totals.outputTokens).toBe(131)
	})
})
