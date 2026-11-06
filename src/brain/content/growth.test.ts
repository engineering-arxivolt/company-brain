import { describe, expect, it } from "vitest"
import { ACTION_BAND, bandFor, chooseTopic, ctrBenchmark, scorePage, scoreTopic } from "./growth"

describe("ctrBenchmark", () => {
	it("follows the published curve and tails off", () => {
		expect(ctrBenchmark(1)).toBe(0.28)
		expect(ctrBenchmark(2)).toBe(0.15)
		expect(ctrBenchmark(7)).toBe(0.04)
		expect(ctrBenchmark(10)).toBe(0.04)
		expect(ctrBenchmark(15)).toBe(0.015)
		expect(ctrBenchmark(20)).toBe(0.015)
		expect(ctrBenchmark(41)).toBe(0.005)
	})

	it("treats a missing position as no expectation", () => {
		expect(ctrBenchmark(0)).toBe(0)
		expect(ctrBenchmark(Number.NaN)).toBe(0)
	})
})

describe("bandFor", () => {
	it("puts scores in the three action bands", () => {
		expect(bandFor(ACTION_BAND.doNow)).toBe("do_now")
		expect(bandFor(0.55)).toBe("queue")
		expect(bandFor(0.1)).toBe("ignore")
		expect(bandFor(Number.NaN)).toBe("ignore")
	})
})

describe("scorePage", () => {
	it("refreshes a page ranking 8-20 whose CTR is far under benchmark", () => {
		const decision = scorePage({ slug: "kra-penalties", impressions: 1_000, clicks: 5, position: 12 })
		expect(decision.action).toBe("refresh")
		expect(decision.opportunity).toBeGreaterThan(0)
		expect(decision.reasons.join(" ")).toContain("benchmark")
	})

	it("leaves a page alone when it beats the benchmark", () => {
		const decision = scorePage({ slug: "winning", impressions: 1_000, clicks: 200, position: 3 })
		expect(decision.action).toBe("leave")
		expect(decision.opportunity).toBe(0)
	})

	it("merges a stale page with no impressions at all", () => {
		const decision = scorePage({ slug: "orphan", impressions: 4, clicks: 0, position: 60, ageDays: 120 })
		expect(decision.action).toBe("merge_redirect")
		expect(decision.reasons[0]).toContain("fold it")
	})

	it("fixes the CTA when traffic converts badly", () => {
		const decision = scorePage({ slug: "traffic-no-leads", impressions: 20, clicks: 2, position: 3, sessions: 200, conversions: 0 })
		expect(decision.action).toBe("cta_fix")
		expect(decision.conversionGap).toBeGreaterThan(0)
	})

	it("notices decay even when nothing else is wrong", () => {
		const decision = scorePage({ slug: "slipping", impressions: 800, clicks: 40, position: 4, prevClicks: 80 })
		expect(decision.decay).toBeCloseTo(0.5, 3)
		expect(decision.reasons.join(" ")).toContain("clicks down 50%")
	})

	it("never produces a negative score from impossible inputs", () => {
		const decision = scorePage({ slug: "empty", impressions: -5, clicks: -1, position: -3 })
		expect(decision.score).toBeGreaterThanOrEqual(0)
		expect(decision.band).toBe("ignore")
	})
})

describe("scoreTopic", () => {
	it("hard-gates a topic that already has a page", () => {
		const decision = scoreTopic({ keyword: "kra nil return", volume: 2_710, coveredSlugs: ["kra-nil-return-kenya"] })
		expect(decision.score).toBe(0)
		expect(decision.band).toBe("ignore")
		expect(decision.reasons[0]).toContain("already covered")
	})

	it("scores a big transactional gap as do-now", () => {
		const decision = scoreTopic({ keyword: "etims integrator nairobi", volume: 5_000, intent: "transactional" })
		expect(decision.score).toBe(1)
		expect(decision.band).toBe("do_now")
	})

	it("ignores thin volume", () => {
		const decision = scoreTopic({ keyword: "obscure query", volume: 40 })
		expect(decision.band).toBe("ignore")
		expect(decision.reasons.join(" ")).toContain("too thin")
	})

	it("penalises a topic with nowhere to link from", () => {
		const decision = scoreTopic({ keyword: "some topic", volume: 3_000, linkSurface: 1 })
		expect(decision.score).toBeLessThan(0.4)
		expect(decision.reasons.join(" ")).toContain("only 1 internal pages")
	})

	it("gives regulatory freshness a small lift", () => {
		const decision = scoreTopic({ keyword: "cnva deadline", volume: 3_000, freshnessNeed: true })
		expect(decision.reasons.join(" ")).toContain("freshness compounds")
		// 3000/5000 volume × 0.5 informational weight × 1 link surface × 1.15 freshness
		expect(decision.score).toBeCloseTo(0.345, 3)
		expect(decision.band).toBe("ignore")
	})
})

describe("chooseTopic", () => {
	it("returns the best uncovered candidate", () => {
		const pick = chooseTopic([
			{ keyword: "covered one", volume: 9_000, coveredSlugs: ["existing"] },
			{ keyword: "kra nil return", volume: 4_800, intent: "transactional", cluster: "kra-obligations" },
			{ keyword: "thin one", volume: 30 },
		])
		expect(pick?.keyword).toBe("kra nil return")
		expect(pick?.band).toBe("do_now")
	})

	it("returns null instead of forcing a weak topic", () => {
		const pick = chooseTopic([{ keyword: "thin one", volume: 30 }, { keyword: "covered", volume: 9_000, coveredSlugs: ["x"] }])
		expect(pick).toBeNull()
	})

	it("respects a caller-supplied floor", () => {
		const pick = chooseTopic([{ keyword: "mid", volume: 2_500, intent: "informational" }], { minScore: 0.2 })
		expect(pick?.keyword).toBe("mid")
	})
})
