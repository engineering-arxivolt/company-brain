import { describe, expect, it } from "vitest"
import {
	buildStillPlanPrompt,
	parseStillPlan,
	renderStillPrompts,
} from "./stills"

describe("parseStillPlan", () => {
	it("accepts the documented shape", () => {
		const plan = parseStillPlan(
			'{"stills":[{"visual":"a rider at a charging post","line":"the bike is ready"}]}',
			"subject",
		)
		expect(plan.scenes).toEqual([
			{ seconds: 8, line: "the bike is ready", visual: "a rider at a charging post" },
		])
	})

	it("accepts drifting keys and bare arrays", () => {
		expect(
			parseStillPlan('```json\n{"scenes":[{"description":"a red door"}]}\n```', "s")
				.scenes[0]?.visual,
		).toBe("a red door")
		expect(parseStillPlan('["a blue gate","a busy road"]', "s").scenes).toHaveLength(2)
	})

	it("falls back to one still from the request when the reply is unusable", () => {
		expect(parseStillPlan("I cannot help with that", "a Nairobi skyline").scenes).toEqual([
			{ seconds: 8, line: "", visual: "a Nairobi skyline" },
		])
		expect(parseStillPlan(null, "a boda").scenes).toHaveLength(1)
	})

	it("caps a runaway plan", () => {
		const many = JSON.stringify({
			stills: Array.from({ length: 20 }, (_, i) => ({ visual: `scene ${i}` })),
		})
		expect(parseStillPlan(many, "s").scenes).toHaveLength(8)
	})
})

describe("renderStillPrompts", () => {
	it("writes one paste-ready line per still with the house rules", () => {
		const lines = renderStillPrompts({
			scenes: [
				{ seconds: 8, line: "", visual: "a rider at a charging post" },
				{ seconds: 8, line: "", visual: "a closed loan window" },
			],
		}).split("\n")
		expect(lines).toHaveLength(2)
		expect(lines[0]).toContain("1. a rider at a charging post")
		expect(lines[0]).toContain("#1B3A5C")
		expect(lines[0]).toContain("no text")
		expect(lines[1]?.startsWith("2. ")).toBe(true)
	})
})

describe("buildStillPlanPrompt", () => {
	it("asks for stills only, and says how many when told", () => {
		const prompt = buildStillPlanPrompt("Kenya EV boda gap", 5)
		expect(prompt.system).toContain('"stills"')
		expect(prompt.user).toContain("Kenya EV boda gap")
		expect(prompt.user).toContain("5")
	})
})