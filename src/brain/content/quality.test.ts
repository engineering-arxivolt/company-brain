import { describe, expect, it } from "vitest"
import { auditArticle, contentHash, figuresIn, summariseAudit, unsupportedFigures } from "./quality"

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ")

function article(over: Partial<Parameters<typeof auditArticle>[0]> = {}) {
	return auditArticle({
		slug: "kra-nil-return-kenya",
		title: "KRA nil returns in Kenya: what to file when you had no sales",
		metaDescription:
			"A practical guide to KRA nil returns for Kenyan companies: who must file, the deadlines, the penalties for missing them, and the evidence to keep.",
		markdown: `# KRA nil returns in Kenya\n\n${words(320)}\n\n## What counts as nil\n\n${words(60)}\n\nSee [the penalties guide](/kra-penalties-kenya), [eTIMS](/etims-compliance) and [the pillar](/guides/kra-obligations).\n`,
		faq: [
			{ q: "Is a nil return still a return?", a: "Yes." },
			{ q: "What is the deadline?", a: "The 20th." },
			{ q: "What if I file late?", a: "A penalty applies." },
		],
		...over,
	})
}

describe("contentHash", () => {
	it("is stable for the same text and changes with it", () => {
		expect(contentHash("abc")).toBe(contentHash("abc"))
		expect(contentHash("abc")).not.toBe(contentHash("abd"))
		expect(contentHash("abc")).toMatch(/^[0-9a-f]{8}$/)
	})
})

describe("figuresIn", () => {
	it("finds money, percentages and thousands separators", () => {
		const found = figuresIn("A penalty of KES 2,000,000 applies, plus 16% VAT and a $500 fee on 1,234 filings.")
		expect(found).toContain("KES 2,000,000")
		expect(found).toContain("16%")
		expect(found).toContain("$500")
		expect(found).toContain("1,234")
	})
})

describe("unsupportedFigures", () => {
	it("accepts a figure the evidence pack holds, whatever its formatting", () => {
		expect(unsupportedFigures("The penalty is KES 2,000,000.", ["2000000"])).toEqual([])
		expect(unsupportedFigures("The rate is 16%.", ["KES 16"])).toEqual([])
	})

	it("rejects an unowned number that reads like fact", () => {
		expect(unsupportedFigures("The penalty is KES 2,000,000.", [])).toEqual(["KES 2,000,000"])
	})

	it("allows a citation at the point of use", () => {
		expect(unsupportedFigures("The penalty is KES 2,000,000[^1].", [])).toEqual([])
		expect(unsupportedFigures("The penalty is KES 2,000,000 ([KRA](https://kra.go.ke/x)).", [])).toEqual([])
	})
})

describe("auditArticle", () => {
	it("passes a well-formed article", () => {
		const audit = article()
		expect(audit.ok).toBe(true)
		expect(audit.h1Count).toBe(1)
		expect(audit.internalLinks).toBe(3)
		expect(audit.faqCount).toBe(3)
		expect(audit.words).toBeGreaterThan(300)
		expect(summariseAudit(audit)).toContain("PASS kra-nil-return-kenya")
	})

	it("blocks a second H1", () => {
		const audit = article({ markdown: `# One\n\n# Two\n\n${words(320)}\n\n[a](/a) [b](/b) [c](/c)` })
		expect(audit.ok).toBe(false)
		expect(audit.findings.map((f) => f.code)).toContain("h1")
	})

	it("accepts markdown with no H1, because the page template owns it", () => {
		const audit = article({ markdown: `${words(320)}\n\n[a](/a) [b](/b) [c](/c)` })
		expect(audit.h1Count).toBe(0)
		expect(audit.findings.map((f) => f.code)).not.toContain("h1")
		expect(audit.ok).toBe(true)
	})

	it("blocks a short article", () => {
		const audit = article({ markdown: `# One\n\n${words(40)}\n\n[a](/a) [b](/b) [c](/c)` })
		expect(audit.findings.find((f) => f.code === "words")?.severity).toBe("error")
	})

	it("blocks meta outside the hard band and warns inside the soft one", () => {
		const short = article({ metaDescription: "too short" })
		expect(short.findings.find((f) => f.code === "meta")?.severity).toBe("error")
		const narrow = article({ metaDescription: `${words(30)}`.slice(0, 100) })
		expect(narrow.findings.find((f) => f.code === "meta_band")?.severity).toBe("warning")
	})

	it("blocks an unsupported figure", () => {
		const audit = article({
			markdown: `# One\n\nA fine of KES 900,000 applies.\n\n${words(320)}\n\n[a](/a) [b](/b) [c](/c)`,
		})
		expect(audit.ok).toBe(false)
		expect(audit.unsupportedFigures).toContain("KES 900,000")
	})

	it("warns instead of blocking when links or FAQ are thin", () => {
		const audit = article({ markdown: `# One\n\n${words(320)}`, faq: [] })
		const codes = audit.findings.filter((f) => f.severity === "warning").map((f) => f.code)
		expect(codes).toContain("internal_links")
		expect(codes).toContain("faq")
		expect(audit.ok).toBe(true)
	})

	it("reports a stable hash for identical input", () => {
		expect(article().hash).toBe(article().hash)
	})
})
