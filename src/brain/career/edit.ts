import { jsonrepair } from "jsonrepair"
import { withoutAccents } from "./document-ask"
import {
	type CareerProfile,
	type ResumeEntry,
	entryLabel,
	resolveExperienceEntry,
} from "./profile"
import { bulletIssues, regressionIssues, rubricLines } from "./rubric"
import { CAREER_MODEL, type CareerAI, modelReplyText } from "./tailor"
import { clampLine, clampProse } from "./text"

/**
 * Edits to a CV, applied in code.
 *
 * The model never touches LaTeX or rewrites the document. It reads the current
 * CV plus one instruction ("make the Nathan Digital dates Sep 2022 – Jun 2024",
 * "cut the third bullet under GRIFFIN") and answers with a small JSON patch.
 * Every patch is validated against the parsed profile, applied to a copy, and
 * then rendered by the same deterministic renderer as any other CV. An edit that
 * cannot be resolved is *reported*, never silently dropped — a CV that quietly
 * ignores "change the date" is the same failure as a CV that invents one.
 *
 * This is the only place that knows how to change facts. Tailoring and page
 * fitting stay untouched, so there is exactly one parser and one renderer.
 */

export type CvEdit =
	| { op: "set-summary"; text: string }
	| {
			op: "set-entry"
			entry: string
			title?: string
			organisation?: string
			period?: string
	  }
	| { op: "set-bullet"; entry: string; index: number; text: string }
	| { op: "replace-in-bullet"; entry: string; find: string; text: string }
	| { op: "add-bullet"; entry: string; text: string; after?: number }
	| { op: "remove-bullet"; entry: string; index?: number; find?: string }
	| { op: "remove-entry"; entry: string }
	| { op: "move-entry"; entry: string; position: number }
	| {
			op: "set-contact"
			field: "location" | "email" | "phone"
			value: string
	  }
	| { op: "set-availability"; items: string[] }
	| { op: "set-skills"; group: string; items: string[] }
	| {
			op: "set-project"
			project: string
			period?: string
			stack?: string
			detail?: string
	  }
	| { op: "remove-project"; project: string }
	| {
			op: "set-section"
			section: "education" | "certifications" | "references"
			items: string[]
	  }
	| { op: "set-letter-paragraphs"; paragraphs: string[] }

export type CvEditOutcome = {
	/** A new profile; the input is never mutated. */
	profile: CareerProfile
	/** Present when the instruction replaced the letter's body. */
	coverLetterParagraphs?: string[]
	/** One human-readable line per change that landed. */
	applied: string[]
	/** One human-readable line per change that could not be resolved. */
	rejected: string[]
	/**
	 * Changes that landed but cost something: a bullet that lost the number the
	 * original carried, a duty-phrase opener. Reported, never silently re-run —
	 * the asker decides what to do about it.
	 */
	concerns: string[]
	/** Which documents the applied edits touch, for the build. */
	touched: { cv: boolean; letter: boolean }
}

const CONTACT_FIELDS = ["location", "email", "phone"] as const
const SECTION_FIELDS = ["education", "certifications", "references"] as const

function cloneProfile(profile: CareerProfile): CareerProfile {
	return {
		...profile,
		contact: {
			...profile.contact,
			links: profile.contact.links.map((link) => ({ ...link })),
			availability: [...profile.contact.availability],
		},
		experience: profile.experience.map((entry) => ({
			...entry,
			details: [...entry.details],
		})),
		projects: profile.projects.map((project) => ({ ...project })),
		skills: profile.skills.map((group) => ({
			group: group.group,
			items: [...group.items],
		})),
		education: [...profile.education],
		certifications: [...profile.certifications],
		references: [...profile.references],
	}
}

function describeEntries(profile: CareerProfile): string {
	const labels = profile.experience.map(entryLabel).filter(Boolean)
	return labels.length ? labels.join("; ") : "none"
}

/**
 * Resolve an edit's target entry, recording why it failed when it does.
 *
 * Never lenient: a real CV has two jobs titled "Software Developer", so "the
 * Software Developer dates" is a question, not a target — editing the first one
 * puts a date on the wrong employer. An employer name alone is enough, because
 * that is how the asker says it.
 */
function targetEntry(
	profile: CareerProfile,
	label: string,
	rejected: string[],
): ResumeEntry | undefined {
	const match = resolveExperienceEntry(profile, label)
	if (match.ok) return match.entry
	if (match.reason === "none") {
		rejected.push(
			`no experience entry matches "${label}" — the CV has: ${describeEntries(profile)}`,
		)
		return undefined
	}
	rejected.push(
		`"${label}" matches ${match.candidates.length} entries (${match.candidates
			.map(entryLabel)
			.join("; ")}) — say which employer`,
	)
	return undefined
}

function bulletIndex(entry: ResumeEntry, index: number): number | null {
	return Number.isInteger(index) && index >= 1 && index <= entry.details.length
		? index - 1
		: null
}

/**
 * Locate one bullet by a substring the asker quoted. Ambiguity is a rejection,
 * not a guess: replacing the wrong achievement is worse than asking which one.
 */
function matchBullet(
	entry: ResumeEntry,
	find: string,
): { index: number; matched: string } | "none" | "many" {
	const needle = find.trim()
	if (!needle) return "none"
	let hits = entry.details.flatMap((detail, index) =>
		detail.includes(needle) ? [{ index, matched: needle }] : [],
	)
	if (!hits.length) {
		const lower = needle.toLowerCase()
		hits = entry.details.flatMap((detail, index) => {
			const at = detail.toLowerCase().indexOf(lower)
			return at >= 0
				? [{ index, matched: detail.slice(at, at + needle.length) }]
				: []
		})
	}
	if (!hits.length) return "none"
	if (hits.length > 1) return "many"
	return hits[0] ?? "none"
}

function listItems(value: unknown, max: number, each: number): string[] | null {
	if (!Array.isArray(value)) return null
	const items = value
		.map((item) => clampLine(item, each))
		.filter((item): item is string => Boolean(item))
		.slice(0, max)
	return items.length ? items : null
}

/**
 * Apply a validated patch. Ops are applied in order, so a later op sees the
 * result of an earlier one (set the period, then move the entry).
 */
export function applyCvEdits(
	profile: CareerProfile,
	edits: readonly CvEdit[],
): CvEditOutcome {
	const next = cloneProfile(profile)
	const applied: string[] = []
	const rejected: string[] = []
	const concerns: string[] = []
	const touched = { cv: false, letter: false }
	let coverLetterParagraphs: string[] | undefined

	const landing = (message: string) => {
		applied.push(message)
		touched.cv = true
	}
	/** A change that landed but cost something worth saying out loud. */
	const noteConcerns = (before: string | null, after: string) => {
		const issues = before ? regressionIssues(before, after) : bulletIssues(after)
		for (const issue of issues) {
			const detail = `${after.slice(0, 60)}… — ${issue.detail}`
			if (!concerns.includes(detail)) concerns.push(detail)
		}
	}

	for (const edit of edits) {
		if (edit.op === "set-summary") {
			const summary = clampProse(edit.text, 1_200)
			if (!summary) {
				rejected.push("the new summary was empty, so the CV kept its own")
				continue
			}
			next.summary = summary
			landing("Professional summary rewritten")
			continue
		}

		if (edit.op === "set-letter-paragraphs") {
			const paragraphs = listItems(edit.paragraphs, 6, 900)
			if (!paragraphs) {
				rejected.push("the new cover-letter paragraphs were empty")
				continue
			}
			coverLetterParagraphs = paragraphs
			touched.letter = true
			applied.push(
				`Cover letter body replaced (${paragraphs.length} paragraphs)`,
			)
			continue
		}

		if (edit.op === "set-contact") {
			const field = CONTACT_FIELDS.find((name) => name === edit.field)
			const value = clampLine(edit.value, 200)
			if (!field || !value) {
				rejected.push(
					`"${String(edit.field)}" is not a contact field the CV has`,
				)
				continue
			}
			next.contact[field] = value
			landing(`Contact ${field} → ${value}`)
			continue
		}

		if (edit.op === "set-availability") {
			const items = listItems(edit.items, 6, 160)
			if (!items) {
				rejected.push("the availability list was empty")
				continue
			}
			next.contact.availability = items
			landing(`Availability → ${items.join("; ")}`)
			continue
		}

		if (edit.op === "set-skills") {
			const group = clampLine(edit.group, 80)
			const items = listItems(edit.items, 40, 60)
			if (!group || !items) {
				rejected.push("the skill change named no group or no skills")
				continue
			}
			const existing = next.skills.find(
				(candidate) => candidate.group.toLowerCase() === group.toLowerCase(),
			)
			if (existing) {
				existing.items = items
				landing(`Skills › ${existing.group}: ${items.join(", ")}`)
			} else {
				next.skills.push({ group, items })
				landing(`Skills: added group ${group} (${items.join(", ")})`)
			}
			continue
		}

		if (edit.op === "set-section") {
			const section = SECTION_FIELDS.find((name) => name === edit.section)
			const items = listItems(edit.items, 20, 300)
			if (!section || !items) {
				rejected.push(`"${String(edit.section)}" is not a section the CV has`)
				continue
			}
			next[section] = items
			landing(
				`${section[0]?.toUpperCase()}${section.slice(1)} replaced (${items.length} items)`,
			)
			continue
		}

		if (edit.op === "set-project") {
			const wanted = clampLine(edit.project, 120)?.toLowerCase() ?? ""
			const project = next.projects.find(
				(candidate) =>
					candidate.name.toLowerCase() === wanted ||
					candidate.name.toLowerCase().includes(wanted),
			)
			if (!project) {
				const names = next.projects.map((candidate) => candidate.name).join(", ")
				rejected.push(
					`no project matches "${edit.project}" — the CV has: ${names || "none"}`,
				)
				continue
			}
			const period = clampLine(edit.period, 80)
			const stack = clampLine(edit.stack, 160)
			const detail = clampLine(edit.detail, 900)
			if (!period && !stack && !detail) {
				rejected.push(`the project change for "${project.name}" was empty`)
				continue
			}
			if (period) project.period = period
			if (stack) project.stack = stack
			if (detail) project.detail = detail
			landing(`Project › ${project.name}: updated`)
			continue
		}

		if (edit.op === "remove-project") {
			const wanted = clampLine(edit.project, 120)?.toLowerCase() ?? ""
			const at = next.projects.findIndex(
				(candidate) =>
					candidate.name.toLowerCase() === wanted ||
					candidate.name.toLowerCase().includes(wanted),
			)
			if (at < 0) {
				rejected.push(`no project matches "${edit.project}"`)
				continue
			}
			const [removed] = next.projects.splice(at, 1)
			landing(`Project › ${removed?.name ?? edit.project}: removed`)
			continue
		}

		if (edit.op === "set-entry") {
			const entry = targetEntry(next, edit.entry, rejected)
			if (!entry) continue
			const label = entryLabel(entry)
			const title = clampLine(edit.title, 160)
			const organisation = clampLine(edit.organisation, 200)
			const period = clampLine(edit.period, 80)
			if (!title && !organisation && !period) {
				rejected.push(`the change for "${label}" named nothing to set`)
				continue
			}
			const changes: string[] = []
			if (title && title !== entry.title) {
				entry.title = title
				changes.push(`title → ${title}`)
			}
			if (organisation && organisation !== entry.organisation) {
				entry.organisation = organisation
				changes.push(`employer → ${organisation}`)
			}
			if (period && period !== entry.period) {
				entry.period = period
				changes.push(`dates → ${period}`)
			}
			if (!changes.length) {
				applied.push(`Experience › ${label}: already as asked`)
				continue
			}
			landing(`Experience › ${label}: ${changes.join(", ")}`)
			continue
		}

		if (edit.op === "remove-entry") {
			const entry = targetEntry(next, edit.entry, rejected)
			if (!entry) continue
			const label = entryLabel(entry)
			next.experience.splice(next.experience.indexOf(entry), 1)
			landing(`Experience › ${label}: removed`)
			continue
		}

		if (edit.op === "move-entry") {
			const entry = targetEntry(next, edit.entry, rejected)
			if (!entry) continue
			const label = entryLabel(entry)
			const position = Number.isInteger(edit.position) ? edit.position : 0
			if (position < 1 || position > next.experience.length) {
				rejected.push(
					`position ${edit.position} is outside the CV's ${next.experience.length} experience entries`,
				)
				continue
			}
			next.experience.splice(next.experience.indexOf(entry), 1)
			next.experience.splice(position - 1, 0, entry)
			landing(`Experience › ${label}: moved to position ${position}`)
			continue
		}

		// Everything left is bullet work, which needs a resolved entry.
		const entry = targetEntry(next, edit.entry, rejected)
		if (!entry) continue
		const label = entryLabel(entry)

		if (edit.op === "set-bullet") {
			const at = bulletIndex(entry, edit.index)
			const text = clampProse(edit.text, 400)
			if (at === null) {
				rejected.push(
					`bullet ${edit.index} does not exist under "${label}" (it has ${entry.details.length})`,
				)
				continue
			}
			if (!text) {
				rejected.push(`the replacement bullet under "${label}" was empty`)
				continue
			}
			const previous = entry.details[at] ?? ""
			entry.details[at] = text
			noteConcerns(previous, text)
			landing(`Experience › ${label}: bullet ${edit.index} rewritten`)
			continue
		}

		if (edit.op === "replace-in-bullet") {
			const text = clampLine(edit.text, 400)
			const hit = matchBullet(entry, edit.find ?? "")
			if (!text) {
				rejected.push(`the replacement text under "${label}" was empty`)
				continue
			}
			if (hit === "none") {
				rejected.push(`no bullet under "${label}" contains "${edit.find}"`)
				continue
			}
			if (hit === "many") {
				rejected.push(
					`"${edit.find}" appears in more than one bullet under "${label}" — quote more of the line`,
				)
				continue
			}
			const before = entry.details[hit.index] ?? ""
			entry.details[hit.index] = before.replace(hit.matched, () => text)
			noteConcerns(before, entry.details[hit.index] ?? "")
			landing(
				`Experience › ${label}: bullet ${hit.index + 1} changed "${hit.matched}" → "${text}"`,
			)
			continue
		}

		if (edit.op === "add-bullet") {
			const text = clampProse(edit.text, 400)
			if (!text) {
				rejected.push(`the new bullet under "${label}" was empty`)
				continue
			}
			if (entry.details.includes(text)) {
				applied.push(`Experience › ${label}: bullet already present`)
				continue
			}
			const after = edit.after === undefined ? entry.details.length : edit.after
			if (Number.isInteger(after) && after >= 1 && after <= entry.details.length) {
				entry.details.splice(after, 0, text)
			} else {
				entry.details.push(text)
			}
			noteConcerns(null, text)
			landing(`Experience › ${label}: bullet added`)
			continue
		}

		if (edit.op === "remove-bullet") {
			let at: number | null =
				typeof edit.index === "number" ? bulletIndex(entry, edit.index) : null
			let bulletNumber =
				typeof edit.index === "number" ? String(edit.index) : ""
			if (typeof edit.index === "number" && at === null) {
				rejected.push(
					`bullet ${edit.index} does not exist under "${label}" (it has ${entry.details.length})`,
				)
				continue
			}
			if (at === null) {
				const hit = matchBullet(entry, edit.find ?? "")
				if (hit === "none" || hit === "many") {
					rejected.push(
						hit === "many"
							? `"${edit.find}" appears in more than one bullet under "${label}" — quote more of the line`
							: `no bullet under "${label}" contains "${edit.find}"`,
					)
					continue
				}
				at = hit.index
				bulletNumber = String(hit.index + 1)
			}
			if (entry.details.length <= 1) {
				rejected.push(
					`"${label}" has one bullet left — rewrite it instead of removing it`,
				)
				continue
			}
			const [removed] = entry.details.splice(at, 1)
			landing(
				`Experience › ${label}: bullet ${bulletNumber} removed ("${(removed ?? "").slice(0, 60)}…")`,
			)
			continue
		}
	}

	return {
		profile: next,
		coverLetterParagraphs,
		applied,
		rejected,
		concerns,
		touched,
	}
}

/**
 * Ops that describe a *fact* rather than a presentation choice: a wrong date or
 * phone number is wrong in every application, so it is carried into the working
 * CV that future jobs are tailored from. Rewording, reordering, removing and
 * trimming are per-application decisions and stay with the document the asker is
 * looking at — persisting "drop the PowerLearn job" would quietly shorten every
 * future CV.
 */
const FACT_OPS: ReadonlySet<CvEdit["op"]> = new Set([
	"set-entry",
	"set-contact",
	"set-skills",
	"set-project",
])

export function isFactEdit(edit: CvEdit): boolean {
	return FACT_OPS.has(edit.op)
}

/** The prompt that turns "change the date" into a small, validated patch. */
export function buildCvEditPrompt(
	profileMarkdown: string,
	instruction: string,
	/** The posting this CV is aimed at, when one is on file. */
	brief?: string,
): { system: string; user: string } {
	return {
		system: [
			"You revise a CV. You never rewrite the document; you reply with a JSON array of edit operations.",
			"Reply with ONLY a JSON array, no markdown fences. Example:",
			'[{"op":"set-entry","entry":"Frontend Developer","period":"September 2022 – June 2024"}]',
			"",
			"Operations (indexes are 1-based):",
			'- {"op":"set-entry","entry":"<title>","title?":"...","organisation?":"...","period?":"..."} — dates are prose, e.g. "September 2024 – June 2025".',
			'- {"op":"set-bullet","entry":"<title>","index":1,"text":"..."} — replace one bullet.',
			'- {"op":"replace-in-bullet","entry":"<title>","find":"<exact text from one bullet>","text":"..."} — change part of a bullet.',
			'- {"op":"add-bullet","entry":"<title>","text":"...","after?":2}',
			'- {"op":"remove-bullet","entry":"<title>","index?":2,"find?":"..."}',
			'- {"op":"remove-entry","entry":"<title>"}',
			'- {"op":"move-entry","entry":"<title>","position":2}',
			'- {"op":"set-summary","text":"..."}',
			'- {"op":"set-contact","field":"location|email|phone","value":"..."}',
			'- {"op":"set-availability","items":["..."]}',
			'- {"op":"set-skills","group":"<group>","items":["..."]} — the complete new list for that group.',
			'- {"op":"set-project","project":"<name>","period?":"...","stack?":"...","detail?":"..."}',
			'- {"op":"remove-project","project":"<name>"}',
			'- {"op":"set-section","section":"education|certifications|references","items":["..."]}',
			'- {"op":"set-letter-paragraphs","paragraphs":["..."]}',
			"",
			"What a CV bullet must do:",
			...rubricLines(),
			"",
			"Rules:",
			"- Change exactly what the instruction asks and nothing else. Do not re-tailor, re-order or trim.",
			"- When the instruction shortens or rewrites a bullet, keep the result and any number it carries. Cut context and scaffolding first, never the outcome.",
			'- Name an experience entry by its title, its employer, or "Title — Organisation". When two entries share a title you MUST use "Title — Organisation", because a bare title is ambiguous and will be refused.',
			"- Copy titles, project names and skill-group names exactly as the CV writes them.",
			"- Use only facts from the instruction or facts the CV already contains. Never invent an employer, date, degree, metric or skill.",
			"- If the instruction needs a fact the CV does not contain, return [] instead of inventing it.",
			"- Keep the CV's existing language and voice unless the instruction explicitly asks for a different one.",
			"- Reply with the JSON array and nothing else.",
		].join("\n"),
		user: [
			"# Current CV",
			"",
			profileMarkdown,
			"",
			"# What this CV is aimed at",
			"",
			brief?.trim() || "No posting is on file. Judge the change on the CV's own facts.",
			"",
			"# Edit instruction",
			"",
			instruction,
		].join("\n"),
	}
}

function editString(
	source: Record<string, unknown>,
	key: string,
	max: number,
): string | undefined {
	return clampLine(source[key], max)
}

function editNumber(
	source: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = source[key]
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value)
	}
	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Number(value.trim())
	}
	return undefined
}

/** One array element → a CvEdit, or null when it is not a shape we can apply. */
function normaliseEdit(item: unknown): CvEdit | null {
	if (typeof item !== "object" || item === null) return null
	const source = item as Record<string, unknown>
	const op = typeof source.op === "string" ? source.op : ""
	const entry = editString(source, "entry", 160)

	switch (op) {
		case "set-summary": {
			const text = editString(source, "text", 1_200)
			return text ? { op, text } : null
		}
		case "set-entry": {
			if (!entry) return null
			const title = editString(source, "title", 160)
			const organisation = editString(source, "organisation", 200)
			const period = editString(source, "period", 80)
			return title || organisation || period
				? { op, entry, title, organisation, period }
				: null
		}
		case "set-bullet": {
			const index = editNumber(source, "index")
			const text = editString(source, "text", 400)
			return entry && index && text ? { op, entry, index, text } : null
		}
		case "replace-in-bullet": {
			const find = editString(source, "find", 300)
			const text = editString(source, "text", 400)
			return entry && find && text ? { op, entry, find, text } : null
		}
		case "add-bullet": {
			const text = editString(source, "text", 400)
			const after = editNumber(source, "after")
			return entry && text ? { op, entry, text, after } : null
		}
		case "remove-bullet": {
			const index = editNumber(source, "index")
			const find = editString(source, "find", 300)
			return entry && (index || find) ? { op, entry, index, find } : null
		}
		case "remove-entry":
			return entry ? { op, entry } : null
		case "move-entry": {
			const position = editNumber(source, "position")
			return entry && position ? { op, entry, position } : null
		}
		case "set-contact": {
			const field = editString(source, "field", 40)
			const value = editString(source, "value", 200)
			if (!value) return null
			const known = CONTACT_FIELDS.find((name) => name === field)
			return known ? { op, field: known, value } : null
		}
		case "set-availability": {
			const items = listItems(source.items, 6, 160)
			return items ? { op, items } : null
		}
		case "set-skills": {
			const group = editString(source, "group", 80)
			const items = listItems(source.items, 40, 60)
			return group && items ? { op, group, items } : null
		}
		case "set-project": {
			const project = editString(source, "project", 120)
			const period = editString(source, "period", 80)
			const stack = editString(source, "stack", 160)
			const detail = editString(source, "detail", 900)
			return project && (period || stack || detail)
				? { op, project, period, stack, detail }
				: null
		}
		case "remove-project": {
			const project = editString(source, "project", 120)
			return project ? { op, project } : null
		}
		case "set-section": {
			const section = editString(source, "section", 40)
			const items = listItems(source.items, 20, 300)
			const known = SECTION_FIELDS.find((name) => name === section)
			return known && items ? { op, section: known, items } : null
		}
		case "set-letter-paragraphs": {
			const paragraphs = listItems(source.paragraphs, 6, 900)
			return paragraphs ? { op, paragraphs } : null
		}
		default:
			return null
	}
}

/**
 * Turn the model's reply into ops the applier can trust. JSON is extracted from
 * whatever came back (fences, prose) and repaired if needed; each element is
 * shape-checked, and junk is counted rather than crashing the build.
 */
export function parseCvEditPlan(raw: string | null | undefined): {
	edits: CvEdit[]
	dropped: number
} {
	if (!raw) return { edits: [], dropped: 0 }
	const start = raw.indexOf("[")
	const end = raw.lastIndexOf("]")
	if (start < 0 || end <= start) return { edits: [], dropped: 0 }
	const slice = raw.slice(start, end + 1)
	let parsed: unknown
	try {
		parsed = JSON.parse(slice)
	} catch {
		try {
			parsed = JSON.parse(jsonrepair(slice))
		} catch {
			return { edits: [], dropped: 0 }
		}
	}
	if (!Array.isArray(parsed)) return { edits: [], dropped: 0 }
	const edits: CvEdit[] = []
	let dropped = 0
	for (const item of parsed.slice(0, 20)) {
		const edit = normaliseEdit(item)
		if (edit) edits.push(edit)
		else dropped += 1
	}
	return { edits, dropped }
}

/**
 * One model call, one job: read the current CV and the instruction, answer with
 * the patch JSON. Failure of any kind returns null, and the caller then reports
 * that nothing changed — it never falls back to hand-writing LaTeX, which is
 * what made "change the date" crash a sandbox turn.
 */
export async function requestCvEditPlan(
	ai: CareerAI | undefined,
	profileMarkdown: string,
	instruction: string,
	traceId: string,
	/** The posting this CV is aimed at, when one is on file. */
	brief?: string,
): Promise<string | null> {
	if (!ai) return null
	const prompt = buildCvEditPrompt(profileMarkdown, instruction, brief)
	try {
		const result = (await ai.run(CAREER_MODEL, {
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			max_tokens: 1_024,
		})) as unknown
		const text = modelReplyText(result)
		if (!text) {
			console.log(
				`[company-brain][${traceId}] career edit: unreadable reply from ${CAREER_MODEL}`,
			)
		}
		return text || null
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] career edit call failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return null
	}
}

/**
 * Does this message ask to *change* an existing CV rather than build one?
 *
 * Deliberately narrow: an edit verb plus a thing on a CV ("the date", "bullet
 * two", "the summary"). A bare "update my CV" is a fresh build, and a pasted
 * job posting is longer than any edit instruction, so neither can be misread as
 * a patch. Callers gate this on the thread already being a CV thread, because
 * "change the meeting date" is not a CV edit.
 */
const EDIT_VERB =
	/\b(change|update|fix|correct|set|shorten|trim|lengthen|expand|remove|drop|delete|add|insert|replace|rewrite|reword|rephrase|move|swap|rename|adjust|tone|cut)\b/i
const EDIT_TARGET =
	/\b(dates?|periods?|months?|years?|timelines?|bullets?|points?|lines?|summar(?:y|ies)|headlines?|phone|email|e-mail|location|address|city|skills?|sections?|headings?|wording|words?|language|tone|typos?|references?|education|certifications?|projects?|job titles?|titles?)\b/i
/** A fresh-build ask that happens to contain an edit verb: "tailor my CV for X". */
const BUILD_ASK =
	/\b(?:make|create|build|generate|draft|write|prepare|tailor)\b[^.!?]{0,40}\b(?:cv|resume|cover letter)\b/i

export function careerEditInstruction(text: string): string | null {
	const instruction = text.trim()
	if (!instruction || instruction.length > 600) return null
	const plain = withoutAccents(instruction)
	if (BUILD_ASK.test(plain)) return null
	if (!EDIT_VERB.test(plain) || !EDIT_TARGET.test(plain)) return null
	return instruction
}

/**
 * What the chat message must say after an edit.
 *
 * Two jobs: let the model name the real changes instead of guessing, and stop it
 * from "fixing" a rejected edit by rebuilding the file by hand — that path is
 * what produced a truncated LaTeX CV and a sandbox turn that went nowhere.
 */
export function renderCareerEditContext(args: {
	applied: string[]
	rejected: string[]
	documents: Array<{ fileName: string; pages: number }>
	trimmed?: boolean
	/** Things the edit landed but cost; the asker should hear them. */
	concerns?: string[]
}): string {
	const files = args.documents
		.map((doc) => `${doc.fileName} (${doc.pages} page${doc.pages === 1 ? "" : "s"})`)
		.join(", ")
	const lines = ["<career_edit>"]
	if (args.applied.length) {
		lines.push(
			`The documents were rebuilt from the asker's edit and shared again: ${files}.`,
			`Applied: ${args.applied.join("; ")}.`,
		)
		if (args.trimmed) {
			lines.push(
				"The CV ran past two pages, so the pipeline trimmed the least job-relevant material to fit — say so if the asker's change is not all visible.",
			)
		}
	} else {
		lines.push(
			"The asker asked for a change and none of it could be applied, so no document changed.",
		)
	}
	if (args.rejected.length) {
		lines.push(`Not applied: ${args.rejected.join("; ")}.`)
	}
	if (args.concerns?.length) {
		lines.push(
			`Worth flagging: ${args.concerns.join("; ")}. Say it plainly — a shorter bullet that dropped the metric is not an improvement — and offer alternatives if the asker wants them.`,
		)
	}
	lines.push(
		"Say exactly what changed and what did not. If something was rejected, ask for the missing detail instead of claiming it landed. Do not rebuild the document, do not write LaTeX, and do not call sandbox tools for this.",
		"</career_edit>",
	)
	return lines.join("\n")
}
