import { describe, expect, it } from "vitest"
import {
	findPullRequestUrl,
	isProtectedBranch,
	isValidBranchName,
} from "./pull-request"
import { normalizeSearchLimit, validateSearchPattern } from "./guards"

describe("branch safety", () => {
	it("refuses the branches that must never be pushed to", () => {
		for (const branch of ["main", "Main", "master", "production", "prod", "release"]) {
			expect(isProtectedBranch(branch)).toBe(true)
		}
		expect(isProtectedBranch("fix/odpc-72h-window")).toBe(false)
		expect(isProtectedBranch("feature/42")).toBe(false)
	})

	it("accepts ordinary branch names and rejects unsafe ones", () => {
		expect(isValidBranchName("fix/odpc-72h-window")).toBe(true)
		expect(isValidBranchName("feature_1.2")).toBe(true)
		expect(isValidBranchName("")).toBe(false)
		expect(isValidBranchName("has space")).toBe(false)
		expect(isValidBranchName("../../etc/passwd")).toBe(false)
		expect(isValidBranchName("a".repeat(200))).toBe(false)
	})
})

describe("findPullRequestUrl", () => {
	it("finds the URL wherever the response carries it", () => {
		expect(
			findPullRequestUrl({
				nested: { pullRequest: { html_url: "https://github.com/a/b/pull/7" } },
			}),
		).toBe("https://github.com/a/b/pull/7")
		expect(
			findPullRequestUrl([{ url: "https://github.com/a/b/pull/8" }]),
		).toBe("https://github.com/a/b/pull/8")
		expect(findPullRequestUrl({ nothing: "here" })).toBeNull()
	})
})

describe("validateSearchPattern", () => {
	it("accepts an ordinary pattern", () => {
		expect(validateSearchPattern("DEGRADED_NOTICE").ok).toBe(true)
		expect(validateSearchPattern("createAutomation\\(").ok).toBe(true)
	})

	it("rejects a pattern that is empty, enormous or carries control characters", () => {
		expect(validateSearchPattern("   ").ok).toBe(false)
		expect(validateSearchPattern("x".repeat(400)).ok).toBe(false)
		expect(validateSearchPattern("a\nb").ok).toBe(false)
	})
})

describe("normalizeSearchLimit", () => {
	it("keeps the limit inside its bounds", () => {
		expect(normalizeSearchLimit(undefined)).toBe(40)
		expect(normalizeSearchLimit(5)).toBe(5)
		expect(normalizeSearchLimit(0)).toBe(1)
		expect(normalizeSearchLimit(10_000)).toBe(200)
	})
})
