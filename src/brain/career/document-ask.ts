/**
 * What counts as a CV ask.
 *
 * One vocabulary, three readers: the turn (attach the base CV, run the
 * document pipeline), search_company_brain (return the base CV instead of a
 * fuzzy match) and the Flow gate in ../turn/flow-routing.ts (never answer a CV
 * ask with a picture).
 *
 * Dependency-free on purpose: the Flow gate is a pure module, and a test for it
 * must not need a Worker, an env or a database.
 */

/**
 * A request that is really asking for a CV or cover letter. Shared by the turn
 * (whether to attach the base CV to the prompt) and by search_company_brain
 * (whether to return it as a result), so the two cannot drift apart.
 *
 * The trailing `(?![a-z])` is a word boundary that survives an accented
 * ending: JavaScript's `\b` is ASCII-only, so `\bresumé\b` never matched
 * anything — "é" counts as a non-word character, and the boundary after it
 * required a word character that was not there. A tailored CV request spelled
 * "résumé" therefore fell through the career pipeline entirely. The lookahead
 * says "no letter follows" in a way that works for both spellings, and still
 * keeps "resumed" from reading as "resume".
 */
export const CAREER_DOCUMENT_PATTERN = /\b(cvs?|r[eé]sum[eé]s?|cover letters?)(?![a-z])/i

/**
 * The message with its accents removed: "résumé" → "resume".
 *
 * Two encodings of the same word ("résumé" precomposed, or "e" + combining
 * acute) should not be two different answers. Used by every reader of the
 * vocabulary, so the Flow gate and the career pipeline agree on the spelling.
 */
export function withoutAccents(text: string): string {
	return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

/** Does this message ask for a CV or a cover letter? */
export function isCareerDocumentAsk(text: string): boolean {
	return CAREER_DOCUMENT_PATTERN.test(withoutAccents(text))
}
