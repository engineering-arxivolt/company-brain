import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	buildNewsBriefBlocks,
	buildNewsFrame,
	getNewsBrief,
	listNewsBriefs,
	newsSignalBrief,
	normaliseNewsSignals,
	saveNewsBrief,
	type NewsBrief,
	type NewsSignal,
} from "./news"

function sqliteAgent() {
	const db = new DatabaseSync(":memory:")
	const agent = {
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?")
			const statement = db.prepare(text)
			const upper = text.trimStart().toUpperCase()
			const returnsRows =
				upper.startsWith("SELECT") || /RETURNING/.test(upper)
			return returnsRows
				? statement.all(...(values as never[]))
				: (statement.run(...(values as never[])), [])
		},
	} as unknown as CompanyBrainAgent
	return { agent, db }
}

function signal(overrides: Partial<NewsSignal> = {}): NewsSignal {
	return {
		id: "S1",
		headline: "ODPC tightens breach notification guidance",
		whatChanged:
			"The 72-hour clock now starts at awareness, not at confirmation.",
		whoCares: "Any Kenyan company holding customer data.",
		productHook: "Foundry tracks the clock and drafts the notification.",
		funnel: "MOF",
		sourceUrl: "https://www.odpc.go.ke/guidance",
		sourceName: "ODPC",
		date: "2026-10-21",
		status: "new",
		...overrides,
	}
}

describe("news signals", () => {
	it("keeps only signals with a headline and something that changed", () => {
		const signals = normaliseNewsSignals({
			signals: [
				{
					headline: "A real change",
					what_changed: "Something concrete happened",
					who_cares: "Operators",
					product_hook: "Foundry",
					funnel: "mof",
					source_url: "https://example.com/a",
					source_name: "Example",
					date: "2026-10-21",
				},
				{ headline: "No substance" },
				{ what_changed: "No headline" },
			],
		})
		expect(signals).toHaveLength(1)
		expect(signals[0]?.id).toBe("S1")
		expect(signals[0]?.funnel).toBe("MOF")
		expect(signals[0]?.sourceUrl).toBe("https://example.com/a")
	})

	it("drops everything when the desk found nothing", () => {
		expect(normaliseNewsSignals({ signals: [] })).toEqual([])
		expect(normaliseNewsSignals(null)).toEqual([])
	})

	it("asks for signals, sources and the three filter questions", () => {
		const frame = buildNewsFrame({
			founderBrief: "FOUNDER BRAIN — context",
			focus: "cloud pricing",
		})
		expect(frame).toContain("FOUNDER BRAIN")
		expect(frame).toContain("cloud pricing")
		expect(frame).toContain("changes a decision, a cost, a risk, or a deadline")
		expect(frame).toContain("product truth")
		expect(frame).toContain("TOF")
		expect(frame).toContain("JSON only")
	})
})

describe("news briefs", () => {
	it("stores a brief and reads it back", () => {
		const { agent } = sqliteAgent()
		const brief: NewsBrief = {
			id: "brief_1",
			userId: "user_1",
			orgId: "org_1",
			teamId: "T1",
			dmChannelId: "D1",
			signals: [signal()],
			createdAt: 1,
			updatedAt: 1,
		}
		saveNewsBrief(agent, brief)
		const stored = getNewsBrief(agent, "brief_1")
		expect(stored?.signals).toHaveLength(1)
		expect(stored?.signals[0]?.headline).toContain("ODPC")
		expect(listNewsBriefs(agent, "user_1")).toHaveLength(1)
		expect(listNewsBriefs(agent, "user_2")).toHaveLength(0)
	})

	it("builds a card with a decision per signal", () => {
		const { text, blocks } = buildNewsBriefBlocks({
			id: "brief_1",
			userId: "user_1",
			orgId: "org_1",
			teamId: "T1",
			dmChannelId: "D1",
			signals: [signal()],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
		expect(text).toContain("News Brief")
		const actions = blocks.filter(
			(block) => (block as { type?: string }).type === "actions",
		)
		expect(actions).toHaveLength(1)
		const elements = (actions[0] as { elements?: Array<{ action_id?: string }> })
			.elements
		expect(elements?.map((element) => element.action_id)).toEqual([
			"brain_news_draft_tof",
			"brain_news_draft_mof",
			"brain_news_skip",
		])
	})

	it("turns a signal into a brief a content round can use", () => {
		const brief = newsSignalBrief(signal(), "MOF")
		expect(brief).toContain("ODPC")
		expect(brief).toContain("The job is trust")
		expect(brief).toContain("https://www.odpc.go.ke/guidance")
		expect(newsSignalBrief(signal(), "TOF")).toContain("The job is reach")
	})
})
