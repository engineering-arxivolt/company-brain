import { describe, expect, it } from "vitest"
import {
	BULLET_RUBRIC,
	bulletIssues,
	numericTokens,
	regressionIssues,
	rubricLines,
} from "./rubric"

describe("bulletIssues", () => {
	it("catches a duty phrase where a result belongs", () => {
		const issues = bulletIssues("Responsible for the payments platform.")
		expect(issues.map((issue) => issue.code)).toContain("weak-opener")
	})

	it("catches first person and unquantified claims", () => {
		const codes = bulletIssues(
			"I helped with various improvements across several products.",
		).map((issue) => issue.code)
		expect(codes).toContain("first-person")
		expect(codes).toContain("vague")
		expect(codes).toContain("weak-opener")
	})

	it("catches a bullet that will not fit on one line", () => {
		const codes = bulletIssues(`Built ${"a".repeat(260)}`).map(
			(issue) => issue.code,
		)
		expect(codes).toContain("too-long")
	})

	it("leaves a good bullet alone", () => {
		expect(
			bulletIssues(
				"Cut API calls 50% by refactoring the data-fetching path.",
			),
		).toEqual([])
	})
})

describe("regressionIssues", () => {
	it("reports the metric a rewrite dropped", () => {
		const issues = regressionIssues(
			"Cut API calls 50% by refactoring the data-fetching path.",
			"Refactored the data-fetching path for a leaner platform.",
		)
		expect(issues.map((issue) => issue.code)).toContain("lost-metric")
		expect(issues.find((issue) => issue.code === "lost-metric")?.detail).toContain(
			"50",
		)
	})

	it("reports the posting word a rewrite dropped", () => {
		const issues = regressionIssues(
			"Built the CI/CD pipeline for payments.",
			"Built the release pipeline for payments.",
			{ focus: ["ci/cd"] },
		)
		expect(issues.map((issue) => issue.code)).toContain("lost-focus")
	})

	it("says nothing when the rewrite keeps both", () => {
		expect(
			regressionIssues(
				"Cut API calls 50% by refactoring the data-fetching path.",
				"Cut API calls 50% by caching responses.",
				{ focus: ["api"] },
			),
		).toEqual([])
	})
})

describe("numericTokens", () => {
	it("reads digits and words the same way", () => {
		expect(numericTokens("three engineers")).toEqual(new Set(["3"]))
		expect(numericTokens("3 engineers")).toEqual(new Set(["3"]))
		expect(numericTokens("50% fewer calls, $1,200 saved")).toEqual(
			new Set(["50", "1200"]),
		)
	})
})

describe("the rubric itself", () => {
	it("is one reviewable list shared by every career prompt", () => {
		expect(BULLET_RUBRIC.length).toBeGreaterThan(5)
		expect(rubricLines()).toHaveLength(BULLET_RUBRIC.length)
		expect(rubricLines()[0]).toContain("past-tense action verb")
		expect(rubricLines().join(" ")).toContain("XYZ")
	})
})
