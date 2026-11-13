import { isCareerDocumentAsk, withoutAccents } from "../career/document-ask"
import { decideFlowRouting, type FlowRouting } from "./flow-routing"

/**
 * The deterministic routes a Slack message can take before the model runs.
 *
 * These decisions used to live inline in `compute.ts` — a 2,400-line turn
 * function where each route was its own regex and its own early `return`. That
 * shape produced a run of near-identical bugs (see the Flow gate in
 * flow-routing.ts, and the three commits that fixed it): a phrase nobody had
 * typed into the regex fell through, and because the route that *did* fire ends
 * the turn, the wrong answer replaced the right one.
 *
 * One table now holds the vocabulary. The turn asks `matchesTurnRoute`, the
 * golden-turn evals in `evals/` assert `classifyTurn`, and both read the same
 * patterns — so a route can no longer mean two things depending on where it is
 * checked.
 *
 * This is deliberately only the *routing* layer. Precedence is the array order
 * of TURN_ROUTES, and it mirrors the order the pipelines run in compute.ts.
 */

export const TURN_ROUTES = [
	"career",
	"campaign",
	"flow",
	"doodle",
	"image-prompts",
	"research-report",
] as const

export type TurnRoute = (typeof TURN_ROUTES)[number]

const CAMPAIGN_PATTERN = /\bcampaign pack\b/i
const DOODLE_PATTERN = /\b(doodle|anidoodle)\b/i
const IMAGE_PROMPTS_PATTERN = /\bimage prompts?\b/i

/** A document the asker wants written, rather than one they already have. */
const DOCUMENT_NOUN =
	/\b(pdf|document|report|brief|proposal|summary|overview|write[- ]?up|whitepaper|one[- ]?pager|dossier)\b/i
const CREATE_VERB =
	/\b(make|create|produce|generate|draft|write|compile|build|prepare|put together)\b/i
/** Refers to something that already exists, so it is not a fresh document job. */
const EXISTING_ARTIFACT =
	/\b(?:that|this|the)\s+(?:file|pdf|doc|document|deck|invoice|attachment)\b|\b(?:uploaded|attached|sent|received)\b/i
/**
 * Art direction for a document is the model's job, not the report pipeline's —
 * pinned by the `report-with-cover-image` eval, which stays route-free.
 */
const ART_DIRECTION =
	/\b(?:cover image|cover art|artwork|illustration|illustrations|poster|banner|graphic|graphics|visual|visuals)\b/i

/**
 * Research report, including the second clause: an itinerary, schedule or
 * proposal asked for as a PDF is a document job too. "Produce a 3-day
 * itinerary PDF" used to slip past this gate and be answered by the model raw.
 *
 * The third clause is the same lesson one level up: any ask to *create a
 * document* is a document job. "Make a PDF of the whole company" matched no
 * route, so `primary` was null, a free-tier hop freestyled the whole thing
 * (trace LJiY175QSZF7irA5LfKCac: five tool calls, four steps, not one word of
 * text) and the asker got the canned empty-reply apology — while the report
 * pipeline that renders and delivers a PDF never ran.
 */
function matchesResearchReport(text: string): boolean {
	return (
		(/\bresearch\b/i.test(text) && /\b(report|pdf|paper|brief)\b/i.test(text)) ||
		/\bdeep[- ]dive\b/i.test(text) ||
		/\bpdf report\b/i.test(text) ||
		(/\bpdf\b/i.test(text) &&
			/\b(itinerary|schedule|proposal|plan|brief)\b/i.test(text) &&
			/\b(make|create|produce|generate|draft|write|research)\b/i.test(text)) ||
		(CREATE_VERB.test(text) &&
			DOCUMENT_NOUN.test(text) &&
			!EXISTING_ARTIFACT.test(text) &&
			!ART_DIRECTION.test(text))
	)
}

/** Does this message belong to `route`? Pure, and the only definition of it. */
export function matchesTurnRoute(route: TurnRoute, text: string): boolean {
	switch (route) {
		case "career":
			return isCareerDocumentAsk(text)
		case "campaign":
			return CAMPAIGN_PATTERN.test(text)
		case "flow":
			return decideFlowRouting(text).queue
		case "doodle":
			return DOODLE_PATTERN.test(text)
		case "image-prompts":
			return IMAGE_PROMPTS_PATTERN.test(text)
		case "research-report":
			return matchesResearchReport(withoutAccents(text))
	}
}

export type TurnClassification = {
	/** The route that runs first, in compute.ts order; null = model handles it. */
	primary: TurnRoute | null
	/**
	 * Every route that claims the message. More than one is legitimate for a
	 * couple of pairs (a report that also asks for art direction), and a bug for
	 * most — which is exactly why the evals assert the whole set, not just the
	 * winner.
	 */
	matched: TurnRoute[]
	/** The picture decision in full, since "blocked" and "not asked" differ. */
	flow: FlowRouting
}

/** Classify a message against every route. The eval suite's entry point. */
export function classifyTurn(text: string): TurnClassification {
	const matched = TURN_ROUTES.filter((route) => matchesTurnRoute(route, text))
	return {
		primary: matched[0] ?? null,
		matched,
		flow: decideFlowRouting(text),
	}
}
