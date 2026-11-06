/**
 * A research report as structured, renderable content.
 *
 * Same division of labour as the career documents: the model contributes
 * judgement (what the sections say, which numbers matter), the code owns
 * everything fragile (escaping, layout, chart rendering, the compile). The
 * model never sees LaTeX.
 */
export type ReportChart = {
	type: "bar" | "line" | "pie"
	title: string
	/** Category labels; for pie charts, the slice labels. */
	labels: string[]
	series: Array<{ name?: string; values: number[] }>
	yLabel?: string
	caption?: string
}

/** A headline number rendered as a callout card under the title band. */
export type ReportStat = {
	value: string
	label: string
}

/** A concrete data table inside one section, rendered as a LaTeX tabular. */
export type ReportTable = {
	title: string
	columns: string[]
	rows: string[][]
}

export type ReportSection = {
	heading: string
	prose: string
	chart?: ReportChart
	table?: ReportTable
}

// ── Deterministic validation ────────────────────────────────────────────────
// The draft is checked against the plan and the request by code, not by
// another model opinion. A draft that fails here is repaired once, then
// withheld rather than delivered broken.

/** Phrases that mean the model described a document instead of writing one. */
const BANNED_PATTERNS: RegExp[] = [
	// "plan" is deliberately absent: a document about a 90-day action plan
	// legitimately says "this plan outlines" — that is subject matter, not
	// self-reference (caught live on the EUDR brief).
	/\b(this|the)\s+(report|document|itinerary|brief|pdf)\s+(includes|contains|provides|covers|outlines|features)\b/i,
	/\b(is|are)\s+not\s+available\b/i,
	/\bto\s+be\s+(researched|added|determined later)\b/i,
	/\b(will|would)\s+be\s+added\s+(later|upon request)\b/i,
	/\bcannot\s+be\s+determined\b/i,
	/\bnot\s+enough\s+information\b/i,
]
/**
 * Facts the request itself committed to: explicit dates, years and currency
 * codes. These are extracted by code, not by the model, so a request that says
 * "the 30 December 2026 deadline" makes that string a hard expectation of the
 * finished document.
 */
export function expectedFactsFromInstruction(instruction: string): string[] {
	const found = new Set<string>()
	const longDates = instruction.matchAll(
		/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/gi,
	)
	for (const match of longDates) found.add(match[0])
	const usDates = instruction.matchAll(
		/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/gi,
	)
	for (const match of usDates) found.add(match[0])
	for (const match of instruction.matchAll(/\b20\d{2}\b/g)) found.add(match[0])
	for (const match of instruction.matchAll(/\b(EUR|USD|KES|GBP|TZS|UGX|RWF)\b/g)) {
		found.add(match[0])
	}
	return [...found]
}

/** Whitespace-insensitive containment, so "December  30,  2026" still matches. */
function normalizedContains(haystack: string, needle: string): boolean {
	const squash = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim()
	return squash(haystack).includes(squash(needle))
}

/**
 * A fact is satisfied when its hard tokens (dates, years, amounts) appear in
 * the draft. "The deadline is 30 December 2026" is met by any sentence that
 * says "30 December 2026" — the wording around it is the model's to choose.
 * A fact with no hard tokens must appear verbatim.
 */
function factSatisfied(allText: string, fact: string): boolean {
	if (normalizedContains(allText, fact)) return true
	const tokens = new Set<string>()
	for (const match of fact.matchAll(
		/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/gi,
	)) {
		tokens.add(match[0])
	}
	for (const match of fact.matchAll(/\b20\d{2}\b/g)) tokens.add(match[0])
	for (const match of fact.matchAll(/\b(EUR|USD|KES|GBP|TZS|UGX|RWF)\s?\d[\d,.]*/g)) {
		tokens.add(match[0])
	}
	for (const match of fact.matchAll(/\b\d[\d,.]*\s?(?:%|per\s?cent)\b/gi)) tokens.add(match[0])
	if (!tokens.size) return false
	return [...tokens].every((token) => normalizedContains(allText, token))
}
/**
 * Check a draft against the plan and the request. Returns the failure list —
 * empty means the draft may be rendered. Every check is code, so the same
 * draft always gets the same verdict.
 */
export function validateReportSpec(
	spec: ReportSpec,
	plan: ReportPlan | null,
	instruction: string,
): { ok: boolean; failures: string[] } {
	const failures: string[] = []
	const allText = [
		spec.title,
		spec.subtitle ?? "",
		...spec.sections.flatMap((section) => [
			section.heading,
			section.prose,
			section.table
				? `${section.table.title} ${section.table.columns.join(" ")} ${section.table.rows
						.map((row) => row.join(" "))
						.join(" ")}`
				: "",
		]),
		...(spec.keyStats ?? []).map((stat) => `${stat.value} ${stat.label}`),
	].join("\n")

	// 1. Meta-language: describing the document instead of writing it.
	for (const pattern of BANNED_PATTERNS) {
		const match = allText.match(pattern)
		if (match) {
			failures.push(
				`meta-language detected: "${match[0]}" — write the content itself, not a description of it`,
			)
		}
	}

	// 2. Facts the request stated must appear verbatim.
	const expectations = [...new Set([...expectedFactsFromInstruction(instruction), ...(plan?.facts ?? [])])]
	for (const fact of expectations) {
		if (!factSatisfied(allText, fact)) {
			failures.push(`required fact missing: the document must state "${fact}"`)
		}
	}

	// 3. Plan adherence: required tables exist with rows.
	// 2b. A requested table must exist even without a plan: when the request
	// names a costing table (or schedule, breakdown) in a specific currency,
	// some table must actually carry that currency — mentioning it in prose
	// does not count.
	const wantsTable = /\b(costing|table|schedule|breakdown|price\s*list)\b/i.test(instruction)
	const currencies = expectedFactsFromInstruction(instruction).filter((fact) =>
		/^(EUR|USD|KES|GBP|TZS|UGX|RWF)$/.test(fact),
	)
	const specTables = spec.sections
		.map((section) => section.table)
		.filter((table): table is ReportTable => Boolean(table))
	if (wantsTable && currencies.length) {
		const satisfied = specTables.some((table) =>
			currencies.some((currency) =>
				`${table.title} ${table.columns.join(" ")}`.toUpperCase().includes(currency),
			),
		)
		if (!satisfied) {
			failures.push(
				`required table missing: the request asks for a costing table in ${currencies.join("/")} — no table carries it (add the currency to a table's title or columns)`,
			)
		}
	}
	if (plan) {
		// A partial plan (sections or tables missing) is treated as empty there:
		// validation still runs on facts, which come from the request itself.
		const plannedSections = plan.sections ?? []
		const plannedTables = plan.tables ?? []
		for (const required of plannedTables) {
			const keywords = required.title
				.toLowerCase()
				.split(/\s+/)
				.filter((word) => word.length > 3)
			const found = specTables.some(
				(table) =>
					normalizedContains(table.title, required.title) ||
					(keywords.length > 0 &&
						keywords.every(
							(word) =>
								table.title.toLowerCase().includes(word) ||
								table.columns.join(" ").toLowerCase().includes(word),
						)),
			)
			if (!found) {
				failures.push(
					`required table missing: "${required.title}" (columns: ${required.columns.join(", ")}) — add it as a real table with real rows`,
				)
			}
		}
		// 4. Plan sections: two thirds must be recognisable by heading.
		if (plannedSections.length >= 3) {
			const covered = plan.sections.filter((required) =>
				spec.sections.some((section) => normalizedContains(section.heading, required.heading)),
			)
			if (covered.length < Math.ceil((plannedSections.length * 2) / 3)) {
				failures.push(
					`section coverage too low: ${covered.length}/${plan.sections.length} planned sections found (${plan.sections
						.map((section) => section.heading)
						.join("; ")})`,
				)
			}
		}
	}

	// 5. Substance: a section whose prose is thinner than its heading usually
	// hides a skipped requirement.
	const thin = spec.sections.filter((section) => section.prose.trim().length < 40)
	if (thin.length) {
		failures.push(
			`sections with no substance: ${thin.map((section) => section.heading).join(", ")} — write real content`,
		)
	}

	return { ok: failures.length === 0, failures }
}

export type ReportSpec = {
	title: string
	subtitle?: string
	/** Up to 3 headline numbers, taken from the notes. */
	keyStats?: ReportStat[]
	sections: ReportSection[]
}

/**
 * The plan: what the document must contain, decided before any prose is
 * written. Validation later checks the draft against this, so a request for a
 * "day-by-day plan and a costing table" cannot come back as a description of
 * one.
 */
export type ReportPlanSection = {
	heading: string
	mustInclude: string[]
}

export type ReportPlanTable = {
	title: string
	columns: string[]
}

export type ReportPlan = {
	deliverable: string
	audience: string
	sections: ReportPlanSection[]
	tables: ReportPlanTable[]
	/** Claims that must appear verbatim; drawn from the request itself. */
	facts: string[]
	searchQueries: string[]
	/**
	 * Art direction, decided by the planner: whether the document deserves a
	 * cover image and what it should depict. The pipeline resolves it from the
	 * workspace hero or a fresh Flow render.
	 */
	art?: {
		coverPrompt?: string
		/** true = the existing workspace hero fits; skip a new render. */
		reuseExistingHero?: boolean
	}
}

export const MAX_REPORT_SECTIONS = 12
export const MAX_REPORT_CHARTS = 6

/** Chart data for one report, as the JSON file the chart script reads. */
export function chartsJson(charts: ReportChart[]): string {
	return JSON.stringify(charts)
}

export { escapeLatex, escapeUrl } from "../career/render"
import { escapeLatex, escapeUrl } from "../career/render"

export const SPEC_SYSTEM = [
	"You produce the FINISHED document as structured JSON. You receive a topic, the asker's instruction, a plan of required sections and tables, and research notes gathered from the web.",
	"You reply with ONLY a JSON object, no markdown fences, matching this schema:",
	'{"title": string, "subtitle": string, "keyStats": [{"value": string, "label": string}], "sections": [{"heading": string, "prose": string, "table": {"title": string, "columns": string[], "rows": string[][]}?, "chart": {"type": "bar"|"line"|"pie", "title": string, "labels": string[], "series": [{"name": string, "values": number[]}], "yLabel": string, "caption": string}?}]}',
	"",
	"Deliverable rules (breaking these fails automated validation):",
	"- You are writing the artifact itself, never a description of it. Never write phrases like 'this report includes', 'the itinerary contains', 'the document provides', 'X is not available', 'to be researched later'. Instead, put the actual plan, the actual table, the actual numbers into the JSON.",
	"- Every date, deadline, fee, price and statistic MUST be taken verbatim from the research notes or the plan's facts. Never supply one from memory. If the notes lack a needed number, put 'to be confirmed' in that table cell — an honest placeholder passes validation, an invented number does not.",
	"- The plan's sections are required: use those headings and cover every point in mustInclude. The plan's tables are required: each must appear as a real table with real rows (one per section, in order).",
	"",
	"Formatting rules:",
	"- prose is markdown: paragraphs, - bullet lists, **bold**, > quoted callouts, [links](url). No # headings inside prose — the heading field is the section title.",
	"- 4 to 8 sections unless the plan says otherwise.",
	"- keyStats: up to 3 headline numbers from the notes. Omit if the notes have none.",
	"- Charts must plot REAL numbers taken from the research notes. If the notes contain no usable quantitative data, omit the chart field entirely — inventing data points is forbidden.",
	"- Use '> ...' for one key takeaway per section when it helps.",
	"- Ground claims in the notes; cite inline as [source](url) where a claim depends on one.",
	"- Reply with the JSON and nothing else.",
].join("\n")

export const PLAN_SYSTEM = [
	"You plan a document before it is written. You receive a topic and the asker's instruction.",
	"You reply with ONLY a JSON object, no markdown fences, matching this schema:",
	'{"deliverable": string, "audience": string, "sections": [{"heading": string, "mustInclude": [string]}], "tables": [{"title": string, "columns": [string]}], "facts": [string], "searchQueries": [string], "art": {"coverPrompt": string, "reuseExistingHero": boolean}}',
	"",
	"Rules:",
	"- sections: 4 to 8, the shape the finished document needs. mustInclude lists the concrete points each section must cover.",
	"- tables: every data table the instruction calls for (costing table, day-by-day plan, comparison, schedule). Columns must be concrete, e.g. [\"Day\", \"Location\", \"Activity\", \"Cost (EUR)\"]. If the instruction asks for a plan, schedule or costing, that is a table.",
	"- facts: short claims that MUST appear in the finished document verbatim, copied from the instruction — deadlines, dates, quantities, currencies the asker stated. Do not invent facts here.",
	"- searchQueries: 2 to 4 web searches that would surface the data the tables need.",
	"- art: you are the art director. A document a client will read deserves a cover image (reports, proposals, client briefs; skip it for internal memos). coverPrompt: ONE line describing the image for an image generator — subject, setting, light, style, and never any text in the image. Set reuseExistingHero=true only when a previously generated workspace image already fits this exact topic.",
	"- Reply with the JSON and nothing else.",
].join("\n")

export function buildReportPlanPrompt(args: {
	topic: string
	instruction: string
}): { system: string; user: string } {
	return {
		system: PLAN_SYSTEM,
		user: `# Topic\n\n${args.topic}\n\n# The asker asked for\n\n${args.instruction}`,
	}
}

/** Structural clamp for the plan. Null on any failure. */
export function parseReportPlan(raw: string | null | undefined): ReportPlan | null {
	if (!raw) return null
	const start = raw.indexOf("{")
	const end = raw.lastIndexOf("}")
	if (start < 0 || end <= start) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw.slice(start, end + 1))
	} catch {
		return null
	}
	if (typeof parsed !== "object" || parsed === null) return null
	const source = parsed as Record<string, unknown>
	const strings = (value: unknown, max: number, limit: number): string[] =>
		Array.isArray(value)
			? (value as unknown[])
					.slice(0, limit)
					.map((entry) => (typeof entry === "string" ? entry.trim().slice(0, max) : ""))
					.filter((entry) => entry.length > 0)
			: []
	const sections = Array.isArray(source.sections)
		? (source.sections as unknown[]).slice(0, MAX_REPORT_SECTIONS).flatMap((entry) => {
				if (typeof entry !== "object" || entry === null) return []
				const record = entry as Record<string, unknown>
				const heading = clampText(record.heading, 120)
				if (!heading) return []
				return [
					{
						heading,
						mustInclude: strings(record.mustInclude, 160, 6),
					},
				]
			})
		: []
	const tables = Array.isArray(source.tables)
		? (source.tables as unknown[]).slice(0, 4).flatMap((entry) => {
				if (typeof entry !== "object" || entry === null) return []
				const record = entry as Record<string, unknown>
				const title = clampText(record.title, 120)
				const columns = strings(record.columns, 40, 8)
				if (!title || columns.length < 2) return []
				return [{ title, columns }]
			})
		: []
	let art: ReportPlan["art"]
	if (typeof source.art === "object" && source.art !== null) {
		const artSource = source.art as Record<string, unknown>
		const coverPrompt = clampText(artSource.coverPrompt, 240)
		if (coverPrompt) {
			art = {
				coverPrompt,
				reuseExistingHero: artSource.reuseExistingHero === true,
			}
		}
	}
	return {
		deliverable: clampText(source.deliverable, 60) ?? "",
		audience: clampText(source.audience, 120) ?? "",
		sections,
		tables,
		facts: strings(source.facts, 200, 8),
		searchQueries: strings(source.searchQueries, 160, 4),
		...(art ? { art } : {}),
	}
}

export function buildReportSpecPrompt(args: {
	topic: string
	instruction: string
	notes: string
	plan?: ReportPlan | null
	failures?: string[]
}): { system: string; user: string } {
	const planLines: string[] = []
	if (args.plan) {
		planLines.push(
			...args.plan.sections.map(
				(section) =>
					`- Section: ${section.heading}${section.mustInclude.length ? ` (must cover: ${section.mustInclude.join("; ")})` : ""}`,
			),
		)
		for (const [index, table] of args.plan.tables.entries()) {
			planLines.push(
				`- Required table ${index + 1}: "${table.title}" with columns: ${table.columns.join(" | ")}`,
			)
		}
		if (args.plan.facts.length) {
			planLines.push(`- Facts that must appear verbatim: ${args.plan.facts.join("; ")}`)
		}
	}
	const failureLines = (args.failures ?? []).map((failure) => `- ${failure}`)
	return {
		system: SPEC_SYSTEM,
		user: `# Topic\n\n${args.topic}\n\n# The asker asked for\n\n${args.instruction || "a well-structured PDF report"}${planLines.length ? `\n\n# Required plan (follow exactly)\n\n${planLines.join("\n")}` : ""}\n\n# Research notes (gathered from the web)\n\n${args.notes}${failureLines.length ? `\n\n# Validation failures of your previous draft (fix every one)\n\n${failureLines.join("\n")}` : ""}`,
	}
}

/**
 * Turn the model's reply into a spec the renderer can trust: JSON extracted
 * from whatever came back, every field clamped, charts validated so one bad
 * series cannot break the compile. Null on any failure — the turn then answers
 * in text rather than delivering a broken PDF.
 */
export function parseReportSpec(
	raw: string | null | undefined,
): ReportSpec | null {
	if (!raw) return null
	const start = raw.indexOf("{")
	const end = raw.lastIndexOf("}")
	if (start < 0 || end <= start) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw.slice(start, end + 1))
	} catch {
		return null
	}
	if (typeof parsed !== "object" || parsed === null) return null
	const source = parsed as Record<string, unknown>
	const title = clampText(source.title, 160)
	if (!title) return null
	const sections: ReportSection[] = Array.isArray(source.sections)
		? (source.sections as unknown[])
				.slice(0, MAX_REPORT_SECTIONS)
				.map((entry) => parseSection(entry))
				.filter((entry): entry is ReportSection => entry !== null)
		: []
	if (!sections.length) return null
	const spec: ReportSpec = { title, sections }
	const subtitle = clampText(source.subtitle, 240)
	if (subtitle) spec.subtitle = subtitle
	const keyStats = Array.isArray(source.keyStats)
		? (source.keyStats as unknown[])
				.slice(0, 3)
				.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) return []
					const record = entry as Record<string, unknown>
					const value = clampText(record.value, 40)
					const label = clampText(record.label, 80)
					return value && label ? [{ value, label }] : []
				})
		: []
	if (keyStats.length) spec.keyStats = keyStats
	return spec
}

function parseSection(entry: unknown): ReportSection | null {
	if (typeof entry !== "object" || entry === null) return null
	const source = entry as Record<string, unknown>
	const heading = clampText(source.heading, 160)
	const prose = clampText(source.prose, 4_000)
	if (!heading || !prose) return null
	const section: ReportSection = { heading, prose }
	const chart = parseChart(source.chart)
	if (chart) section.chart = chart
	const table = parseTable(source.table)
	if (table) section.table = table
	return section
}

/** Clamp a draft table so one bad row cannot break the compile. */
function parseTable(entry: unknown): ReportTable | null {
	if (typeof entry !== "object" || entry === null) return null
	const source = entry as Record<string, unknown>
	const title = clampText(source.title, 140)
	const columns = Array.isArray(source.columns)
		? (source.columns as unknown[])
				.slice(0, 8)
				.map((column) => (typeof column === "string" ? column.trim().slice(0, 60) : ""))
				.filter((column) => column.length > 0)
		: []
	if (!title || columns.length < 2) return null
	const rows = Array.isArray(source.rows)
		? (source.rows as unknown[])
				.slice(0, 14)
				.flatMap((row) => {
					if (!Array.isArray(row)) return []
					const cells = (row as unknown[]).slice(0, columns.length).map((cell) =>
						typeof cell === "string" || typeof cell === "number"
							? String(cell).slice(0, 120)
							: "",
					)
					while (cells.length < columns.length) cells.push("")
					// A row of entirely empty cells is noise, not data.
					return cells.some((cell) => cell.trim()) ? [cells] : []
				})
		: []
	if (!rows.length) return null
	return { title, columns, rows }
}

function parseChart(entry: unknown): ReportChart | null {
	if (typeof entry !== "object" || entry === null) return null
	const source = entry as Record<string, unknown>
	const type =
		source.type === "line" || source.type === "pie" ? source.type : "bar"
	const title = clampText(source.title, 160)
	const labels = Array.isArray(source.labels)
		? (source.labels as unknown[])
				.filter((label): label is string => typeof label === "string")
				.map((label) => clampText(label, 60) ?? "")
				.filter(Boolean)
				.slice(0, 12)
		: []
	const series = Array.isArray(source.series)
		? (source.series as unknown[])
				.slice(0, 3)
				.flatMap((entry) => {
					if (typeof entry !== "object" || entry === null) return []
					const record = entry as Record<string, unknown>
					const values = Array.isArray(record.values)
						? (record.values as unknown[])
								.filter(
									(v): v is number =>
										typeof v === "number" && Number.isFinite(v),
								)
								.slice(0, 12)
						: []
					if (!values.length) return []
					const name = clampText(record.name, 60)
					return [{ ...(name ? { name } : {}), values }]
				})
		: []
	// A chart needs its data; a title alone renders nothing.
	if (!title || !labels.length || !series.length) return null
	const chart: ReportChart = { type, title, labels, series }
	const yLabel = clampText(source.yLabel, 60)
	if (yLabel) chart.yLabel = yLabel
	const caption = clampText(source.caption, 300)
	if (caption) chart.caption = caption
	return chart
}

function clampText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined
	const text = value.trim()
	return text ? text.slice(0, max) : undefined
}

/**
 * The matplotlib script that turns charts.json into PNGs. Written as a file, so
 * no shell quoting is involved; the data is read from JSON, never interpolated.
 * Fixed styling: one house look for every report.
 */
export const CHART_SCRIPT = `import json
import math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

with open("charts.json") as fh:
    charts = json.load(fh)

# Okabe-Ito colorblind-safe palette; one accent (blue) carries the story and
# the rest recede. Direct labels carry values, so color is never the only
# channel (Cleveland-McGill puts hue last for reading quantities).
OI = {"orange": "#E69F00", "sky": "#56B4E9", "green": "#009E73", "blue": "#0072B2", "vermillion": "#D55E00", "purple": "#CC79A7"}
ACCENT = OI["blue"]
MUTED = "#595959"
INK = "#1A1A1A"

for i, c in enumerate(charts):
    fig, ax = plt.subplots(figsize=(4.67, 2.9), dpi=200)
    labels = c["labels"]
    series = c["series"]
    kind = c["type"]
    if kind == "pie" and len(series) == 1:
        values = series[0]["values"]
        total = sum(values)
        wedges, _ = ax.pie(values, startangle=90, counterclock=False,
            colors=[OI["blue"], OI["orange"], OI["green"], OI["vermillion"], OI["sky"], OI["purple"]],
            wedgeprops={"width": 0.42, "edgecolor": "white", "linewidth": 1.5})
        # Direct labels: category and share beside each slice, so the reader
        # never has to match a color to a legend.
        for w, label, value in zip(wedges, labels, values):
            angle = (w.theta2 + w.theta1) / 2
            x = 1.14 * math.cos(math.radians(angle))
            y = 1.14 * math.sin(math.radians(angle))
            share = 100 * value / total if total else 0
            ax.text(x, y, label + " " + f"{share:.0f}%", ha="center", va="center", fontsize=8, color=INK)
        ax.text(0, 0, f"{total:,.0f}".rstrip("0").rstrip("."), ha="center", va="center", fontsize=14, fontweight="bold", color=ACCENT)
        ax.axis("equal")
    elif kind == "line":
        for j, s in enumerate(series):
            color = ACCENT if j == 0 else MUTED
            style = "-" if j == 0 else ("--", "-.", ":")[j % 3]
            marker = ["o", "s", "^", "D"][j % 4]
            ax.plot(labels, s["values"], linestyle=style, marker=marker,
                    linewidth=2.2 if j == 0 else 1.6, color=color, markersize=4.5,
                    markerfacecolor="white", markeredgewidth=1.6, zorder=3)
            # Direct labels: series name and end value at the line's end, no
            # legend shuttle.
            ax.annotate(s.get("name") or "", xy=(len(labels) - 1, s["values"][-1]),
                        xytext=(4, 7), textcoords="offset points", fontsize=8, color=color)
            ax.annotate(f"{s['values'][-1]:,.0f}".rstrip("0").rstrip("."),
                        xy=(len(labels) - 1, s["values"][-1]), xytext=(4, -9),
                        textcoords="offset points", fontsize=8, fontweight="bold", color=color)
    else:
        count = len(series)
        width = 0.8 / count
        xs = range(len(labels))
        for j, s in enumerate(series):
            offsets = [x + (j - (count - 1) / 2) * width for x in xs]
            # First series carries the accent; the rest recede.
            color = ACCENT if j == 0 else ("#9E9E9E" if j == 1 else OI["orange"] if j == 2 else MUTED)
            bars = ax.bar(offsets, s["values"], width * 0.9, color=color, zorder=3, label=s.get("name"))
            ax.bar_label(bars, fmt="{:,.0f}".format, fontsize=7.5, padding=2, color=INK)
        ax.set_xticks(list(xs))
        ax.set_xticklabels(labels, fontsize=8.5, color=MUTED)
        # Bars start at zero; no decorative grid - the labels are the values.
        ax.set_ylim(bottom=0)
    ax.set_title(c.get("title", ""), fontsize=10.5, fontweight="bold", color=INK, loc="left", pad=10)
    if kind != "pie" and c.get("yLabel"):
        ax.set_ylabel(c["yLabel"], fontsize=8.5, color=MUTED)
    if kind != "pie":
        ax.tick_params(left=False, bottom=False, labelsize=8)
        for spine in ("top", "right", "left"):
            ax.spines[spine].set_visible(False)
        ax.spines["bottom"].set_color("#B0B0B0")
        ax.grid(False)
    fig.tight_layout()
    fig.savefig(f"chart-{i}.png")
print(f"CHARTS {len(charts)}")`.trim()

/**
 * Markdown to LaTeX, deterministically. Escape first, then restore the
 * structural markers — escaping leaves **, [], () and newlines intact, so the
 * transforms below run on safe text.
 */
export function markdownToLatex(markdown: string): string {
	const links: Array<{ label: string; url: string }> = []
	// Links first: their URLs must hit escapeUrl, not escapeLatex.
	let text = markdown.replace(
		/\[([^\]]+)\]\(([^)\s]+)\)/g,
		(_match, label: string, url: string) => {
			links.push({ label, url })
			return `\u0000${links.length - 1}\u0000`
		},
	)
	text = escapeLatex(text)
	text = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
		const link = links[Number(index)]
		if (!link) return ""
		return `\\href{${escapeUrl(link.url)}}{${escapeLatex(link.label)}}`
	})
	// Acronyms in small caps inside running text (typographic brief §2): a
	// standalone run of 2-6 capitals. Runs after escaping and before bold and
	// links are restored, so the only uppercase runs it can touch are prose.
	text = text.replace(/\b[A-Z]{2,6}\b/g, (match) => `\\textsc{${match}}`)
	// Inline markers on escaped text: **bold** then *italic*.
	text = text.replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}")
	text = text.replace(/\*([^*\n]+)\*/g, "\\emph{$1}")

	const out: string[] = []
	let inList = false
	let quote: string[] = []
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim()
		const bullet = line.match(/^[-*]\s+(.*)$/)
		const quoted = line.match(/^>\s?(.*)$/)
		const heading = line.match(/^(#{1,4})\s+(.*)$/)
		if (quote.length && !quoted) {
			out.push(quoteBlock(quote.join(" ")))
			quote = []
		}
		if (inList && !bullet) {
			out.push("\\end{itemize}")
			inList = false
		}
		if (heading) {
			const level = heading[1]?.length ?? 1
			const command = level === 1 ? "\\section*" : "\\subsection*"
			out.push(`${command}{${heading[2]}}`)
		} else if (quoted) {
			quote.push(quoted[1] ?? "")
		} else if (bullet) {
			if (!inList) {
				out.push("\\begin{itemize}\\setlength{\\itemsep}{2pt}")
				inList = true
			}
			out.push(`\\item ${bullet[1]}`)
		} else if (line) {
			out.push(`${line}\\par`)
		}
	}
	if (quote.length) out.push(quoteBlock(quote.join(" ")))
	if (inList) out.push("\\end{itemize}")
	return out.join("\n")
}

/** A key takeaway as a filled callout card. Input has already been escaped. */
function quoteBlock(text: string): string {
	if (!text.trim()) return ""
	return [
		"\\par\\vspace{4pt}",
		"\\noindent\\colorbox{softbg}{%",
		"\\begin{minipage}{\\dimexpr\\linewidth-2\\fboxsep\\relax}",
		"{\\color{accent}\\rule[-2pt]{2.5pt}{14pt}}\\hspace{6pt}",
		`{\\itshape ${text}}`,
		"\\end{minipage}}\\par\\vspace{5pt}",
	].join("\n")
}

/** The full .tex for one report. Charts come in as chart-N.png. */
export function renderReportTex(
	spec: ReportSpec,
	opts: { coverImage?: boolean } = {},
): string {
	let chartIndex = 0
	const body: string[] = []
	spec.sections.forEach((section, index) => {
		body.push(
			// Numbered section head: accent number, ink title, hairline rule.
			`\\sectionhead{${index + 1}}{${escapeLatex(section.heading)}}`,
		)
		// Old-style figures in running prose (fontspec path); tables, stat
		// cards and charts keep lining figures outside this group.
		body.push("{\\prosefigures " + markdownToLatex(section.prose) + "}")
		if (section.table) {
			// Data tables are first-class: columns and rows escaped cell by cell,
			// so one stray character cannot break the compile. Booktabs rules
			// only (no vertical lines); numeric columns right-align.
			const { columns, rows, title } = section.table
			const align = columns
				.map((_column, colIndex) => {
					const cells = rows.map((row) => (row[colIndex] ?? "").trim())
					return cells.length > 0 && cells.every((cell) => /^[\d,.]+\s*%?$/.test(cell))
						? "r"
						: "l"
					})
					.join("")
				const head = columns.map((column) => `\\textbf{${escapeLatex(column)}}`).join(" & ")
				const lines = [
					"\\par\\vspace{5pt}",
					`{\\small\\noindent{}${escapeLatex(title)}}\\\\[2pt]`,
					`\\begin{tabular}{@{}${align}@{}}`,
					"\\rptoprule",
					`${head} \\\\[1pt]`,
					"\\rpmidrule",
					...rows.map((row) => `${row.map((cell) => escapeLatex(cell)).join(" & ")} \\\\`),
					"\\rpbottomrule",
					"\\end{tabular}\\par\\vspace{6pt}",
				]
				body.push(lines.join("\n"))
		}
		if (section.chart) {
			const number = chartIndex++
			const caption = section.chart.caption || section.chart.title
			body.push(
				`\\begin{center}\\includegraphics[width=0.94\\linewidth]{chart-${number}.png}\\\\[2pt]\\end{center}`,
				`\\begin{center}{\\small\\color{muted}\\emph{${escapeLatex(caption)}}}\\end{center}`,
			)
		}
	})
	// Stat cards sit right under the title band: three accent numbers a reader
	// sees before any prose.
	const statCards = (spec.keyStats ?? [])
		.map(
			(stat) =>
				`\\colorbox{softbg}{\\parbox{0.31\\linewidth}{\\centering\\vspace{6pt}{\\Large\\bfseries\\color{accent}${escapeLatex(stat.value)}}\\\\[2pt]{\\scriptsize\\color{muted}${escapeLatex(stat.label)}}\\vspace{6pt}}}`,
		)
		.join("\\hfill")
	const subtitle = spec.subtitle
		? `\\\\[5pt]{\\large\\mdseries {\\color{accentsoft}${escapeLatex(spec.subtitle)}}}`
		: ""
	return [
		// Typography per the evidence brief (Designing Reports for the Reading
		// Brain): KOMA 11pt, a 28pc measure (~66 characters), constant leading
		// ~1.26x, microtype, one Okabe-Ito accent, booktabs tables.
		"\\documentclass[11pt]{scrartcl}",
		"\\usepackage{iftex}",
		"\\ifPDFTeX",
		"\\usepackage[T1]{fontenc}",
		"\\usepackage[utf8]{inputenc}",
		// TeX Gyre Pagella: a generous-x-height text face present in
		// texlive-fonts-recommended. The Libertinus/fontspec path needs
		// texlive-xetex, which the sandbox image does not carry yet.
		"\\IfFileExists{tgpagella.sty}{\\usepackage{tgpagella}}{\\usepackage{lmodern}}",
		"\\newcommand{\\prosefigures}{}",
		"\\newcommand{\\tablefigures}{}",
		"\\else",
		"\\usepackage{fontspec}",
		"\\IfFontExistsTF{Libertinus Serif}{\\setmainfont{Libertinus Serif}}{\\IfFontExistsTF{TeX Gyre Pagella}{\\setmainfont{TeX Gyre Pagella}}{}}",
		// Old-style figures in running prose; tables, headings and stat cards
		// keep lining figures (prose is wrapped in \prosefigures below).
		"\\newcommand{\\prosefigures}{\\addfontfeatures{Numbers=OldStyle}}",
		"\\newcommand{\\tablefigures}{\\addfontfeatures{Numbers=Lining}}",
		"\\fi",
		"\\usepackage{microtype}",
		"\\usepackage[a4paper,textwidth=28pc]{geometry}",
		"\\linespread{1.05}",
		"\\usepackage{xcolor}",
		"\\definecolor{OIorange}{HTML}{E69F00}",
		"\\definecolor{OIsky}{HTML}{56B4E9}",
		"\\definecolor{OIgreen}{HTML}{009E73}",
		"\\definecolor{OIblue}{HTML}{0072B2}",
		"\\definecolor{OIvermillion}{HTML}{D55E00}",
		"\\definecolor{OIpurple}{HTML}{CC79A7}",
		// One accent carries all emphasis; the neutrals are grays, so the
		// document reads in grayscale by construction.
		"\\definecolor{accent}{HTML}{0072B2}",
		"\\definecolor{accentsoft}{HTML}{D6E4F0}",
		"\\definecolor{softbg}{HTML}{F4F4F4}",
		"\\definecolor{ink}{HTML}{1A1A1A}",
		"\\definecolor{muted}{HTML}{595959}",
		// booktabs gives the three rules the tables use. The \\rp* aliases are
		// defined here because the table body emits them; without this they are
		// undefined control sequences and the document never compiles.
		"\\IfFileExists{booktabs.sty}{" +
		"\\usepackage{booktabs}" +
		"\\newcommand{\\rptoprule}{\\toprule}\\newcommand{\\rpmidrule}{\\midrule}\\newcommand{\\rpbottomrule}{\\bottomrule}" +
		"}{\\newcommand{\\rptoprule}{\\hline}\\newcommand{\\rpmidrule}{\\hline}\\newcommand{\\rpbottomrule}{\\hline}}",
		"\\IfFileExists{siunitx.sty}{\\usepackage{siunitx}}{}",
		// No orphan or widow at page breaks.
		"\\widowpenalty=10000",
		"\\clubpenalty=10000",
		"\\usepackage[hidelinks]{hyperref}",
		"\\color{ink}",
		"\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{5pt}",
		"\\renewcommand{\\labelitemi}{{\\color{accent}\\small\\textbullet}}",
		"\\newcommand{\\sectionhead}[2]{\\par\\vspace{11pt}{\\color{accent}\\large\\bfseries #1.\\hspace{7pt}#2}\\par\\vspace{2pt}{\\color{accentsoft}\\rule{\\linewidth}{1.1pt}}\\par\\vspace{5pt}}",
		// Footer: report title left, page number right, hairline above.
		// fancyhdr is guarded: the sandbox image carries it, but a deployment
		// without it must degrade to a plain page rather than fail the compile.
		"\\IfFileExists{fancyhdr.sty}{" +
		"\\usepackage{fancyhdr}\\pagestyle{fancy}\\fancyhf{}" +
		`\\fancyfoot[L]{\\scriptsize\\color{muted}${escapeLatex(spec.title)}}` +
		"\\fancyfoot[R]{\\scriptsize\\color{muted}\\thepage}" +
		"\\renewcommand{\\headrulewidth}{0pt}\\renewcommand{\\footrulewidth}{0pt}" +
		"\\renewcommand{\\footruleskip}{4pt}" +
		"\\fancyfoot[C]{\\color{accentsoft}\\rule{\\linewidth}{0.6pt}}" +
		"}{}",
		"\\begin{document}",
		// Title band: full-width accent block, white type.
		"\\noindent\\colorbox{accent}{%",
		"\\begin{minipage}{\\dimexpr\\linewidth-2\\fboxsep\\relax}",
		"\\vspace{14pt}",
		`\\color{white}\\LARGE\\bfseries ${escapeLatex(spec.title)}${subtitle}`,
		"\\vspace{14pt}",
		"\\end{minipage}}\\par\\vspace{12pt}",
		statCards
			? `\\noindent${statCards}\\par\\vspace{4pt}`
			: "",
		...(opts.coverImage
			? [
					"\\par\\vspace{10pt}",
					"\\noindent\\includegraphics[width=\\linewidth]{cover.jpg}",
					"\\par\\vspace{12pt}",
				]
			: []),
		...body,
		"\\end{document}",
	]
		.filter((line) => line !== "")
		.join("\n")
}

/** Just the slice of Workers AI the spec call needs. */
type SpecAI = {
	run(
		model: string,
		input: {
			messages: Array<{ role: string; content: string }>
			max_tokens?: number
		},
	): Promise<unknown>
}

/** Just the slice of Workers AI the spec call needs. */

/** Same model the career tailoring uses; it holds JSON reliably. */
const SPEC_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

/**
 * One model call: topic + research notes in, report spec out. Failure of any
 * kind returns null — the caller answers in text instead of a broken PDF.
 */
/** One planning call: what must the document contain? Returns the clamped plan. */
export async function requestReportPlan(
	ai: SpecAI | undefined,
	args: { topic: string; instruction: string },
	traceId: string,
): Promise<ReportPlan | null> {
	if (!ai) return null
	const prompt = buildReportPlanPrompt(args)
	try {
		const result = (await ai.run(SPEC_MODEL, {
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			max_tokens: 1_200,
		})) as unknown
		const shaped = result as {
			response?: unknown
			choices?: Array<{ message?: { content?: unknown } }>
		}
		const response = shaped?.response
		const content = shaped?.choices?.[0]?.message?.content
		const text = typeof response === "string" ? response : typeof content === "string" ? content : ""
		if (!text) {
			console.log(
				`[company-brain][${traceId}] report plan: unreadable reply from ${SPEC_MODEL}`,
			)
			return null
		}
		return parseReportPlan(text)
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] report plan call failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return null
	}
}

export async function requestReportSpec(
	ai: SpecAI | undefined,
	args: {
		topic: string
		instruction: string
		notes: string
		plan?: ReportPlan | null
		failures?: string[]
	},
	traceId: string,
): Promise<string | null> {
	if (!ai) return null
	const prompt = buildReportSpecPrompt(args)
	try {
		const result = (await ai.run(SPEC_MODEL, {
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			max_tokens: 4096,
		})) as unknown
		// The Ai binding answers messages-input calls with the OpenAI-shaped
		// object; plain-prompt calls arrive as {response}. Read both.
		const shaped = result as {
			response?: unknown
			choices?: Array<{ message?: { content?: unknown } }>
		}
		const response = shaped?.response
		const content = shaped?.choices?.[0]?.message?.content
		const text =
			typeof response === "string"
				? response
				: typeof content === "string"
					? content
					: ""
		if (!text) {
			console.log(
				`[company-brain][${traceId}] report spec: unreadable reply from ${SPEC_MODEL}`,
			)
		}
		return text || null
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] report spec call failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return null
	}
}
