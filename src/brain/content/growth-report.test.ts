import { describe, expect, it } from "vitest"
import { buildGrowthReport, renderGrowthReport } from "./growth-report"

describe("buildGrowthReport", () => {
	it("ranks page fixes and new articles together by score", () => {
		const report = buildGrowthReport({
			pages: [
				{ slug: "kra-penalties", impressions: 4_000, clicks: 4, position: 11, prevClicks: 20, intent: "commercial" },
				{ slug: "etims-compliance", impressions: 900, clicks: 300, position: 2, intent: "commercial" },
			],
			topics: [{ keyword: "etims integrator nairobi", volume: 5_000, intent: "transactional" }],
			maxActions: 5,
		})
		expect(report.actions[0]?.kind).toBe("new_article")
		expect(report.actions[0]?.target).toBe("etims integrator nairobi")
		expect(report.actions[0]?.band).toBe("do_now")
		expect(report.actions.map((a) => a.target)).toContain("kra-penalties")
		expect(report.actions.map((a) => a.target)).not.toContain("etims-compliance")
		expect(report.ignored).toBe(1)
	})

	it("labels the action kind from the decision, not from the score", () => {
		const report = buildGrowthReport({
			pages: [{ slug: "stale-orphan", impressions: 0, clicks: 0, position: 80, ageDays: 200 }],
			maxActions: 3,
			includeIgnored: true,
		})
		expect(report.actions[0]?.kind).toBe("merge_redirect")
	})

	it("caps the list at review capacity", () => {
		const pages = Array.from({ length: 9 }, (_, i) => ({
			slug: `page-${i}`,
			impressions: 2_000,
			clicks: 1,
			position: 12,
			prevClicks: 50,
			intent: "commercial" as const,
		}))
		const report = buildGrowthReport({ pages, maxActions: 2 })
		expect(report.actions).toHaveLength(2)
		expect(report.considered).toBe(9)
	})

	it("is allowed to be quiet", () => {
		const report = buildGrowthReport({
			pages: [{ slug: "winner", impressions: 10, clicks: 9, position: 1 }],
			topics: [{ keyword: "covered", volume: 9_000, coveredSlugs: ["winner"] }],
		})
		expect(report.quiet).toBe(true)
		expect(report.actions).toEqual([])
		expect(renderGrowthReport(report)).toContain("No action clears the threshold")
	})

	it("surfaces ignored rows only when asked", () => {
		const input = {
			pages: [{ slug: "covered", impressions: 10, clicks: 9, position: 1 }],
			topics: [{ keyword: "thin", volume: 20 }],
		}
		expect(buildGrowthReport(input).actions).toHaveLength(0)
		expect(buildGrowthReport({ ...input, includeIgnored: true }).actions).toHaveLength(1)
	})
})

describe("renderGrowthReport", () => {
	it("prints the band, score, action and reasons", () => {
		const report = buildGrowthReport({
			topics: [{ keyword: "kra nil return", volume: 5_000, intent: "transactional", cluster: "kra-obligations" }],
		})
		const text = renderGrowthReport(report)
		expect(text).toContain("DO NOW")
		expect(text).toContain("new article → kra nil return")
		expect(text).toContain("score 1")
	})
})
