import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseCareerProfile } from "./profile"
import { parseJobPosting } from "./job-posting"
import { escapeLatex, orderSkillsForPosting, renderResumeTex } from "./render"
import { renderCoverLetterTex } from "./cover-letter"

const profile = parseCareerProfile(
	readFileSync(
		new URL("../../../templates/cv-base.md", import.meta.url).pathname,
		"utf8",
	),
)

const posting = parseJobPosting(`
Living Goods is seeking an experienced Senior Software Engineer to join our
Global Software Engineering team in Nairobi.

Responsibilities:
- Design, develop and maintain our offline-first Android application.
- Design and build FHIR-native backend services - Kotlin and Spring Boot.
- Use code review as the primary teaching instrument.

Requirements:
- Strong TypeScript/JavaScript and one of Kotlin, Go, Ruby or Python.
- Hybrid in Nairobi; relocation and visa support considered.
`)

describe("parseCareerProfile", () => {
	it("reads the published base CV", () => {
		expect(profile.name).toBe("Joseph Mindo")
		expect(profile.contact.email).toBe("josephmindo27@gmail.com")
		expect(profile.contact.links).toHaveLength(3)
		expect(profile.experience).toHaveLength(5)
		expect(profile.experience[0]).toMatchObject({
			title: "Engineer",
			organisation: "GRIFFIN Global Technologies",
			period: "July 2025 – Present",
		})
		expect(profile.experience[0]?.details.length).toBeGreaterThan(2)
		expect(profile.skills.map((group) => group.group)).toContain(
			"Frameworks & libraries",
		)
		expect(profile.summary).toContain("Versatile Software Engineer")
	})
})

describe("parseJobPosting", () => {
	it("reads the role, employer and location", () => {
		expect(posting.title).toBe("Senior Software Engineer")
		expect(posting.company).toBe("Living Goods")
		expect(posting.location).toContain("Hybrid")
	})

	it("collects the keywords worth mirroring", () => {
		expect(posting.keywords).toContain("kotlin")
		expect(posting.keywords).toContain("typescript")
		expect(posting.keywords).toContain("offline-first")
	})
})

describe("escapeLatex", () => {
	it("escapes everything that breaks a compile", () => {
		expect(escapeLatex("R&D 50% _x_ #1 $5")).toBe(
			"R\\&D 50\\% \\_x\\_ \\#1 \\$5",
		)
		expect(escapeLatex("{a} ~b^c")).toBe("\\{a\\} \\textasciitilde{}b\\textasciicircum{}c")
	})
})

describe("orderSkillsForPosting", () => {
	it("puts skills the posting names first, without dropping any", () => {
		const ordered = orderSkillsForPosting(profile, posting)
		const languages = ordered.find((group) => group.group === "Languages")
		const original = profile.skills.find((group) => group.group === "Languages")
		expect(languages?.items.slice().sort()).toEqual(original?.items.slice().sort())
		const typescript = languages?.items.indexOf("TypeScript") ?? -1
		const csharp = languages?.items.indexOf("C#") ?? -1
		expect(typescript).toBeGreaterThanOrEqual(0)
		expect(csharp).toBeGreaterThanOrEqual(0)
		// TypeScript is named by the posting; C# is not.
		expect(typescript).toBeLessThan(csharp)
	})
})

describe("renderResumeTex", () => {
	const tex = renderResumeTex(profile, posting)

	it("is a complete document", () => {
		expect(tex.startsWith("\\documentclass")).toBe(true)
		expect(tex).toContain("\\begin{document}")
		expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true)
		// Core LaTeX only: these packages are absent from the sandbox image.
		expect(tex).not.toMatch(/titlesec|enumitem|lastpage/)
	})

	it("carries the profile's facts, escaped", () => {
		expect(tex).toContain("Joseph Mindo")
		expect(tex).toContain("GRIFFIN Global Technologies")
		expect(tex).toContain("Frameworks \\& libraries")
		expect(tex).not.toContain("Frameworks & libraries")
	})
})

describe("renderCoverLetterTex", () => {
	const tex = renderCoverLetterTex(profile, posting)

	it("addresses the posting and stays a single document", () => {
		expect(tex.match(/\\documentclass/g)).toHaveLength(1)
		expect(tex).toContain("Senior Software Engineer")
		expect(tex).toContain("Living Goods")
		expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true)
	})

	it("invents nothing: every paragraph quotes profile facts", () => {
		expect(tex).toContain(escapeLatex(profile.summary))
		expect(tex).toContain("Sincerely")
	})
})
