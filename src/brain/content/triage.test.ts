import { describe, expect, it, vi } from "vitest"
import { auditArticle } from "./quality"
import {
	type SystemOneAsker,
	classifyIntake,
	fallbackDraftRisk,
	fallbackIntake,
	fallbackKeywordIntent,
	labelKeywordIntent,
	triageDraftRisk,
} from "./triage"

const confident = (choice: string, confidence = 0.92) => vi.fn(async () => ({ choice, confidence }))

describe("fallbackIntake", () => {
	it("routes the five intents without a model", () => {
		expect(fallbackIntake("write a deep dive on CNVA")).toBe("brief")
		expect(fallbackIntake("refresh the kra penalties page")).toBe("refresh")
		expect(fallbackIntake("what is live right now?")).toBe("status")
		expect(fallbackIntake("make me a campaign pack for LinkedIn")).toBe("social")
		expect(fallbackIntake("unpublish the old etims page")).toBe("kill")
	})

	it("defaults to brief when nothing matches", () => {
		expect(fallbackIntake("cnva")).toBe("brief")
	})

	it("lets an explicit kill beat a status word", () => {
		expect(fallbackIntake("status: take down the duplicate page")).toBe("kill")
	})
})

describe("classifyIntake", () => {
	it("uses System 1 when it is confident", async () => {
		const ask = confident("refresh")
		const result = await classifyIntake("the kra page is stale", ask)
		expect(result).toEqual({ value: "refresh", confidence: 0.92, via: "system1" })
		expect(ask).toHaveBeenCalledTimes(1)
	})

	it("falls back when confidence is below the floor", async () => {
		const result = await classifyIntake("refresh the kra page", confident("social", 0.4))
		expect(result).toEqual({ value: "refresh", confidence: 0, via: "fallback" })
	})

	it("falls back on an unknown label or a thrown call", async () => {
		expect((await classifyIntake("refresh it", confident("not-a-label"))).via).toBe("fallback")
		const boom: SystemOneAsker = async () => {
			throw new Error("jev down")
		}
		expect((await classifyIntake("refresh it", boom)).value).toBe("refresh")
	})

	it("works with no asker at all", async () => {
		expect(await classifyIntake("what is live?")).toEqual({ value: "status", confidence: 0, via: "fallback" })
	})
})

describe("fallbackKeywordIntent", () => {
	it("separates buyers from researchers", () => {
		expect(fallbackKeywordIntent("hire etims integrator nairobi")).toBe("transactional")
		expect(fallbackKeywordIntent("etims software price")).toBe("transactional")
		expect(fallbackKeywordIntent("best etims software")).toBe("commercial")
		expect(fallbackKeywordIntent("how to file a nil return")).toBe("informational")
		expect(fallbackKeywordIntent("itax login")).toBe("navigational")
		expect(fallbackKeywordIntent("cnva")).toBe("informational")
	})
})

describe("labelKeywordIntent", () => {
	it("prefers a confident System 1 label over the regex", async () => {
		expect(await labelKeywordIntent("kra nil return", confident("transactional"))).toEqual({
			value: "transactional",
			confidence: 0.92,
			via: "system1",
		})
	})
})

function cleanAudit() {
	return auditArticle({
		slug: "clean-page",
		title: "A clean page about Kenya compliance",
		metaDescription:
			"A description long enough to sit inside the preferred band, written for a Kenyan operator who needs the deadline and the evidence file.",
		markdown: `# Clean\n\n${"word ".repeat(320)}\n\n[a](/a) [b](/b) [c](/c)`,
		faq: [
			{ q: "a", a: "b" },
			{ q: "c", a: "d" },
			{ q: "e", a: "f" },
		],
	})
}

describe("fallbackDraftRisk", () => {
	it("is none for a clean audit", () => {
		expect(fallbackDraftRisk(cleanAudit())).toBe("none")
	})

	it("calls an unsupported figure a claim problem", () => {
		const dirty = auditArticle({
			slug: "dirty",
			title: "A page with an invented penalty figure",
			metaDescription: "A description long enough to sit inside the preferred band, written for a Kenyan operator who needs the numbers.",
			markdown: `# One\n\n# Two\n\nKES 9,000,000 applies.\n\n${"word ".repeat(320)}`,
		})
		expect(fallbackDraftRisk(dirty)).toBe("claim")
	})
})

describe("triageDraftRisk", () => {
	it("never asks the model when a gate already failed", async () => {
		const dirty = auditArticle({ slug: "d", title: "Short", metaDescription: "x", markdown: "# One\n\n# Two" })
		const ask = confident("voice")
		const result = await triageDraftRisk(dirty, ask)
		expect(result.via).toBe("fallback")
		expect(result.confidence).toBe(1)
		expect(ask).not.toHaveBeenCalled()
	})

	it("asks the model only about a passage of clean drafts", async () => {
		const result = await triageDraftRisk(cleanAudit(), confident("voice"))
		expect(result).toEqual({ value: "voice", confidence: 0.92, via: "system1" })
	})

	it("defaults to none without an asker", async () => {
		expect(await triageDraftRisk(cleanAudit())).toEqual({ value: "none", confidence: 0, via: "fallback" })
	})
})
