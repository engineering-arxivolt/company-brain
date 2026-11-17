import { describe, expect, it } from "vitest"
import {
	careerOptionsAsk,
	OPTIONS_TTL_MS,
	optionAsEdit,
	optionPick,
	parseBulletOptions,
	pendingOptionsFresh,
	renderBulletOptions,
	renderOptionsKept,
	toPendingOptions,
} from "./options"
import { parseCareerProfile } from "./profile"

const BASE = `# Base CV — Joseph Test

## Experience

**Software Engineer — Acme** (2020 – Present)
- Cut API calls 50% by refactoring the data-fetching path.
- Led a team of three engineers across two products.

**Software Developer — LanguaTalk Inc.** (2023 – 2024)
- Built learning interfaces for language learners.

**Software Developer — AdanianLabs** (2022 – 2023)
- Built USSD commerce for farmers.
`

const profile = parseCareerProfile(BASE)

const option = (text: string, why = "leads with the result the posting asks for") => ({
	text,
	why,
})

describe("careerOptionsAsk", () => {
	it("recognises an ask for alternatives", () => {
		expect(careerOptionsAsk("give me options for bullet 2 under Acme")).toBeTruthy()
		expect(careerOptionsAsk("alternatives for the GRIFFIN summary")).toBeTruthy()
		expect(careerOptionsAsk("show me three versions of that bullet")).toBeTruthy()
	})

	it("leaves builds and ordinary edits alone", () => {
		expect(careerOptionsAsk("make me a CV for this job")).toBeNull()
		expect(careerOptionsAsk("change the date to 2022")).toBeNull()
		expect(careerOptionsAsk(`options ${"x".repeat(700)}`)).toBeNull()
	})
})

describe("optionPick", () => {
	it("reads a choice", () => {
		expect(optionPick("2", 3)).toBe(2)
		expect(optionPick("use option 2", 3)).toBe(2)
		expect(optionPick("the second one", 3)).toBe(2)
		expect(optionPick("go with #3", 3)).toBe(3)
	})

	it("reads a refusal", () => {
		expect(optionPick("keep", 3)).toBe("keep")
		expect(optionPick("none of them", 3)).toBe("keep")
		expect(optionPick("leave it", 3)).toBe("keep")
	})

	it("never mistakes a real instruction for a pick", () => {
		expect(optionPick("change the date to 2024", 3)).toBeNull()
		expect(optionPick("shorten 2 bullets", 3)).toBeNull()
		expect(optionPick("5", 3)).toBeNull()
		expect(optionPick("which one is best?", 3)).toBeNull()
	})
})

describe("pendingOptionsFresh", () => {
	const pending = toPendingOptions({
		entry: profile.experience[0]!,
		index: 1,
		options: [
			{ text: "a", why: "b" },
			{ text: "c", why: "d" },
		],
		now: 1_000,
	})

	it("expires an old offer", () => {
		expect(pendingOptionsFresh(pending, 1_000 + OPTIONS_TTL_MS - 1)).toBe(true)
		expect(pendingOptionsFresh(pending, 1_000 + OPTIONS_TTL_MS + 1)).toBe(false)
		expect(pendingOptionsFresh(undefined)).toBe(false)
	})
})

describe("optionAsEdit", () => {
	it("turns a pick into an ordinary set-bullet edit", () => {
		const pending = toPendingOptions({
			entry: profile.experience[0]!,
			index: 2,
			options: [
				{ text: "Led five engineers.", why: "names the scope" },
				{ text: "Led a team.", why: "shorter" },
			],
		})
		expect(optionAsEdit(pending, 1)).toEqual({
			op: "set-bullet",
			entry: "Software Engineer — Acme",
			index: 2,
			text: "Led five engineers.",
		})
		expect(optionAsEdit(pending, 9)).toBeNull()
	})
})

describe("parseBulletOptions", () => {
	const reply = (options: unknown[], entry = "Acme", index = 1) =>
		JSON.stringify({ entry, index, options })

	it("keeps options that survive every check, with their signals", () => {
		const parsed = parseBulletOptions(
			reply([
				option("Cut API calls 50% by caching responses."),
				option("Refactored the data-fetching path, halving API calls."),
			]),
			profile,
			{ keywords: ["caching", "api"] },
		)
		expect(parsed.rejected).toEqual([])
		expect(parsed.options).toHaveLength(2)
		expect(parsed.options[0]?.signals.keepsOriginalMetric).toBe(true)
		expect(parsed.options[0]?.signals.adds).toContain("caching")
		expect(parsed.index).toBe(1)
	})

	it("withholds an option that invents a number", () => {
		const parsed = parseBulletOptions(
			reply([
				option("Cut API calls 80% by caching responses."),
				option("Cut API calls 50% by caching responses."),
			]),
			profile,
		)
		expect(parsed.rejected.join(" ")).toContain("invents the number 80")
		// One usable option is not a choice.
		expect(parsed.options).toEqual([])
	})

	it("withholds a duty-phrase opener, a duplicate and a reasonless option", () => {
		const parsed = parseBulletOptions(
			reply([
				option("Responsible for refactoring the data-fetching path."),
				option("Cut API calls 50% by refactoring the data-fetching path."),
				option("Halved API calls by caching responses.", "better"),
				option("Halved API calls by batching requests."),
			]),
			profile,
		)
		const why = parsed.rejected.join(" ")
		expect(why).toContain("duty phrase")
		expect(why).toContain("duplicate")
		expect(why).toContain("no usable reason")
	})

	it("refuses to guess between two jobs that share a title", () => {
		const parsed = parseBulletOptions(
			reply(
				[
					option("Built USSD commerce for 10 farmers."),
					option("Built USSD commerce for farmers, faster."),
				],
				"Software Developer",
				1,
			),
			profile,
		)
		expect(parsed.options).toEqual([])
		expect(parsed.rejected[0]).toContain("names 2 entries")
	})

	it("reports a bullet number that does not exist", () => {
		const parsed = parseBulletOptions(
			reply(
				[option("Cut API calls 50% by caching."), option("Halved API calls.")],
				"Acme",
				9,
			),
			profile,
		)
		expect(parsed.rejected[0]).toContain("bullet 9 does not exist")
	})
})

describe("rendering the offer", () => {
	it("gives each option a reason and the machine checks beside it", () => {
		const parsed = parseBulletOptions(
			JSON.stringify({
				entry: "Acme",
				index: 1,
				options: [
					option(
						"Cut API calls 50% by caching responses.",
						"keeps the 50% the posting asks for; drops the CI detail",
					),
					option(
						"Refactored data fetching to halve API calls.",
						"leads with the action; the metric moves to the end",
					),
				],
			}),
			profile,
			{ keywords: ["caching"] },
		)
		const block = renderBulletOptions({
			entry: "Software Engineer — Acme",
			index: 1,
			total: 2,
			original: profile.experience[0]?.details[0] ?? "",
			options: parsed.options,
			rejected: parsed.rejected,
		})
		expect(block).toContain('1. "Cut API calls 50% by caching responses."')
		expect(block).toContain("Why: keeps the 50% the posting asks for")
		expect(block).toContain("keeps the original 50")
		expect(block).toContain('names "caching"')
		expect(block).toContain("reply 1-2")
		expect(block).toContain("Nothing has been applied and no document was rebuilt")
		expect(block).toContain("Do not choose for the asker")
	})

	it("says plainly when nothing usable came back", () => {
		const block = renderBulletOptions({
			entry: "Software Engineer — Acme",
			index: 1,
			total: 2,
			original: "x",
			options: [],
			rejected: ["no usable options came back"],
		})
		expect(block).toContain("No usable alternative came back")
		expect(block).toContain("Withheld:")
		expect(block).not.toContain("1.")
	})

	it("confirms a keep without re-offering", () => {
		expect(renderOptionsKept()).toContain("keep the bullet as it is")
	})
})

