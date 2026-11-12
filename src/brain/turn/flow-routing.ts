import { CAREER_DOCUMENT_PATTERN } from "../career/document-ask"

/**
 * When a message becomes a Flow job, and — the point of this file — when it
 * must not.
 *
 * Flow is the workspace's picture maker: stills and clips, rendered on the
 * operator's own Google account through flow-mcp on the VPS. Every picture ask
 * belongs there. The failure mode is the mirror image: a *document* ask being
 * answered with a picture. "Make me a CV and a cover letter" was queued as a
 * still, because **cover** is a picture noun in "cover image" and the turn
 * returned the moment the job was queued — so the PDFs were never built and
 * the asker got art instead of a CV.
 *
 * A queued job ends the turn (see compute.ts: the job *is* the answer), which
 * makes this decision load-bearing: it is the one place that can stop a
 * document request from being spent on an image. Three rules keep it honest:
 *
 * 1. A message that names a document the brain builds is never a picture ask.
 *    The document pipeline wins every overlap; it costs nothing to let the
 *    model answer with text, and a wrong picture costs a silent turn.
 * 2. The CV vocabulary is imported from ../career/document-ask, the same
 *    pattern the career pipeline and search_company_brain use — so a phrase
 *    added there cannot start leaking into Flow here.
 * 3. "cover" only counts as a picture noun when it is not the word in "cover
 *    letter" / "covering letter" / "cover note" — those phrases are stripped
 *    before the nouns are read, so the letter is invisible to this test.
 *
 * Pure on purpose: the routing is the risky part, so it is a function with
 * tests rather than a regex buried mid-turn.
 */

/**
 * The rest of the document vocabulary: the letter/application family and the
 * generic documents the brain compiles.
 *
 * The CV family itself is not repeated here — it is `CAREER_DOCUMENT_PATTERN`,
 * imported from ../career/document-ask and checked along with this pattern.
 * Two lists of CV words drifting apart is what let "cover letter" through to
 * Flow in the first place, so there is deliberately only one.
 *
 * Tested against the accent-free copy of the message, so "résumé", "resumé"
 * and "resume" are one word.
 */
export const DOCUMENT_ASK_PATTERN =
	/\b(curriculum vitae|cover letters?|covering letters?|cover[- ]notes?|application letters?|job applications?|pdf|report|documents?|brief|proposal)\b/i

/**
 * The message with its accents removed: "résumé" → "resume".
 *
 * Slack users type both spellings, and a pattern that only knows one of them
 * silently lets the other through — which is how a document ask becomes art.
 */
function withoutAccents(text: string): string {
	return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

/**
 * Phrases where "cover" is stationery, not artwork. Removed before the picture
 * nouns are read; `g` so every mention in a message goes.
 */
const COVER_LETTER_PHRASE = /\b(cover|covering)\s+letters?\b|\bcover[- ]notes?\b/gi

/** The verbs that ask for something to be made. */
export const CREATIVE_VERB_PATTERN =
	/\b(make|create|generate|render|draw|produce|paint|shoot|show|give|design|redo|remake)\b/i

/** The nouns that name a picture (or a moving one). */
export const PICTURE_NOUN_PATTERN =
	/\b(still|image|images|picture|photo|photograph|illustration|render|art|artwork|visual|graphic|portrait|poster|shot|frame|clip|video|animation|cover)\b/i

/** A request another picture route already owns, so Flow must keep off it. */
const OTHER_PICTURE_ROUTE_PATTERN =
	/\b(doodle|anidoodle|image prompts?|flow kit)\b|\bcampaign pack\b/i

const CLIP_NOUN_PATTERN = /\b(clip|video|animation)\b/i

/** Why Flow was not asked to render. */
export type FlowSuppression =
	| "document-ask"
	| "another-picture-route"
	| "no-creative-verb"
	| "no-picture-noun"

/**
 * Why a message did or did not become a Flow job.
 *
 * `blockedPicture` is true when the message would have queued a picture but for
 * `reason` — the gate actively stopped it. The turn logs that, so a suppressed
 * render is visible instead of silent.
 */
export type FlowRouting =
	| { queue: true; clip: boolean; reason: "picture-request" }
	| { queue: false; reason: FlowSuppression; blockedPicture: boolean }

/**
 * Decide whether Flow should render this message.
 *
 * Order matters: the routes that own a request outright are checked before the
 * picture nouns, and a document ask is checked before the verbs — a message
 * that says "make" and "cover" must be read as a letter, not as art direction.
 */
export function decideFlowRouting(question: string): FlowRouting {
	const text = question ?? ""
	// Accents are noise in a document word: "résumé" is "resume".
	const normalized = withoutAccents(text)
	// "cover letter" is a document phrase; the word "cover" in it is not a
	// request for a cover image.
	const pictureText = text.replace(COVER_LETTER_PHRASE, " ")
	// What the old inline gate would have queued: a creative verb plus a
	// picture noun, "cover" included. Kept on the raw text so the log line can
	// say a render was *stopped*, not that nothing was asked for.
	const looksLikePicture =
		CREATIVE_VERB_PATTERN.test(text) && PICTURE_NOUN_PATTERN.test(text)

	if (OTHER_PICTURE_ROUTE_PATTERN.test(text)) {
		return {
			queue: false,
			reason: "another-picture-route",
			blockedPicture: looksLikePicture,
		}
	}
	if (DOCUMENT_ASK_PATTERN.test(normalized) || CAREER_DOCUMENT_PATTERN.test(normalized)) {
		return {
			queue: false,
			reason: "document-ask",
			blockedPicture: looksLikePicture,
		}
	}
	if (!CREATIVE_VERB_PATTERN.test(pictureText)) {
		return { queue: false, reason: "no-creative-verb", blockedPicture: false }
	}
	if (!PICTURE_NOUN_PATTERN.test(pictureText)) {
		return { queue: false, reason: "no-picture-noun", blockedPicture: false }
	}
	return {
		queue: true,
		clip: CLIP_NOUN_PATTERN.test(text),
		reason: "picture-request",
	}
}
