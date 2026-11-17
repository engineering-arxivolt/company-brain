/**
 * Sentence-sized helpers shared by the two places a model's prose reaches a
 * document: per-job tailoring (../career/tailor.ts) and user edits
 * (../career/edit.ts). Both clamp a runaway line and close a cut sentence, and
 * both must do it the same way — a bullet that ships mid-thought is the bug, not
 * a detail of which pipeline produced it.
 */

/** One line, collapsed whitespace, capped. Undefined when there is nothing left. */
export function clampLine(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined
	const line = value.replace(/\s+/g, " ").trim()
	return line ? line.slice(0, max) : undefined
}

/**
 * A whole sentence or bullet: clamped to the budget *and* closed cleanly.
 *
 * `clampLine` alone cuts mid-word, which is how a model bullet can ship as
 * "...contribute to the development of". Only use this for text that is the
 * whole thought; a fragment being spliced into a sentence keeps `clampLine`.
 */
export function clampProse(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined
	const whole = value.replace(/\s+/g, " ").trim()
	if (!whole) return undefined
	if (whole.length <= max) return finishSentence(whole)
	const cut = whole.slice(0, max)
	const atWord = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim()
	return finishSentence(atWord || cut)
}

/**
 * End a clamped sentence cleanly. A model summary or bullet that ran past its
 * budget must not ship mid-thought ("...contribute to the development of") —
 * when the tail dangles on a function word, cut back to the last sentence end;
 * if the text has no sentence boundary at all, drop the dangling words so the
 * line still ends on something worth reading.
 */
const DANGLING_TAIL =
	/\b(of|and|or|the|a|an|for|in|with|to|on|at|by|from|as|that|which|into|across|through|while|when|where|plus)$/i

export function finishSentence(line: string): string {
	if (/[.!?…]$/.test(line)) return line
	if (DANGLING_TAIL.test(line)) {
		const cut = Math.max(
			line.lastIndexOf(". "),
			line.lastIndexOf("! "),
			line.lastIndexOf("? "),
		)
		if (cut > 0) return line.slice(0, cut + 1)
		// No boundary to retreat to: trim trailing function words, keeping
		// enough of the line that the bullet still says something.
		const words = line.split(" ")
		while (words.length > 3 && DANGLING_TAIL.test(words[words.length - 1] ?? "")) {
			words.pop()
		}
		return `${words.join(" ").replace(/[,;:]$/, "")}.`
	}
	return `${line}.`
}
