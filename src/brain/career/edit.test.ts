import { describe, expect, it } from "vitest"
import {
	type CvEdit,
	applyCvEdits,
	buildCvEditPrompt,
	careerEditInstruction,
	isFactEdit,
	parseCvEditPlan,
	renderCareerEditContext,
} from "./edit"
import { parseCareerProfile, renderCareerProfileMarkdown } from "./profile"

const BASE = `# Base CV — Joseph Test

## Contact

- Location: Nairobi, Kenya
- Email: joseph@example.com
- Phone: +254700000000
- LinkedIn: linkedin.com/in/joseph
- Availability: open to relocation; remote-first

## Professional summary

Software engineer with five years of experience.

## Experience

**Software Engineer — Acme** (2020 – Present)
- Built a payments platform with TypeScript and Postgres.
- Led a team of three engineers across two products.

**Designer — Beta** (2018 – 2020)
- Designed mobile interfaces in Figma.

## Key projects

**Alpha** (2024 – Present; Go, etcd)
A container platform.

## Education

- BSc Computer Science — Test University

## Skills

- **Languages:** TypeScript, Go
- **Databases:** PostgreSQL

## References

- Alex — Acme — alex@example.com
`

const profile = parseCareerProfile(BASE)

describe("careerEditInstruction", () => {
	it("recognises a change to an existing CV", () => {
		expect(
			careerEditInstruction("change the date on my CV to Jan 2022"),
		).toBeTruthy()
		expect(
			careerEditInstruction("shorten the second bullet under Nathan"),
		).toBeTruthy()
		expect(
			careerEditInstruction("fix the phone number, it is +254711111111"),
		).toBeTruthy()
		expect(careerEditInstruction("rewrite the summary in a plainer tone")).toBeTruthy()
	})

	it("does not mistake a build ask or a thank-you for an edit", () => {
		expect(careerEditInstruction("make me a CV for this job")).toBeNull()
		expect(careerEditInstruction("tailor my CV for the Living Goods role")).toBeNull()
		expect(careerEditInstruction("thanks")).toBeNull()
		// A verb with no CV thing named is a fresh build, not a patch.
		expect(careerEditInstruction("update my CV")).toBeNull()
		// A pasted posting is longer than any instruction.
		expect(careerEditInstruction(`change ${"x".repeat(700)}`)).toBeNull()
	})

	it("reads an accented résumé edit", () => {
		expect(careerEditInstruction("change the dates on my résumé")).toBeTruthy()
	})
})

describe("parseCvEditPlan", () => {
	it("reads a fenced array", () => {
		const raw = [
			"Here you go:",
			"```json",
			'[{"op":"set-entry","entry":"Designer","period":"September 2018 – June 2020"}]',
			"```",
		].join("\n")
		const { edits, dropped } = parseCvEditPlan(raw)
		expect(dropped).toBe(0)
		expect(edits).toEqual([
			{
				op: "set-entry",
				entry: "Designer",
				period: "September 2018 – June 2020",
			},
		])
	})

	it("accepts numeric strings for indexes", () => {
		const { edits } = parseCvEditPlan(
			'[{"op":"set-bullet","entry":"Designer","index":"1","text":"New line."}]',
		)
		expect(edits).toEqual([
			{ op: "set-bullet", entry: "Designer", index: 1, text: "New line." },
		])
	})

	it("drops shapes it cannot apply instead of throwing", () => {
		const { edits, dropped } = parseCvEditPlan(
			'[{"op":"unknown","entry":"Designer"},{"op":"set-entry"}]',
		)
		expect(edits).toEqual([])
		expect(dropped).toBe(2)
		expect(parseCvEditPlan("not json at all")).toEqual({ edits: [], dropped: 0 })
	})
})

describe("applyCvEdits", () => {
	it("changes a date and leaves every other fact alone", () => {
		const outcome = applyCvEdits(profile, [
			{
				op: "set-entry",
				entry: "Designer",
				period: "September 2018 – June 2020",
			},
		])
		expect(outcome.applied[0]).toContain("Designer")
		expect(outcome.applied[0]).toContain("dates → September 2018 – June 2020")
		const designer = outcome.profile.experience.find(
			(entry) => entry.title === "Designer",
		)
		expect(designer?.period).toBe("September 2018 – June 2020")
		// The input is untouched, so a rejected edit can never half-apply.
		expect(profile.experience[0]?.period).toBe("2020 – Present")
		expect(outcome.touched).toEqual({ cv: true, letter: false })
	})

	it("replaces part of one bullet", () => {
		const outcome = applyCvEdits(profile, [
			{
				op: "replace-in-bullet",
				entry: "Software Engineer",
				find: "payments platform",
				text: "billing platform",
			},
		])
		expect(outcome.rejected).toEqual([])
		expect(outcome.profile.experience[0]?.details[0]).toBe(
			"Built a billing platform with TypeScript and Postgres.",
		)
	})

	it("refuses an ambiguous find instead of guessing", () => {
		const outcome = applyCvEdits(profile, [
			{
				op: "replace-in-bullet",
				entry: "Software Engineer",
				find: "a",
				text: "the",
			},
		])
		expect(outcome.applied).toEqual([])
		expect(outcome.rejected[0]).toContain("more than one bullet")
	})

	it("names the entries when the title does not match", () => {
		const outcome = applyCvEdits(profile, [
			{ op: "set-entry", entry: "Google", period: "2024" },
		])
		expect(outcome.applied).toEqual([])
		expect(outcome.rejected[0]).toContain('no experience entry matches "Google"')
		expect(outcome.rejected[0]).toContain("Software Engineer — Acme")
		expect(outcome.rejected[0]).toContain("Designer — Beta")
	})

	it("rejects a bullet index that does not exist", () => {
		const outcome = applyCvEdits(profile, [
			{ op: "set-bullet", entry: "Designer", index: 4, text: "Nope." },
		])
		expect(outcome.rejected[0]).toContain("bullet 4 does not exist")
	})

	it("keeps at least one bullet under an entry", () => {
		const outcome = applyCvEdits(profile, [
			{ op: "remove-bullet", entry: "Designer", index: 1 },
		])
		expect(outcome.applied).toEqual([])
		expect(outcome.rejected[0]).toContain("one bullet left")
	})

	it("adds a skill group rather than dropping the unknown one", () => {
		const outcome = applyCvEdits(profile, [
			{ op: "set-skills", group: "Cloud", items: ["Cloudflare Workers"] },
		])
		expect(outcome.rejected).toEqual([])
		expect(outcome.profile.skills.at(-1)).toEqual({
			group: "Cloud",
			items: ["Cloudflare Workers"],
		})
	})

	it("routes a letter rewrite to the letter, not the CV", () => {
		const outcome = applyCvEdits(profile, [
			{ op: "set-letter-paragraphs", paragraphs: ["One paragraph.", "Two."] },
		])
		expect(outcome.touched).toEqual({ cv: false, letter: true })
		expect(outcome.coverLetterParagraphs).toEqual(["One paragraph.", "Two."])
	})

	it("is safe to re-apply: a repeated date change is a no-op", () => {
		const once = applyCvEdits(profile, [
			{ op: "set-entry", entry: "Designer", period: "2018 – 2020" },
		])
		const twice = applyCvEdits(once.profile, [
			{ op: "set-entry", entry: "Designer", period: "2018 – 2020" },
		])
		expect(twice.applied[0]).toContain("already as asked")
		expect(twice.rejected).toEqual([])
	})

	it("closes an over-long bullet instead of shipping it cut mid-word", () => {
		const long = `${"Delivered measurable improvements to the payments platform ".repeat(8)}of`
		const outcome = applyCvEdits(profile, [
			{ op: "add-bullet", entry: "Designer", text: long },
		])
		const added = outcome.profile.experience[1]?.details.at(-1) ?? ""
		expect(added.length).toBeLessThanOrEqual(400)
		expect(added.endsWith(".")).toBe(true)
		// A dangling function word must never be the last thing on the line.
		expect(added).not.toMatch(/\b(of|and|the|to|for)\.$/)
	})
})

// The real base CV has two entries titled "Software Developer" (LanguaTalk Inc.
// and AdanianLabs), so a date edit must be able to name the employer — and must
// refuse to guess when it is given only the shared title.
const DUPES = `# Base CV — Joseph Test

## Experience

**Software Developer — LanguaTalk Inc.** (August 2023 – August 2024)
- Built learning interfaces.

**Software Developer — AdanianLabs** (June 2022 – July 2023)
- Built USSD commerce.
`

const dupes = parseCareerProfile(DUPES)

describe("date targeting when titles repeat", () => {
	it("accepts the employer as the entry name", () => {
		const outcome = applyCvEdits(dupes, [
			{ op: "set-entry", entry: "AdanianLabs", period: "Jan 2022 – Dec 2023" },
		])
		expect(outcome.rejected).toEqual([])
		expect(outcome.applied[0]).toContain("Software Developer — AdanianLabs")
		expect(outcome.applied[0]).toContain("dates → Jan 2022 – Dec 2023")
		const adanian = outcome.profile.experience.find(
			(entry) => entry.organisation === "AdanianLabs",
		)
		const langua = outcome.profile.experience.find(
			(entry) => entry.organisation === "LanguaTalk Inc.",
		)
		expect(adanian?.period).toBe("Jan 2022 – Dec 2023")
		expect(langua?.period).toBe("August 2023 – August 2024")
	})

	it("asks instead of guessing when a title is shared by two jobs", () => {
		const outcome = applyCvEdits(dupes, [
			{ op: "set-entry", entry: "Software Developer", period: "2020" },
		])
		expect(outcome.applied).toEqual([])
		expect(outcome.rejected[0]).toContain("matches 2 entries")
		expect(outcome.rejected[0]).toContain("LanguaTalk Inc.")
		expect(outcome.rejected[0]).toContain("AdanianLabs")
		// Nothing was changed.
		expect(outcome.profile).toEqual(dupes)
	})

	it("takes the full heading as written on the CV", () => {
		const outcome = applyCvEdits(dupes, [
			{
				op: "set-entry",
				entry: "Software Developer — LanguaTalk Inc.",
				period: "Aug 2023 – Aug 2024",
			},
		])
		expect(outcome.rejected).toEqual([])
		expect(outcome.applied[0]).toContain("Software Developer — LanguaTalk Inc.")
		expect(outcome.applied[0]).toContain("dates → Aug 2023 – Aug 2024")
	})

	it("resolves bullets the same way, and names the employer", () => {
		const outcome = applyCvEdits(dupes, [
			{
				op: "set-bullet",
				entry: "AdanianLabs",
				index: 1,
				text: "Built USSD payments.",
			},
		])
		expect(outcome.rejected).toEqual([])
		expect(outcome.applied[0]).toContain("Software Developer — AdanianLabs")
		expect(
			outcome.profile.experience.find(
				(entry) => entry.organisation === "AdanianLabs",
			)?.details,
		).toEqual(["Built USSD payments."])
	})

	it("lists employer names when nothing matches", () => {
		const outcome = applyCvEdits(dupes, [
			{ op: "set-entry", entry: "Google", period: "2020" },
		])
		expect(outcome.rejected[0]).toContain("Software Developer — LanguaTalk Inc.")
		expect(outcome.rejected[0]).toContain("Software Developer — AdanianLabs")
	})

	it("still matches when the employer is written with a dash and mixed case", () => {
		const outcome = applyCvEdits(dupes, [
			{ op: "set-entry", entry: "adanianlabs", period: "2022 – 2023" },
		])
		expect(outcome.rejected).toEqual([])
	})
})

describe("isFactEdit", () => {
	it("keeps corrections but not per-application rewording", () => {
		const facts: CvEdit[] = [
			{ op: "set-entry", entry: "Designer", period: "2019" },
			{ op: "set-contact", field: "phone", value: "+254711" },
		]
		const presentation: CvEdit[] = [
			{ op: "set-summary", text: "x" },
			{ op: "remove-entry", entry: "Designer" },
			{ op: "add-bullet", entry: "Designer", text: "x" },
			{ op: "move-entry", entry: "Designer", position: 1 },
		]
		expect(facts.every(isFactEdit)).toBe(true)
		expect(presentation.some(isFactEdit)).toBe(false)
	})
})

describe("round trip", () => {
	it("parse → render → parse keeps every fact", () => {
		expect(parseCareerProfile(renderCareerProfileMarkdown(profile))).toEqual(
			profile,
		)
	})
})

describe("prompt and context", () => {
	it("tells the model the ops and the CV", () => {
		const prompt = buildCvEditPrompt(BASE, "change the date")
		expect(prompt.system).toContain("JSON array")
		expect(prompt.system).toContain("set-entry")
		expect(prompt.system).toContain("Never invent")
		expect(prompt.user).toContain("change the date")
		expect(prompt.user).toContain("Software Engineer")
	})

	it("reports what landed and forbids hand-rendering a rejection", () => {
		const block = renderCareerEditContext({
			applied: ["Experience › Designer: dates → 2019"],
			rejected: ['no project matches "Zeta"'],
			documents: [{ fileName: "cv.pdf", pages: 2 }],
		})
		expect(block).toContain("Experience › Designer")
		expect(block).toContain("no project matches")
		expect(block).toContain("cv.pdf (2 pages)")
		expect(block).toContain("Do not rebuild the document")
	})

	it("says nothing changed when nothing applied", () => {
		const block = renderCareerEditContext({
			applied: [],
			rejected: ["bullet 9 does not exist"],
			documents: [],
		})
		expect(block).toContain("none of it could be applied")
		expect(block).not.toContain("were rebuilt")
	})
})
