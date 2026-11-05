import { buildReportCommands, buildReportFiles } from "./deliver-report"
import { describe, expect, it } from "vitest"
import { expectedFactsFromInstruction, validateReportSpec } from "./report"

describe("validateReportSpec", () => {
	const base = {
		title: "EUDR Compliance for Kenyan Coffee Exporters",
		sections: [
			{
				heading: "Data Collection Requirements",
				prose: "Dealers must collect farmer registers, plot geolocation and volumes per lot from every factory before the deadline arrives.",
			},
			{
				heading: "Filing the Due Diligence Statement",
				prose: "The DDS is filed in TRACES before placing coffee on the EU market. Reference numbers travel with every lot.",
			},
			{
				heading: "90-Day Action Plan",
				prose: "Gap analysis in weeks one to four, traceability records by week eight, staff training by week twelve.",
			},
		],
	}

	it("catches the wrong deadline — the failure the live test produced", () => {
		const plan = {
			deliverable: "compliance brief",
			audience: "managing director",
			sections: [],
			tables: [],
			facts: ["the deadline is 30 December 2026"],
			searchQueries: [],
		}
		const verdict = validateReportSpec(
			{ ...base, sections: base.sections.map((s) => ({ ...s, prose: s.prose.replace(/deadline/gi, "30 December 2025 deadline") })) },
			plan,
			"the 30 December 2026 deadline for large and medium operators",
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.failures.some((f) => f.includes("30 December 2026"))).toBe(true)
	})

	it("catches meta-language — describing the document instead of writing it", () => {
		const verdict = validateReportSpec(
			{
				title: "Itinerary",
				sections: [
					{ heading: "Plan", prose: "The itinerary includes a day-by-day plan with activities for each day." },
					{ heading: "Costs", prose: "The total costing table in EUR is not available, as prices are quoted in USD." },
					{ heading: "Flights", prose: "Flight transfers are included in the overall price of the trip for all travellers." },
				],
			},
			null,
			"an 8-day safari itinerary with a costing table in EUR",
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.failures.some((f) => f.includes("meta-language"))).toBe(true)
		// The request said EUR: its absence is its own failure.
		expect(verdict.failures.some((f) => f.includes("EUR"))).toBe(true)
	})

	it("passes a draft that states the facts and carries the required tables", () => {
		const plan = {
			deliverable: "compliance brief",
			audience: "managing director",
			sections: [
				{ heading: "Data Collection Requirements", mustInclude: ["farmer registers", "geolocation"] },
				{ heading: "Filing the Due Diligence Statement", mustInclude: ["TRACES"] },
				{ heading: "90-Day Action Plan", mustInclude: ["gap analysis"] },
			],
			tables: [{ title: "Data to collect per factory", columns: ["Factory", "Farmers", "Plot records"] }],
			facts: ["the deadline is 30 December 2026"],
			searchQueries: [],
		}
		const spec = {
			title: "EUDR Compliance for Kenyan Coffee Exporters",
			sections: [
				{
					heading: "Data Collection Requirements",
					prose: "Dealers must collect farmer registers, plot geolocation and volumes per lot from every factory.",
					table: {
						title: "Data to collect per factory",
						columns: ["Factory", "Farmers", "Plot records"],
						rows: [["Factory A", "1,200", "1,180 of 1,200"]],
					},
				},
				{
					heading: "Filing the Due Diligence Statement",
					prose: "The DDS is filed in TRACES before the coffee is placed on the EU market.",
				},
				{
					heading: "90-Day Action Plan",
					prose: "Gap analysis in weeks one to four, traceability records by week eight, training by week twelve, before the 30 December 2026 deadline.",
				},
			],
		}
		const verdict = validateReportSpec(spec, plan, "the 30 December 2026 deadline for large and medium operators")
		expect(verdict.ok).toBe(true)
		expect(verdict.failures).toEqual([])
	})

	it("flags a missing required table and thin sections", () => {
		const plan = {
			deliverable: "brief",
			audience: "md",
			sections: [
				{ heading: "One", mustInclude: [] },
				{ heading: "Two", mustInclude: [] },
				{ heading: "Three", mustInclude: [] },
			],
			tables: [{ title: "Costing table", columns: ["Item", "Cost"] }],
			facts: [],
			searchQueries: [],
		}
		const verdict = validateReportSpec(
			{
				title: "t",
				sections: [
					{ heading: "One", prose: "Real content that says something of substance here." },
					{ heading: "Two", prose: "More real content with an actual point being made." },
					{ heading: "Three", prose: "Short." },
				],
			},
			plan,
			"write the brief",
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.failures.some((f) => f.includes("required table missing"))).toBe(true)
		expect(verdict.failures.some((f) => f.includes("no substance"))).toBe(true)
	})
})

describe("expectedFactsFromInstruction", () => {
	it("extracts dates, years and currencies by code, not by the model", () => {
		const facts = expectedFactsFromInstruction(
			"the 30 December 2026 deadline for large operators, 2027 for micro, priced in EUR",
		)
		expect(facts).toContain("30 December 2026")
		expect(facts).toContain("2026")
		expect(facts).toContain("2027")
		expect(facts).toContain("EUR")
	})
})
describe("report cover art", () => {
	const spec = {
		title: "EUDR Compliance for Kenyan Coffee Exporters",
		sections: [{ heading: "Overview", prose: "Real prose with actual content, long enough to be substantive." }],
	}

	it("writes the cover b64 and a decode step when a cover is provided", () => {
		const files = buildReportFiles(spec, "AAAA")
		expect(files.map((f) => f.path)).toContain("cover.b64")
		const tex = files.find((f) => f.path === "report.tex")?.content ?? ""
		expect(tex).toContain("cover.jpg")
		const commands = buildReportCommands(0, true)
		expect(commands).toContain("cover.b64")
		expect(commands).toContain("cover.jpg")
	})

	it("adds nothing when there is no cover", () => {
		const files = buildReportFiles(spec)
		expect(files.map((f) => f.path)).not.toContain("cover.b64")
		const tex = files.find((f) => f.path === "report.tex")?.content ?? ""
		expect(tex).not.toContain("cover.jpg")
		const commands = buildReportCommands(0, false)
		expect(commands).not.toContain("cover.b64")
	})
})
