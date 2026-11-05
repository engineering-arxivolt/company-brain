import { describe, expect, it } from "vitest"
import {
	markdownToLatex,
	parseReportSpec,
	renderReportTex,
	buildReportSpecPrompt,
} from "./report"

const VALID_SPEC = {
	title: "Electric Vehicles in Kenya",
	subtitle: "A market snapshot",
	sections: [
		{
			heading: "Overview",
			prose: "EV adoption **accelerated** in 2024. See [the source](https://example.com/a).\n\n- point one\n- point two",
			chart: {
				type: "bar",
				title: "Registrations by year",
				labels: ["2022", "2023", "2024"],
				series: [{ name: "EVs", values: [1100, 2569, 4754] }],
				yLabel: "New registrations",
				caption: "Source: NTSA.",
			},
		},
		{ heading: "Outlook", prose: "Growth continues." },
	],
}

describe("parseReportSpec", () => {
	it("accepts a fenced JSON reply and clamps fields", () => {
		const raw = "Here you go:\n```json\n" + JSON.stringify(VALID_SPEC) + "\n```"
		const spec = parseReportSpec(raw)
		expect(spec?.title).toBe("Electric Vehicles in Kenya")
		expect(spec?.sections).toHaveLength(2)
		expect(spec?.sections[0]?.chart?.series[0]?.values).toEqual([
			1100,
			2569,
			4754,
		])
	})

	it("rejects specs without a title or sections", () => {
		expect(parseReportSpec('{"title":"x","sections":[]}')).toBeNull()
		expect(parseReportSpec('{"sections":[{"heading":"a","prose":"b"}]}')).toBeNull()
		expect(parseReportSpec("no json here")).toBeNull()
	})

	it("drops charts without data instead of failing the whole spec", () => {
		const raw = JSON.stringify({
			title: "T",
			sections: [
				{ heading: "H", prose: "P", chart: { type: "bar", title: "No data" } },
				{ heading: "H2", prose: "P2" },
			],
		})
		const spec = parseReportSpec(raw)
		expect(spec?.sections[0]?.chart).toBeUndefined()
		expect(spec?.sections).toHaveLength(2)
	})
})

describe("markdownToLatex", () => {
	it("escapes, bolds, links and lists", () => {
		const tex = markdownToLatex(
			"Revenue grew **100%** — see [the report](https://x.com/a?b=1&c=2).\n\n- a_b & c\n- plain",
		)
		expect(tex).toContain("\\textbf{100\\%}")
		expect(tex).toContain("\\href{https://x.com/a?b=1&c=2}{the report}")
		expect(tex).toContain("\\item a\\_b \\& c")
		expect(tex).toContain("\\begin{itemize}")
		expect(tex).toContain("\\end{itemize}")
		expect(tex).not.toContain("**")
	})
})

describe("renderReportTex", () => {
	it("embeds one includegraphics per chart with captions", () => {
		const spec = parseReportSpec(JSON.stringify(VALID_SPEC))!
		const tex = renderReportTex(spec)
		expect(tex).toContain("chart-0.png")
		expect(tex).toContain("Source: NTSA.")
		expect(tex).toContain("Electric Vehicles in Kenya")
		expect(tex).not.toContain("chart-1.png")
	})
})

describe("buildReportSpecPrompt", () => {
	it("forbids invented numbers and demands bare JSON", () => {
		const prompt = buildReportSpecPrompt({
			topic: "t",
			instruction: "i",
			notes: "n",
		})
		expect(prompt.system).toContain("inventing data points is forbidden")
		expect(prompt.system).toContain("ONLY a JSON object")
	})
})
