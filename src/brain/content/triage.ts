/**
 * System 1 triage: the cheap classifier in front of the expensive reasoning.
 *
 * JEV (TypeSafe) answers one bounded question with a label, a confidence and a
 * full probability distribution, in well under a second. That is exactly the
 * shape of every "which of these five is this?" decision in the content loop,
 * and it is the difference between spending a reasoning turn on "is this a
 * brief or a status question?" and spending it on the work itself.
 *
 * The rule this module enforces: **System 1 proposes, code decides.** Every
 * call has a deterministic fallback, a confidence floor, and a `via` field so a
 * logged decision says whether it came from the fast model or the regex. JEV is
 * never allowed to author facts, publish, or price anything.
 */
import type { SearchIntent } from "./growth"
import type { ArticleAudit } from "./quality"

export type SystemOneChoice = {
	choice: string
	confidence: number
	probabilities?: Record<string, number>
}

/** Injected so tests (and callers without a JEV key) never need the network. */
export type SystemOneAsker = (args: {
	state: string
	instructions: string
	criteria: Record<string, string>
}) => Promise<SystemOneChoice>

/** Below this, the fast answer is a hint, not a decision. */
export const TRIAGE_CONFIDENCE = 0.7

export type TriageResult<T extends string> = {
	value: T
	confidence: number
	via: "system1" | "fallback"
}

async function askChoice<T extends string>(
	ask: SystemOneAsker | undefined,
	state: string,
	instructions: string,
	criteria: Record<T, string>,
	fallback: () => T,
	threshold = TRIAGE_CONFIDENCE,
): Promise<TriageResult<T>> {
	const fallbackResult = (): TriageResult<T> => ({ value: fallback(), confidence: 0, via: "fallback" })
	if (!ask) return fallbackResult()
	try {
		const answer = await ask({ state, instructions, criteria })
		const choice = String(answer?.choice ?? "")
		const confidence = Number(answer?.confidence)
		if (!(choice in criteria) || !Number.isFinite(confidence)) return fallbackResult()
		if (confidence < threshold) return fallbackResult()
		return { value: choice as T, confidence, via: "system1" }
	} catch {
		return fallbackResult()
	}
}

/**
 * What did the operator actually ask for?
 *
 * The regex path exists because JEV may be unconfigured, rate-limited, or
 * unsure — and a mis-routed "status" question that costs a research turn is
 * worse than a keyword match that costs nothing.
 */
export type IntakeIntent = "brief" | "refresh" | "status" | "social" | "kill"

const INTAKE_CRITERIA: Record<IntakeIntent, string> = {
	brief: "Asks for a new piece of content, article, guide or deep dive on a topic",
	refresh: "Asks to update, rewrite, expand, re-publish or re-optimise something that already exists",
	status: "Asks where something stands: what is live, what was published, metrics, rankings, progress",
	social: "Asks for posts, threads, captions, a campaign pack or repurposing for social channels",
	kill: "Asks to unpublish, delete, merge, redirect or stop work on a page",
}

const INTAKE_PATTERNS: Array<{ intent: IntakeIntent; re: RegExp }> = [
	{ intent: "kill", re: /\b(unpublish|delete|remove|merge|redirect|kill|retire|take down)\b/i },
	{ intent: "status", re: /\b(status|live|how is|how'?s|report|metrics|rankings?|impressions|progress)\b/i },
	{ intent: "social", re: /\b(social|linkedin|twitter|x post|thread|caption|campaign pack|repurpose)\b/i },
	{ intent: "refresh", re: /\b(refresh|update|rewrite|expand|refresh|re-?publish|optimis|optimiz|stale)\b/i },
	{ intent: "brief", re: /\b(write|draft|brief|article|guide|deep ?dive|blog|topic)\b/i },
]

export function fallbackIntake(text: string): IntakeIntent {
	for (const { intent, re } of INTAKE_PATTERNS) if (re.test(text)) return intent
	return "brief"
}

export function classifyIntake(text: string, ask?: SystemOneAsker): Promise<TriageResult<IntakeIntent>> {
	return askChoice(
		ask,
		text.slice(0, 2_000),
		"Classify what the operator is asking for. Choose the single best-matching intent.",
		INTAKE_CRITERIA,
		() => fallbackIntake(text),
	)
}

/**
 * Search intent for a keyword row.
 *
 * treg returns volume and competition, not intent, so the decision model's
 * `intent_weight` was a hand-set constant per cluster. This labels the row
 * itself, which is the difference between "kra nil return" (informational) and
 * "etims integrator nairobi" (transactional) scoring the same because they sat
 * in the same cluster.
 */
const INTENT_CRITERIA: Record<SearchIntent, string> = {
	transactional: "Wants to buy, hire, book or get a quote now",
	commercial: "Comparing options or vendors before deciding",
	informational: "Wants to understand a rule, process or definition",
	navigational: "Looking for a specific site, portal or login",
}

const INTENT_PATTERNS: Array<{ intent: SearchIntent; re: RegExp }> = [
	{ intent: "navigational", re: /\b(login|log in|portal|itax|contact|website|download)\b/i },
	{ intent: "transactional", re: /\b(hire|buy|price|pricing|cost|quote|near me|agency|consultant|services?|company in)\b/i },
	{ intent: "commercial", re: /\b(best|vs|versus|compare|alternative|review|top \d+)\b/i },
	{ intent: "informational", re: /\b(how|what|why|when|guide|deadline|penalty|meaning|requirements?|rules?)\b/i },
]

export function fallbackKeywordIntent(phrase: string): SearchIntent {
	for (const { intent, re } of INTENT_PATTERNS) if (re.test(phrase)) return intent
	return "informational"
}

export function labelKeywordIntent(phrase: string, ask?: SystemOneAsker): Promise<TriageResult<SearchIntent>> {
	return askChoice(
		ask,
		phrase,
		"Label the search intent behind this keyword phrase, as a buyer would type it.",
		INTENT_CRITERIA,
		() => fallbackKeywordIntent(phrase),
	)
}

/**
 * Should this draft go to a strong model before publishing, and why?
 *
 * The audit already knows the answer structurally (an unsupported figure is a
 * claim problem, two H1s is a structure problem). JEV is used to confirm the
 * classification when the deterministic read is ambiguous, not to override it:
 * a failing figure gate is a fact, not an opinion.
 */
export type DraftRisk = "none" | "claim" | "structure" | "voice"

const RISK_CRITERIA: Record<DraftRisk, string> = {
	none: "The draft passes the checks; no rewrite needed",
	claim: "A factual or numeric claim lacks evidence or citation",
	structure: "Headings, length or required sections are wrong",
	voice: "Tone or phrasing breaks the house voice",
}

export function fallbackDraftRisk(audit: ArticleAudit): DraftRisk {
	const codes = new Set(audit.findings.map((f) => f.code))
	if (codes.has("unsupported_figures")) return "claim"
	if (codes.has("h1") || codes.has("words") || codes.has("slug") || codes.has("title") || codes.has("meta")) return "structure"
	if (codes.has("meta_band") || codes.has("faq") || codes.has("internal_links") || codes.has("words_long")) return "voice"
	return "none"
}

export async function triageDraftRisk(audit: ArticleAudit, ask?: SystemOneAsker): Promise<TriageResult<DraftRisk>> {
	const deterministic = fallbackDraftRisk(audit)
	// Only ask when the gates are clean: any gate failure is already a decision.
	if (deterministic !== "none") return { value: deterministic, confidence: 1, via: "fallback" }
	return askChoice(
		ask,
		`${audit.slug}\n\nfindings: ${audit.findings.map((f) => f.code).join(", ") || "none"}\nwords: ${audit.words}`,
		"Given the audit findings, what kind of rewrite (if any) does this draft need?",
		RISK_CRITERIA,
		() => "none",
		TRIAGE_CONFIDENCE,
	)
}

/**
 * Adapter to the real System 1 endpoint.
 *
 * Kept separate from the classifiers so the classifiers stay synchronous-testable
 * and no test ever needs a key. `querySystemOne` already enforces a timeout and
 * returns probabilities; a caller that passes this in gets JEV, a caller that
 * does not gets the fallback path for free.
 */
export function systemOneAsker(apiKey: string, options: { model?: string; timeoutMs?: number } = {}): SystemOneAsker {
	return async ({ state, instructions, criteria }) => {
		const { querySystemOne } = await import("../typesafe/client")
		const res = await querySystemOne({
			apiKey,
			state,
			questions: { answer: { type: "choice" as const, instructions, criteria } },
			model: options.model,
			timeoutMs: options.timeoutMs ?? 4_000,
		})
		const answer = res.answers.answer
		return {
			choice: answer.type === "choice" ? answer.choice : "",
			confidence: answer.confidence,
			probabilities: answer.probabilities,
		}
	}
}

