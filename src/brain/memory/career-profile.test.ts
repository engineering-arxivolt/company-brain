import { describe, expect, it } from "vitest"
import {
	careerProfileCustomId,
	careerProfileDigest,
	careerProfileKey,
	planCareerProfileSeed,
	renderBaseCvContext,
} from "./career-profile"

const BASE_CV = `# Base CV — Joseph Mindo

## Experience

**Engineer — GRIFFIN Global Technologies** (July 2025 – Present)
`

describe("career profile keys", () => {
	it("names one KV key and one document per user", () => {
		expect(careerProfileKey("x3k1185")).toBe("career_profile:x3k1185")
		expect(careerProfileCustomId("x3k1185")).toBe("career_profile_x3k1185")
	})
})

describe("careerProfileDigest", () => {
	it("is stable for the same text", () => {
		expect(careerProfileDigest(BASE_CV)).toBe(careerProfileDigest(BASE_CV))
		expect(careerProfileDigest(` ${BASE_CV} `)).toBe(careerProfileDigest(BASE_CV))
	})

	it("changes when the base CV changes", () => {
		expect(careerProfileDigest(`${BASE_CV}added a role`)).not.toBe(
			careerProfileDigest(BASE_CV),
		)
	})
})

describe("renderBaseCvContext", () => {
	it("carries the CV itself and tells the model not to go looking for it", () => {
		const block = renderBaseCvContext(BASE_CV)
		expect(block.startsWith("<base_cv>")).toBe(true)
		expect(block.trimEnd().endsWith("</base_cv>")).toBe(true)
		expect(block).toContain("Engineer — GRIFFIN Global Technologies")
		expect(block).toContain("Do not search memory for it")
	})

	it("renders nothing rather than an empty block", () => {
		expect(renderBaseCvContext("   \n ")).toBe("")
	})
})

describe("planCareerProfileSeed", () => {
	it("seeds a base CV that memory does not have yet", () => {
		const plan = planCareerProfileSeed({
			source: BASE_CV,
			existingDigest: null,
		})
		expect(plan.action).toBe("write")
		if (plan.action !== "write") return
		expect(plan.content).toBe(BASE_CV.trim())
		expect(plan.digest).toBe(careerProfileDigest(BASE_CV))
	})

	it("does nothing when the operator published nothing", () => {
		expect(
			planCareerProfileSeed({ source: null, existingDigest: null }),
		).toEqual({ action: "skip", reason: "no_source" })
		expect(
			planCareerProfileSeed({ source: "   ", existingDigest: null }),
		).toEqual({ action: "skip", reason: "no_source" })
	})

	it("does nothing when memory already carries that exact text", () => {
		expect(
			planCareerProfileSeed({
				source: BASE_CV,
				existingDigest: careerProfileDigest(BASE_CV),
			}),
		).toEqual({ action: "skip", reason: "up_to_date" })
	})

	it("re-seeds after the base CV is edited", () => {
		const plan = planCareerProfileSeed({
			source: `${BASE_CV}added a role`,
			existingDigest: careerProfileDigest(BASE_CV),
		})
		expect(plan.action).toBe("write")
	})

	it("treats identical stored content as already seeded", () => {
		// Metadata can be dropped by the memory service; content is what the
		// document actually says, so it is the fallback equality check.
		expect(
			planCareerProfileSeed({
				source: BASE_CV,
				existingDigest: null,
				existingContent: ` ${BASE_CV}\n`,
			}),
		).toEqual({ action: "skip", reason: "up_to_date" })
	})

	it("re-seeds when the stored content is a different version", () => {
		expect(
			planCareerProfileSeed({
				source: BASE_CV,
				existingDigest: null,
				existingContent: "old cv",
			}).action,
		).toBe("write")
	})
})
