/**
 * What makes a CV bullet worth its line — the single source of truth.
 *
 * Four prompts used to describe this separately (tailoring, edits, options, and
 * the playbook), which is how a bullet can "lead with a strong verb" in one
 * pipeline and not in the next. Everything reads this file now, and the
 * deterministic checks below enforce the parts of it that can be enforced
 * without a model: a duty-phrase opener, first person, a 220-character ceiling,
 * and a rewrite that silently loses the metric the original carried.
 *
 * These are the standards the rubric names: STAR (Situation/Task → Action →
 * Result) and Google's XYZ ("Accomplished X, as measured by Y, by doing Z").
 * The rubric is prose for the model; `bulletIssues` is the part code can prove.
 */
export const BULLET_RUBRIC = [
	'Opens with a past-tense action verb, never a duty phrase: "Led", "Built", "Cut" — not "Responsible for", "Worked on", "Helped with".',
	"Names a result, not an activity: what changed because of the work. A number from the CV makes it stronger; never invent one.",
	"Outcome first, then method (XYZ): what was accomplished, how it was measured, what was done. A trim must never cut the result.",
	"One line, under 220 characters. If it needs two lines, it is two bullets.",
	"Mirrors the posting's own vocabulary for the skills it actually evidences, and evidences at most two requirements.",
	'No pronouns: "Built", not "I built"; say "the team" only when the distinction matters.',
	'Evidence, not adjectives: "cut API calls by 50%", not "significantly improved performance".',
] as const

/** The opener that turns a result into a job description. */
export const WEAK_OPENERS =
	/^(?:was\s+)?(?:responsible|tasked)\s+(?:for|with)\b|^(?:worked|helped|assisted|involved|participated|contributed|supported|handled)\b/i

/** Claims that sound like evidence and are not. */
export const VAGUE_PHRASES =
	/\b(?:various|several|numerous|many|significantly|substantially|a lot of|etc)\b/i

const NUMBER_WORDS: Record<string, string> = {
	one: "1",
	two: "2",
	three: "3",
	four: "4",
	five: "5",
	six: "6",
	seven: "7",
	eight: "8",
	nine: "9",
	ten: "10",
	eleven: "11",
	twelve: "12",
	thirteen: "13",
	fourteen: "14",
	fifteen: "15",
	sixteen: "16",
	seventeen: "17",
	eighteen: "18",
	nineteen: "19",
	twenty: "20",
	hundred: "100",
	thousand: "1000",
}

/**
 * Every quantity a piece of text states, digits and words alike.
 *
 * Used to enforce "never invent a number": a proposed bullet may only contain
 * quantities that already appear in the source material. It cannot prove the
 * number is used honestly, but it does stop a plausible-looking "40% faster"
 * from appearing out of nowhere.
 */
export function numericTokens(text: string): Set<string> {
	const tokens = new Set<string>()
	for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
		tokens.add((match[0] ?? "").replace(/,/g, ""))
	}
	for (const match of text.matchAll(/\b[a-z]+\b/gi)) {
		const mapped = NUMBER_WORDS[(match[0] ?? "").toLowerCase()]
		if (mapped) tokens.add(mapped)
	}
	return tokens
}

export type BulletIssue = {
	code:
		| "weak-opener"
		| "first-person"
		| "too-long"
		| "vague"
		| "lost-metric"
		| "lost-focus"
	/** One user-facing sentence; this is what the reply and the log quote. */
	detail: string
}

/** Problems provable from the text alone. No model, no posting needed. */
export function bulletIssues(text: string, budget = 220): BulletIssue[] {
	const line = text.trim()
	const issues: BulletIssue[] = []
	// "I helped with X" is the same duty phrase as "helped with X"; the pronoun
	// is a separate problem, so strip it before judging the opener.
	const opener = line.replace(/^(?:I|we)\s+/i, "")
	if (WEAK_OPENERS.test(line) || WEAK_OPENERS.test(opener)) {
		issues.push({
			code: "weak-opener",
			detail: "opens with a duty phrase instead of an action verb",
		})
	}
	if (/\b(?:I|my|me)\b/.test(line)) {
		issues.push({
			code: "first-person",
			detail: "uses first person; CV bullets drop pronouns",
		})
	}
	if (line.length > budget) {
		issues.push({
			code: "too-long",
			detail: `runs ${line.length} characters; keep it under ${budget}`,
		})
	}
	if (VAGUE_PHRASES.test(line)) {
		issues.push({
			code: "vague",
			detail: "leans on an unquantified word instead of evidence",
		})
	}
	return issues
}

/**
 * A rewrite must not lose what the original bullet carried.
 *
 * This is the check a "shorten this" edit needs: shorter is not better if the
 * metric or the posting's own word is the thing that got cut. Comparative by
 * design — it never invents an opinion about the new text, it only reports a
 * subtraction.
 */
export function regressionIssues(
	before: string,
	after: string,
	hints: { focus?: string[] } = {},
): BulletIssue[] {
	const issues = bulletIssues(after)
	const lost = [...numericTokens(before)].filter(
		(token) => !numericTokens(after).has(token),
	)
	if (lost.length) {
		issues.push({
			code: "lost-metric",
			detail: `drops the number ${lost.join(", ")} that the original bullet had`,
		})
	}
	const lowered = after.toLowerCase()
	const focus = (hints.focus ?? []).find(
		(keyword) =>
			before.toLowerCase().includes(keyword) && !lowered.includes(keyword),
	)
	if (focus) {
		issues.push({
			code: "lost-focus",
			detail: `drops "${focus}", which the posting names`,
		})
	}
	return issues
}

/** The rubric as prompt lines, for every career prompt that writes prose. */
export function rubricLines(): string[] {
	return BULLET_RUBRIC.map((rule) => `- ${rule}`)
}
