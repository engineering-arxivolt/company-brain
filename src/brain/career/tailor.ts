import { parseCareerProfile, type CareerProfile, type ResumeEntry } from "./profile"
import { parseJobPosting } from "./job-posting"

/**
 * A per-job tailoring plan the model fills in before the documents render.
 *
 * The model is good at *judgement* (which facts matter for THIS posting, how to
 * phrase them) and terrible at LaTeX. So it never touches the document format:
 * it fills this small plan, every field is sanitised against the parsed base CV,
 * and the renderer decides the layout. A plan that fails validation simply does
 * not reach the documents — the renderer falls back to the base CV as-is.
 */
export type TailoringPlan = {
	/** Job-specific professional summary, facts from the base CV only. */
	summary?: string
	/** Entry titles in the order they should appear (subset of the CV's). */
	experienceOrder?: string[]
	/** Entry title → the cut-down STAR bullets to show for it, job-relevant first. */
	entryDetails?: Record<string, string[]>
	/** Cover letter body paragraphs, 3–5, addressed to this posting. */
	coverLetterParagraphs?: string[]
}

/** The prompt that turns a base CV plus a posting into a tailoring plan. */
export function buildTailorPrompt(
	profileMarkdown: string,
	jobText: string,
	/** Requirements the first plan failed to represent, for the retry. */
	feedback?: string[],
): { system: string; user: string } {
	const feedbackBlock = feedback?.length
		? [
				"",
				"# Coverage check on your previous plan",
				"The posting requires these, and your plan did not represent them:",
				...feedback.map((item) => `- ${item}`),
				"Work each one in through a base-CV fact it genuinely matches, in the",
				"summary or the most relevant entry's bullets. If the base CV truly has",
				"nothing for a requirement, leave it out — never approximate it with an",
				"invention. Also keep everything that was already well matched.",
			].join("\n")
		: ""
	return {
		system: [
			"You tailor CVs and cover letters. You receive a base CV (markdown) and a job posting.",
			"You reply with ONLY a JSON object, no markdown fences, matching this schema:",
			'{"summary": string, "experienceOrder": string[], "entryDetails": {"<exact entry title>": string[]}, "coverLetterParagraphs": string[]}',
			"",
			"Rules you must not break:",
			"- Use only facts that appear in the base CV. Never invent employers, dates, degrees, certifications, metrics, tools or achievements.",
			"- Reorder, merge, rephrase and trim for THIS posting. Omit what this posting does not care about. That is the whole point.",
			"- Cover the posting: every requirement the base CV can support must be visible somewhere in the summary or bullets, in the posting's own vocabulary (an ATS and a recruiter both scan for it).",
			"- summary: 1-3 sentences positioning the candidate for this posting, built from base-CV facts.",
			"- experienceOrder: the entry titles worth showing, best match first. Use the exact titles from the CV.",
			"- entryDetails: for each entry you kept, 2-4 cut-down STAR bullets, most relevant to this posting first. Each bullet is one line: fold the Situation and Task into a short opening clause, lead the Action with a strong verb, close on the Result. Use the base CV's own numbers for results; if the CV shows no number, end on the real outcome without inventing one. Keys are exact entry titles.",
			"- coverLetterParagraphs: 3-5 short paragraphs. Name the company and role. Tie the candidate's real experience to the posting's actual requirements. No flattery, no invented facts, no 'I am excited' filler.",
			"- Reply with the JSON and nothing else.",
		].join("\n"),
		user: `# Base CV\n\n${profileMarkdown}\n\n# Job posting\n\n${jobText}${feedbackBlock}`,
	}
}

/**
 * Turn the model's reply into a plan the renderer can trust: JSON extracted from
 * whatever came back, entry titles matched against the real profile, strings
 * clamped, junk dropped. Any failure returns null and the caller falls back to
 * the un-tailored base CV — a generic CV still beats a broken build.
 */
export function parseTailoringPlan(
	raw: string | null | undefined,
	profile: CareerProfile,
): TailoringPlan | null {
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
	// The CV writes headings as "**Title — Organisation**", but the parsed entry
	// title is just "Title" — so a plan that quotes the full heading still has to
	// match. Exact match first, then containment in either direction.
	const findEntry = (title: string): ResumeEntry | undefined => {
		const wanted = title.toLowerCase().trim()
		if (!wanted) return undefined
		return (
			profile.experience.find(
				(entry) => entry.title.toLowerCase() === wanted,
			) ??
			profile.experience.find((entry) => {
				const known = entry.title.toLowerCase()
				return known.includes(wanted) || wanted.includes(known)
			})
		)
	}

	const summaryRaw = clampLine(source.summary, 900)
	// A summary that ran past its budget ships cut at a sentence end, never
	// mid-thought.
	const summary = summaryRaw ? finishSentence(summaryRaw) : null
	const experienceOrder = Array.isArray(source.experienceOrder)
		? source.experienceOrder
				.filter(
					(title): title is string =>
						typeof title === "string" && Boolean(findEntry(title)),
				)
				.slice(0, profile.experience.length)
		: []

	const entryDetails: Record<string, string[]> = {}
	if (typeof source.entryDetails === "object" && source.entryDetails !== null) {
		for (const [title, details] of Object.entries(
			source.entryDetails as Record<string, unknown>,
		)) {
			const entry = findEntry(title)
			if (!entry || !Array.isArray(details)) continue
			// STAR cut-down: tailoring trims, it cannot pad. Hard cap of three
			// bullets keeps the one-page budget; duplicates are dropped so a
			// model that rephrases the same achievement twice cannot spend the
			// page twice. Each bullet is clamped so one runaway line cannot
			// blow the layout.
			const kept: string[] = []
			const seen = new Set<string>()
			for (const detail of details) {
				if (kept.length >= Math.min(3, Math.max(entry.details.length, 1)))
					break
				if (typeof detail !== "string") continue
				const line = clampLine(detail, 260)
				if (!line) continue
				const key = line.toLowerCase()
				if (seen.has(key)) continue
				seen.add(key)
				kept.push(finishSentence(line))
			}
			if (kept.length) entryDetails[entry.title] = kept
		}
	}

	const coverLetterParagraphs = Array.isArray(source.coverLetterParagraphs)
		? source.coverLetterParagraphs
				.filter((p): p is string => typeof p === "string")
				.map((p) => clampLine(p, 900))
				.filter((p): p is string => Boolean(p))
				.slice(0, 6)
		: []

	const plan: TailoringPlan = {}
	if (summary) plan.summary = summary
	if (experienceOrder.length) plan.experienceOrder = experienceOrder
	if (Object.keys(entryDetails).length) plan.entryDetails = entryDetails
	if (coverLetterParagraphs.length) {
		plan.coverLetterParagraphs = coverLetterParagraphs
	}
	// A plan that tailors nothing is not a plan.
	return Object.keys(plan).length ? plan : null
}

/** The profile a plan describes: same facts, reordered, re-emphasised. */
export function applyTailoring(
	profile: CareerProfile,
	plan: TailoringPlan | null | undefined,
): CareerProfile {
	if (!plan) return profile
	const findEntry = (title: string): ResumeEntry | undefined => {
		const wanted = title.toLowerCase().trim()
		if (!wanted) return undefined
		return (
			profile.experience.find(
				(entry) => entry.title.toLowerCase() === wanted,
			) ??
			profile.experience.find((entry) => {
				const known = entry.title.toLowerCase()
				return known.includes(wanted) || wanted.includes(known)
			})
		)
	}
	// The plan's titles may quote the full heading; resolve to parsed entries
	// and drop duplicates so one entry cannot render twice.
	const ranked: ResumeEntry[] = []
	for (const title of plan.experienceOrder ?? []) {
		const entry = findEntry(title)
		if (entry && !ranked.includes(entry)) ranked.push(entry)
	}
	const ordered: ResumeEntry[] = ranked.length
		? [
				...ranked,
				// Entries the plan did not rank keep their original order at the end.
				...profile.experience.filter((entry) => !ranked.includes(entry)),
			]
		: profile.experience

	const experience = ordered.map((entry) => {
		const replacement = plan.entryDetails?.[entry.title]
		// The plan can only shrink an entry, never invent one: a bullet list that
		// came from the plan replaces the original, anything else passes through.
		if (!replacement?.length) return entry
		return { ...entry, details: replacement }
	})

	return {
		...profile,
		summary: plan.summary?.trim() || profile.summary,
		experience,
	}
}

function clampLine(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined
	const line = value.replace(/\s+/g, " ").trim()
	return line ? line.slice(0, max) : undefined
}

/**
 * End a clamped sentence cleanly. A model summary or bullet that ran past its
 * budget must not ship mid-thought ("...contribute to the development of") —
 * when the tail dangles on a function word, cut back to the last sentence end;
 * otherwise just close the line with a period.
 */
const DANGLING_TAIL =
	/\b(of|and|or|the|a|an|for|in|with|to|on|at|by|from|as|that|which|into|across|through|while|when|where|plus)$/i

function finishSentence(line: string): string {
	if (/[.!?…]$/.test(line)) return line
	if (DANGLING_TAIL.test(line)) {
		const cut = Math.max(
			line.lastIndexOf(". "),
			line.lastIndexOf("! "),
			line.lastIndexOf("? "),
		)
		if (cut > 0) return line.slice(0, cut + 1)
	}
	return `${line}.`
}

/** Just the slice of Workers AI the tailoring call needs. */
type TailoringAI = {
	run(
		model: string,
		input: {
			messages: Array<{ role: string; content: string }>
			max_tokens?: number
		},
	): Promise<unknown>
}

/**
 * How much of the posting's vocabulary the tailored CV actually carries.
 * Recruiters and ATS both scan for the posting's own words, so a tailored CV
 * that misses them reads as a weaker match than the facts justify. Coverage is
 * measured over the whole visible document: summary, every kept bullet, the
 * skill badges and project lines.
 */
export function tailorCoverage(
	profile: CareerProfile,
	plan: TailoringPlan | null,
	posting: { keywords: string[] },
): { covered: number; total: number; missing: string[] } {
	const tailored = plan ? applyTailoring(profile, plan) : profile
	const visible = [
		tailored.summary,
		...tailored.experience.flatMap((entry) => entry.details),
		...tailored.skills.flatMap((group) => group.items),
		...tailored.projects.map((project) => project.detail),
	]
		.join("\n")
		.toLowerCase()
	const missing = posting.keywords.filter(
		(keyword) => !visible.includes(keyword.toLowerCase()),
	)
	const total = posting.keywords.length
	return { covered: total - missing.length, total, missing }
}

/** Below this share of the posting's keywords, the plan gets one redo. */
const COVERAGE_REDO_THRESHOLD = 0.6

/**
 * The full tailoring round: ask, parse, measure how well the plan covers the
 * posting's own keywords, and — when the plan under-represents them — redo it
 * once with the misses named. A plan the model cannot fix in one redo is still
 * used as-is; a tailored CV with 80% coverage beats an un-tailored one.
 */
export async function requestTailoringPlanChecked(
	ai: TailoringAI | undefined,
	profileMarkdown: string,
	jobText: string,
	traceId: string,
): Promise<{ plan: TailoringPlan | null; coverage?: ReturnType<typeof tailorCoverage> }> {
	const profile = parseCareerProfile(profileMarkdown)
	const posting = parseJobPosting(jobText)
	const first = await requestTailoringPlan(ai, profileMarkdown, jobText, traceId)
	const plan = parseTailoringPlan(first, profile)
	if (!plan) {
		return { plan: null }
	}
	const coverage = tailorCoverage(profile, plan, posting)
	const share = coverage.total ? coverage.covered / coverage.total : 1
	if (share >= COVERAGE_REDO_THRESHOLD || !coverage.missing.length) {
		return { plan, coverage }
	}
	console.log(
		`[company-brain][${traceId}] career tailoring coverage ${coverage.covered}/${coverage.total} — redoing with the misses named`,
	)
	const redo = await requestTailoringPlan(
		ai,
		profileMarkdown,
		jobText,
		traceId,
		coverage.missing.slice(0, 8),
	)
	const redone = parseTailoringPlan(redo, profile)
	if (!redone) return { plan, coverage }
	const redoneCoverage = tailorCoverage(profile, redone, posting)
	if (redoneCoverage.covered > coverage.covered) {
		console.log(
			`[company-brain][${traceId}] career tailoring coverage improved to ${redoneCoverage.covered}/${redoneCoverage.total}`,
		)
		return { plan: redone, coverage: redoneCoverage }
	}
	// The redo did not help; keep the first plan.
	return { plan, coverage }
}

/** Quality matters more than latency here, and the 70b handles JSON reliably. */
const TAILOR_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

/**
 * One model call, one job: read the base CV and the posting, answer with the
 * plan JSON. Failure of any kind returns null — the documents then render from
 * the base CV, exactly as they did before this existed.
 */
export async function requestTailoringPlan(
	ai: TailoringAI | undefined,
	profileMarkdown: string,
	jobText: string,
	traceId: string,
	/** Requirements a previous plan missed, fed back for the redo. */
	feedback?: string[],
): Promise<string | null> {
	if (!ai) return null
	const prompt = buildTailorPrompt(profileMarkdown, jobText, feedback)
	try {
		const result = (await ai.run(TAILOR_MODEL, {
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			max_tokens: 2048,
		})) as unknown
		// Two response shapes exist in the wild: the Ai binding wraps plain-prompt
		// calls as {response}, but messages-input calls return the OpenAI-shaped
		// {choices:[{message:{content}}]} object. Read both.
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
				`[company-brain][${traceId}] career tailoring: unreadable reply from ${TAILOR_MODEL}`,
			)
		}
		return text || null
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] career tailoring call failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return null
	}
}

/**
 * The plan request races a clock: a slow tailoring call delays the documents.
 * The loser of the race still gets a catch attached — a rejection that lands
 * after the race settled must not escape as an unhandled rejection, which
 * resets the Durable Object and kills the whole turn.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	onTimeout: () => T,
): Promise<T> {
	const guarded = promise.catch(() => onTimeout())
	return Promise.race([
		guarded,
		new Promise<T>((resolve) => setTimeout(() => resolve(onTimeout()), ms)),
	])
}