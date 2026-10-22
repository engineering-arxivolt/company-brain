import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	addFounderBrainItem,
	buildFounderBrief,
	DEFAULT_WRITING_RULES,
	emptyFounderBrain,
	emptyFounderSections,
	ensureFounderBrainDefaults,
	founderBrainSummary,
	getFounderBrain,
	loadFounderBrief,
	MAX_FOUNDER_ITEMS_PER_SECTION,
	parseFounderSections,
	removeFounderBrainItem,
	setFounderBrainSection,
} from "./founder-brain"

function sqliteAgent() {
	const db = new DatabaseSync(":memory:")
	const agent = {
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?")
			const statement = db.prepare(text)
			const upper = text.trimStart().toUpperCase()
			const returnsRows = upper.startsWith("SELECT") || /RETURNING/.test(upper)
			return returnsRows
				? statement.all(...(values as never[]))
				: (statement.run(...(values as never[])), [])
		},
	} as unknown as CompanyBrainAgent
	return { agent, db }
}

describe("founder brain store", () => {
	it("starts empty and round-trips an item", () => {
		const { agent } = sqliteAgent()
		const empty = getFounderBrain(agent, "user_1")
		expect(founderBrainSummary(empty).sections.every((s) => !s.items.length)).toBe(
			true,
		)
		const result = addFounderBrainItem(agent, {
			userId: "user_1",
			section: "positioning",
			text: "We help Kenyan fintechs ship compliant products.",
			source: "interview",
		})
		expect(result.ok).toBe(true)
		const loaded = getFounderBrain(agent, "user_1")
		expect(loaded.sections.positioning).toHaveLength(1)
		expect(loaded.sections.positioning[0]?.text).toContain("compliant products")
		expect(loaded.sections.positioning[0]?.source).toBe("interview")
	})

	it("dedupes near-identical items and caps each section", () => {
		const { agent } = sqliteAgent()
		addFounderBrainItem(agent, {
			userId: "user_1",
			section: "stories",
			text: "We shipped the first version on a Friday.",
		})
		const duplicate = addFounderBrainItem(agent, {
			userId: "user_1",
			section: "stories",
			text: "  we shipped the FIRST version on a Friday.  ",
		})
		expect(duplicate.ok && duplicate.added).toBe(false)
		for (let i = 0; i < MAX_FOUNDER_ITEMS_PER_SECTION + 4; i++) {
			addFounderBrainItem(agent, {
				userId: "user_1",
				section: "stories",
				text: `Story number ${i}`,
			})
		}
		const loaded = getFounderBrain(agent, "user_1")
		expect(loaded.sections.stories).toHaveLength(MAX_FOUNDER_ITEMS_PER_SECTION)
		expect(loaded.sections.stories.at(-1)?.text).toContain("Story number 15")
	})

	it("replaces a section and removes one item by text", () => {
		const { agent } = sqliteAgent()
		setFounderBrainSection(agent, {
			userId: "user_1",
			section: "icp",
			items: ["First ICP", "Second ICP"],
		})
		let loaded = getFounderBrain(agent, "user_1")
		expect(loaded.sections.icp.map((i) => i.text)).toEqual([
			"First ICP",
			"Second ICP",
		])
		const removed = removeFounderBrainItem(agent, {
			userId: "user_1",
			section: "icp",
			reference: "first icp",
		})
		expect(removed.ok).toBe(true)
		loaded = getFounderBrain(agent, "user_1")
		expect(loaded.sections.icp.map((i) => i.text)).toEqual(["Second ICP"])
	})
})

describe("founder brief", () => {
	it("is empty when there is nothing to say", () => {
		expect(buildFounderBrief(emptyFounderBrain("user_1"))).toBe("")
	})

	it("turns sections into a compact, bounded brief", () => {
		const brain = emptyFounderBrain("user_1")
		brain.sections.positioning.push({
			id: "1",
			text: "We help compliance teams turn regulation into shipped software.",
			source: null,
			createdAt: 1,
		})
		brain.sections.icp.push({
			id: "2",
			text: "Heads of compliance at mid-sized Kenyan fintechs.",
			source: null,
			createdAt: 1,
		})
		brain.sections.stories.push({
			id: "3",
			text: "A customer found three gaps in one afternoon.",
			source: null,
			createdAt: 1,
		})
		const brief = buildFounderBrief(brain, { maxChars: 700 })
		expect(brief).toContain("FOUNDER BRAIN")
		expect(brief).toContain("Positioning:")
		expect(brief).toContain("Ideal customer:")
		expect(brief).toContain("Stories:")
		expect(brief.length).toBeLessThanOrEqual(750)
	})

	it("loadFounderBrief is the store-backed convenience path", () => {
		const { agent } = sqliteAgent()
		// The writing rules ship with the brain, so the first round already
		// writes the way the operator asked for.
		const first = loadFounderBrief(agent, "user_1")
		expect(first).toContain("Writing rules:")
		expect(first).toContain("Banned in every lane")
		addFounderBrainItem(agent, {
			userId: "user_1",
			section: "opinions",
			text: "Compliance should be a product surface, not a PDF.",
		})
		expect(loadFounderBrief(agent, "user_1")).toContain("product surface")
	})

	it("seeds the default rules once and never overwrites edited ones", () => {
		const { agent } = sqliteAgent()
		expect(ensureFounderBrainDefaults(agent, "user_1")).toBe(true)
		expect(ensureFounderBrainDefaults(agent, "user_1")).toBe(false)
		const brain = getFounderBrain(agent, "user_1")
		expect(brain.sections.rules.length).toBe(
			DEFAULT_WRITING_RULES.length,
		)
		setFounderBrainSection(agent, {
			userId: "user_1",
			section: "rules",
			items: ["Only one rule: ship it."],
		})
		expect(ensureFounderBrainDefaults(agent, "user_1")).toBe(false)
		expect(getFounderBrain(agent, "user_1").sections.rules).toHaveLength(1)
	})
})

describe("founder section parsing", () => {
	it("tolerates old and partial stored rows", () => {
		const sections = parseFounderSections(
			JSON.stringify({
				positioning: [{ id: "a", text: "Old shape", source: "seed" }],
			}),
		)
		expect(sections.positioning[0]?.text).toBe("Old shape")
		expect(sections.voice).toEqual([])
	})

	it("returns empty sections for broken JSON", () => {
		expect(parseFounderSections("{not json")).toEqual(emptyFounderSections())
	})
})
