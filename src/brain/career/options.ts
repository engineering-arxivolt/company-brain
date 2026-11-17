import { withoutAccents } from "./document-ask"
import { type CareerProfile, type ResumeEntry, entryLabel, resolveExperienceEntry } from "./profile"
import { numericTokens, rubricLines, WEAK_OPENERS } from "./rubric"
import { CAREER_MODEL, type CareerAI, modelReplyText } from "./tailor"
import { clampProse } from "./text"

/**
 * Alternatives for one bullet, each with a reason the asker can act on.
 *
 * A silent rewrite asks the asker to trust the model. An offer does the opposite:
 * the model proposes two to four versions with a stated trade-off, code verifies
 * the parts that can be verified (no invented number, no duty-phrase opener, no
 * duplicate of the original), and nothing changes until a number comes back.
 *
 * The offer is persisted (`pendingOptions`) and the pick is applied as an
 * ordinary `set-bullet` edit, so choosing an option goes through the same
 * validation and rendering as typing the sentence yourself.
 */

export const MAX_OPTIONS = 4
const MIN_OPTIONS = 2
/** An offer older than this is stale: the asker has moved on. */
export const OPTIONS_TTL_MS = 60 * 60 * 1000

export type PendingBulletOption = {
	text: string
	why: string
	approach?: string
}

export type PendingBulletOptions = {
	/** Resolved label, e.g. "Software Engineer — GRIFFIN Global Technologies". */
	entry: string
	/** 1-based bullet number within that entry. */
	index: number
	createdAt: number
	options: PendingBulletOption[]
}

/** An option plus the facts code could verify about it. */
export type BulletOption = PendingBulletOption & {
	signals: {
		/** Every quantity in the original survives in the option. */
		keepsOriginalMetric: boolean
		/** Posting words the option names that the original did not. */
		adds: string[]
		length: number
	}
}

/** "give me options for bullet 2", "alternatives for the GRIFFIN summary". */
const OPTIONS_ASK =
	/\b(?:options?|alternatives?|variants?|choices?|versions?)\b/i

export function careerOptionsAsk(text: string): string | null {
	const instruction = text.trim()
	if (!instruction || instruction.length > 600) return null
	return OPTIONS_ASK.test(withoutAccents(instruction)) ? instruction : null
}

const ORDINALS: Record<string, number> = {
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	sixth: 6,
	"1st": 1,
	"2nd": 2,
	"3rd": 3,
	"4th": 4,
}

/**
 * Read a reply to an offered set: `2`, `use option 2`, `the second one`, `keep`.
 *
 * Deliberately strict — anything that is not *only* a choice falls through to the
 * normal edit/build paths, so "change the date to 2024" can never be read as
 * "option 2".
 */
export function optionPick(
	text: string,
	count: number,
): number | "keep" | null {
	const plain = withoutAccents(text).toLowerCase().replace(/\s+/g, " ").trim()
	if (!plain || plain.length > 48) return null
	if (
		/^(?:no|nope|none|neither|no thanks|none of (?:them|these|those)|neither of (?:them|these)|don'?t|do not|keep(?: it| that)?|leave (?:it|that)(?: as is)?|cancel|stop|nevermind|never mind)$/.test(
			plain,
		)
	) {
		return "keep"
	}
	const chosen =
		plain.match(/^(?:use |pick |choose |go with |take )?(?:option |number )?#?(\d)$/)?.[1] ??
		plain.match(
			/^(?:use |pick |choose |go with |take )?(?:the )?(first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th)(?: one)?$/,
		)?.[1]
	if (!chosen) return null
	const value = ORDINALS[chosen] ?? Number(chosen)
	return Number.isInteger(value) && value >= 1 && value <= count
		? value
		: null
}

export function pendingOptionsFresh(
	pending: PendingBulletOptions | undefined,
	now = Date.now(),
): boolean {
	return Boolean(pending && now - pending.createdAt < OPTIONS_TTL_MS)
}

/** The offer as an ordinary edit, so a pick reuses the whole edit path. */
export function optionAsEdit(
	pending: PendingBulletOptions,
	pick: number,
): { op: "set-bullet"; entry: string; index: number; text: string } | null {
	const option = pending.options[pick - 1]
	if (!option) return null
	return { op: "set-bullet", entry: pending.entry, index: pending.index, text: option.text }
}

export function buildOptionsPrompt(args: {
	profileMarkdown: string
	instruction: string
	postingBrief?: string
}): { system: string; user: string } {
	return {
		system: [
			"You write alternative versions of ONE existing CV bullet so the person can choose between them.",
			"Reply with ONLY a JSON object, no markdown fences:",
			'{"entry":"<title | employer | Title — Organisation>","index":<1-based bullet number>,"options":[{"approach":"metric-first|requirement-mapped|action-result|shorter","text":"...","why":"..."}]}',
			"",
			"What a CV bullet must do:",
			...rubricLines(),
			"",
			"Rules you must not break:",
			"- Offer 3 options that are genuinely different readings of the same fact, not three rewordings of one sentence.",
			"- Use only facts already in that bullet or elsewhere in the CV. Every number in an option MUST already appear in the CV — an invented metric is worse than a duller option.",
			'- "why": ONE sentence in the asker\'s terms: what this option optimises for and what it costs. Name the trade-off, e.g. "leads with the 50% API reduction because the posting asks for performance; drops the CI/CD detail". Never "clearer and more professional".',
			"- Pick the bullet the instruction points at. If it names an employer, use that. If two entries share a title you MUST write \"Title — Organisation\".",
			"- Reply with the JSON object and nothing else.",
		].join("\n"),
		user: [
			"# CV",
			"",
			args.profileMarkdown,
			"",
			"# What this CV is aimed at",
			"",
			args.postingBrief?.trim() || "No posting is on file. Judge the bullet on its own merits.",
			"",
			"# Instruction",
			"",
			args.instruction,
		].join("\n"),
	}
}

export type ParsedOptions = {
	/** The entry the options are for, once resolved. */
	entry?: ResumeEntry
	/** 1-based bullet number inside that entry. */
	index?: number
	options: BulletOption[]
	/** Why an offered option was withheld. Shown to the asker, never swallowed. */
	rejected: string[]
}

/** Everything the CV states, for "is this number real?" checks. */
function cvCorpus(profile: CareerProfile): string {
	return [
		profile.summary,
		...profile.experience.flatMap((entry) => [
			entry.title,
			entry.organisation,
			entry.period,
			...entry.details,
		]),
		...profile.projects.flatMap((project) => [
			project.name,
			project.period,
			project.stack,
			project.detail,
		]),
		...profile.skills.flatMap((group) => [group.group, ...group.items]),
		...profile.education,
		...profile.certifications,
	].join("\n")
}

/**
 * Turn the model's offer into options that survive contact with the asker.
 *
 * Rejections are collected, not swallowed: "an option was withheld because it
 * invented 40%" is exactly what makes the remaining options credible.
 */
export function parseBulletOptions(
	raw: string | null | undefined,
	profile: CareerProfile,
	args: { keywords?: string[] } = {},
): ParsedOptions {
	const rejected: string[] = []
	if (!raw) return { options: [], rejected: ["no options came back"] }
	const start = raw.indexOf("{")
	const end = raw.lastIndexOf("}")
	if (start < 0 || end <= start) {
		return { options: [], rejected: ["the reply was not an options object"] }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw.slice(start, end + 1))
	} catch {
		return { options: [], rejected: ["the reply was not readable JSON"] }
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { options: [], rejected: ["the reply was not an options object"] }
	}
	const source = parsed as Record<string, unknown>

	const label = typeof source.entry === "string" ? source.entry.trim() : ""
	const index =
		typeof source.index === "number" ? Math.trunc(source.index) : Number.NaN
	const match = resolveExperienceEntry(profile, label)
	if (!match.ok) {
		rejected.push(
			match.reason === "none"
				? `the reply pointed at "${label}", which is not on the CV`
				: `"${label}" names ${match.candidates.length} entries — say which employer first`,
		)
		return { options: [], rejected }
	}
	const entry = match.entry
	const original = entry.details[index - 1]
	if (!original) {
		rejected.push(
			`bullet ${Number.isNaN(index) ? "(none)" : index} does not exist under "${entryLabel(entry)}" (it has ${entry.details.length})`,
		)
		return { options: [], rejected }
	}

	const allowed = numericTokens(cvCorpus(profile))
	const keywords = (args.keywords ?? []).map((keyword) => keyword.toLowerCase())
	const originalNumbers = numericTokens(original)
	const seen = new Set<string>([
		original.toLowerCase().replace(/\s+/g, " ").trim(),
	])
	const options: BulletOption[] = []

	for (const item of Array.isArray(source.options) ? source.options : []) {
		if (options.length >= MAX_OPTIONS) break
		if (typeof item !== "object" || item === null) {
			rejected.push("one option was not an object")
			continue
		}
		const record = item as Record<string, unknown>
		const rawText = typeof record.text === "string" ? record.text.trim() : ""
		if (!rawText) {
			rejected.push("one option had no text")
			continue
		}
		if (rawText.length > 400) {
			rejected.push(
				`"${rawText.slice(0, 40)}…" is ${rawText.length} characters — too long for one bullet`,
			)
			continue
		}
		const text = clampProse(rawText, 400)
		if (!text) continue
		if (WEAK_OPENERS.test(text)) {
			rejected.push(`"${text.slice(0, 40)}…" opens with a duty phrase`)
			continue
		}
		const invented = [...numericTokens(text)].filter(
			(token) => !allowed.has(token),
		)
		if (invented.length) {
			rejected.push(
				`"${text.slice(0, 40)}…" invents the number ${invented.join(", ")} — the CV does not contain it`,
			)
			continue
		}
		const key = text.toLowerCase().replace(/\s+/g, " ").trim()
		if (seen.has(key)) {
			rejected.push(`"${text.slice(0, 40)}…" is a duplicate`)
			continue
		}
		const why =
			typeof record.why === "string"
				? record.why.replace(/\s+/g, " ").trim()
				: ""
		if (why.length < 20) {
			rejected.push(`"${text.slice(0, 40)}…" came with no usable reason`)
			continue
		}
		seen.add(key)
		const lowered = text.toLowerCase()
		const adds = keywords
			.filter(
				(keyword) =>
					lowered.includes(keyword) &&
					!original.toLowerCase().includes(keyword),
			)
			.slice(0, 2)
		options.push({
			text,
			why: why.slice(0, 220),
			approach:
				typeof record.approach === "string"
					? record.approach.slice(0, 40)
					: undefined,
			signals: {
				keepsOriginalMetric: [...originalNumbers].every((token) =>
					numericTokens(text).has(token),
				),
				adds,
				length: text.length,
			},
		})
	}

	if (options.length < MIN_OPTIONS) {
		rejected.push(
			options.length
				? "only one usable option came back"
				: "no usable options came back",
		)
	}
	return {
		entry,
		index,
		options: options.length >= MIN_OPTIONS ? options : [],
		rejected,
	}
}



/**
 * One model call: read the CV (and what it is aimed at), propose alternatives for
 * one bullet. Failure returns null — the caller then says so instead of inventing
 * options itself.
 */
export async function requestBulletOptions(
	ai: CareerAI | undefined,
	args: { profileMarkdown: string; instruction: string; postingBrief?: string },
	traceId: string,
): Promise<string | null> {
	if (!ai) return null
	const prompt = buildOptionsPrompt(args)
	try {
		const result = (await ai.run(CAREER_MODEL, {
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			max_tokens: 1_100,
		})) as unknown
		const text = modelReplyText(result)
		if (!text) {
			console.log(
				`[company-brain][${traceId}] career options: unreadable reply from ${CAREER_MODEL}`,
			)
		}
		return text || null
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] career options call failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return null
	}
}

/** The pending offer to persist, once the options have been validated. */
export function toPendingOptions(args: {
	entry: ResumeEntry
	index: number
	/** Accepts full `BulletOption`s too — only the text, reason and approach persist. */
	options: PendingBulletOption[]
	now?: number
}): PendingBulletOptions {
	return {
		entry: entryLabel(args.entry),
		index: args.index,
		createdAt: args.now ?? Date.now(),
		options: args.options.map(({ text, why, approach }) => ({
			text,
			why,
			approach,
		})),
	}
}

/**
 * What the chat message must say when options are offered.
 *
 * The reasons travel with the text, and the machine checks sit beside them, so
 * "why is this an option" is answered twice: once by the model's stated
 * trade-off, once by facts code could verify.
 */
export function renderBulletOptions(args: {
	entry: string
	index: number
	total: number
	original: string
	options: BulletOption[]
	rejected: string[]
}): string {
	const lines = ["<bullet_options>"]
	if (!args.options.length) {
		lines.push(
			`No usable alternative came back for bullet ${args.index} under "${args.entry}".`,
			...(args.rejected.length ? [`Withheld: ${args.rejected.join("; ")}.`] : []),
			"Say so plainly and ask what to optimise for (impact, brevity, a specific requirement). Do not paste the CV or invent an option.",
			"</bullet_options>",
		)
		return lines.join("\n")
	}
	lines.push(
		`Alternatives for bullet ${args.index} of ${args.total} under "${args.entry}".`,
		`Current: "${args.original}"`,
		"Nothing has been applied and no document was rebuilt — this is a choice, not a change.",
		"",
	)
	args.options.forEach((option, at) => {
		lines.push(`${at + 1}. "${option.text}"`, `   Why: ${option.why}`)
		const kept = [...numericTokens(args.original)].filter((token) =>
			numericTokens(option.text).has(token),
		)
		const checked: string[] = []
		if (kept.length) checked.push(`keeps the original ${kept.join(", ")}`)
		if (option.signals.adds.length) {
			checked.push(
				`names ${option.signals.adds.map((word) => `"${word}"`).join(", ")}`,
			)
		}
		checked.push(`${option.signals.length} characters`)
		lines.push(`   Checked: ${checked.join(" · ")}`)
	})
	if (args.rejected.length) {
		lines.push("", `Withheld: ${args.rejected.join("; ")}.`)
	}
	lines.push(
		"",
		`Present these as a numbered list with each reason verbatim, then say: reply 1-${args.options.length} to use one, or "keep" to leave the bullet as it is.`,
		"Do not choose for the asker, do not rewrite the options, and do not paste the CV.",
		"</bullet_options>",
	)
	return lines.join("\n")
}

/** The asker declined the offer: no change, no rebuild, no re-offer. */
export function renderOptionsKept(): string {
	return [
		"<bullet_options>",
		"The asker chose to keep the bullet as it is. Nothing changed and no document was rebuilt.",
		"Confirm in one line. Do not paste the CV and do not offer the same options again.",
		"</bullet_options>",
	].join("\n")
}

