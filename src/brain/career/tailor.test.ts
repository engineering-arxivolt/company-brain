import { describe, expect, it } from "vitest"
import { parseCareerProfile } from "./profile"
import {
	applyTailoring,
	buildTailorPrompt,
	parseTailoringPlan,
	tailorCoverage,
} from "./tailor"
import { renderCoverLetterTex } from "./cover-letter"

const BASE_CV = `# Base CV — Joseph Test

## Contact

- location: Nairobi
- email: joseph@example.com

## Professional Summary

General engineer summary.

## Experience

**Software Engineer — Acme** (2020 — Present)
- Built a payments platform with TypeScript and Postgres.
- Led a team of three engineers across two products.

**Designer — Beta** (2018 — 2020)
- Designed mobile interfaces in Figma.
`

const profile = parseCareerProfile(BASE_CV)

describe("parseTailoringPlan", () => {
	it("accepts a plan wrapped in prose or fences", () => {
		const raw = 'Sure! Here it is:\n```json\n{"summary":"Payments-first summary.","experienceOrder":["Designer — Beta"]}\n```'
		const plan = parseTailoringPlan(raw, profile)
		expect(plan?.summary).toBe("Payments-first summary.")
		expect(plan?.experienceOrder).toEqual(["Designer — Beta"])
	})

	it("drops entry titles that are not in the CV", () => {
		const raw = JSON.stringify({
			summary: "s",
			experienceOrder: ["Ghost Writer — Nowhere", "Software Engineer — Acme"],
			entryDetails: {
				"Ghost Writer — Nowhere": ["invented"],
				"Software Engineer — Acme": ["Built a payments platform with TypeScript."],
			},
		})
		const plan = parseTailoringPlan(raw, profile)
		expect(plan?.experienceOrder).toEqual(["Software Engineer — Acme"])
		expect(plan?.entryDetails && "Ghost Writer — Nowhere" in plan.entryDetails).toBe(
			false,
		)
	})

	it("never grows an entry beyond its own bullet count", () => {
		const raw = JSON.stringify({
			entryDetails: {
				"Designer — Beta": [
					"one",
					"two",
					"three invented",
					"four invented",
					"five invented",
				],
			},
		})
		const plan = parseTailoringPlan(raw, profile)
		expect(plan?.entryDetails?.["Designer"]).toHaveLength(1)
	})

	it("cuts STAR bullets to the entry's own count and drops duplicates", () => {
		const raw = JSON.stringify({
			entryDetails: {
				"Software Engineer — Acme": [
					"To unblock payments, rebuilt the ledger in TypeScript, lifting throughput 40%.",
					"To unblock payments, rebuilt the ledger in TypeScript, lifting throughput 40%.",
					"Facing a hiring freeze, led three engineers anyway, shipping two products.",
					"Under deadline pressure, migrated Postgres schemas with zero downtime.",
					"a fifth bullet that must be cut",
					"a sixth bullet that must be cut",
				],
				"Designer — Beta": [
					"Redesigning checkout, cut drop-off 15% with Figma prototypes.",
					"Redesigning checkout, cut drop-off 15% with Figma prototypes.",
					"third bullet that must be cut",
				],
			},
		})
		const plan = parseTailoringPlan(raw, profile)
		const acme = plan?.entryDetails?.["Software Engineer"] ?? []
		// The entry owns two bullets: tailoring trims, it cannot pad.
		expect(acme).toHaveLength(2)
		expect(new Set(acme.map((b) => b.toLowerCase())).size).toBe(2)
		expect(acme.some((b) => b.includes("fifth"))).toBe(false)
	})

	it("returns null for non-JSON or plans that tailor nothing", () => {
		expect(parseTailoringPlan("I cannot help with that", profile)).toBeNull()
		expect(parseTailoringPlan("{}", profile)).toBeNull()
		expect(parseTailoringPlan(null, profile)).toBeNull()
	})
})

describe("applyTailoring", () => {
	it("reorders entries and replaces details, keeping the rest at the end", () => {
		const tailored = applyTailoring(profile, {
			experienceOrder: ["Designer — Beta", "Software Engineer — Acme"],
			entryDetails: {
				Designer: ["Designed mobile interfaces, rephrased for this role."],
			},
		})
		expect(tailored.experience.map((entry) => entry.title)).toEqual([
			"Designer",
			"Software Engineer",
		])
		expect(tailored.experience[0]?.details).toEqual([
			"Designed mobile interfaces, rephrased for this role.",
		])
		expect(tailored.experience[1]?.details).toEqual(profile.experience[0]?.details)
	})

	it("leaves the profile untouched without a plan", () => {
		expect(applyTailoring(profile, null)).toEqual(profile)
	})
})

describe("tailored cover letter", () => {
	it("uses the model's paragraphs, still escaped", () => {
		const tex = renderCoverLetterTex(profile, { title: "", company: "", location: "", keywords: [] }, [
			"Led payments work at Acme, which matches your role & stack.",
		])
		expect(tex).toContain("Led payments work at Acme, which matches your role \\& stack.")
		expect(tex).not.toContain("I am applying for the")
	})

	it("falls back to the template body", () => {
		const tex = renderCoverLetterTex(profile, {
			title: "Engineer",
			company: "Gamma",
			location: "",
			keywords: [],
		})
		expect(tex).toContain("I am applying for the Engineer role at Gamma.")
	})
})

describe("buildTailorPrompt", () => {
	it("forbids invention and demands bare JSON", () => {
		const prompt = buildTailorPrompt("cv", "job")
		expect(prompt.system).toContain("Never invent")
		expect(prompt.system).toContain("ONLY a JSON object")
		expect(prompt.user).toContain("# Base CV")
		expect(prompt.user).toContain("# Job posting")
	})

	it("asks for cut-down STAR bullets fitted to the posting", () => {
		const prompt = buildTailorPrompt("cv", "job")
		expect(prompt.system).toContain("STAR")
		expect(prompt.system).toContain("Result")
		expect(prompt.system).toContain("Cover the posting")
	})

	it("names the missed requirements on the coverage redo", () => {
		const prompt = buildTailorPrompt("cv", "job", ["kubernetes", "graphql"])
		expect(prompt.user).toContain("Coverage check on your previous plan")
		expect(prompt.user).toContain("- kubernetes")
		expect(prompt.user).toContain("- graphql")
	})
})

describe("tailorCoverage", () => {
	it("counts posting keywords carried by the tailored document", () => {
		const plan = {
			summary: "Payments engineer fluent in typescript and postgres.",
			experienceOrder: ["Software Engineer"],
			entryDetails: {
				"Software Engineer": [
					"To move money faster, rebuilt the ledger in typescript, lifting throughput 40%.",
				],
			},
			coverLetterParagraphs: [],
		}
		const coverage = tailorCoverage(profile, plan, {
			keywords: ["typescript", "postgres", "kubernetes"],
		})
		expect(coverage.covered).toBe(2)
		expect(coverage.total).toBe(3)
		expect(coverage.missing).toEqual(["kubernetes"])
	})

	it("ends a run-on summary and bullets at a sentence boundary", () => {
		const raw = JSON.stringify({
			summary:
				"Strong backend engineer. Deep in payments ledgers and high-throughput APIs with a record of mentoring small teams across postgresql, go and typescript building scalable platforms",
			entryDetails: {
				"Software Engineer — Acme": [
					"To unblock payments, rebuilt the ledger in TypeScript, lifting throughput 40%, and later migrated the whole reconciliation pipeline to postgres with zero downtime while mentoring the team through the migration",
				],
			},
		})
		const plan = parseTailoringPlan(raw, profile)
		// The clamp cuts the run-on sentences; the shipped text must end on a
		// completed sentence, never mid-thought.
		expect(plan?.summary?.endsWith(".")).toBe(true)
		const acme = plan?.entryDetails?.["Software Engineer"] ?? []
		expect(acme[0]?.endsWith(".")).toBe(true)
	})

	it("cuts a summary that dangles on a function word back to the last sentence", () => {
		const raw = JSON.stringify({
			summary:
				"High-throughput payments engineer. Confident in my ability to contribute to the development of",
		})
		const plan = parseTailoringPlan(raw, profile)
		expect(plan?.summary).toBe("High-throughput payments engineer.")
	})

	it("measures the un-tailored profile when there is no plan", () => {
		const coverage = tailorCoverage(profile, null, {
			keywords: ["typescript"],
		})
		// The base CV bullet names TypeScript.
		expect(coverage.missing).toEqual([])
	})
})