/**
 * A job posting as facts.
 *
 * Deliberately conservative: every field falls back to something true (or
 * empty) rather than guessing, because these strings get printed on a document
 * someone sends to an employer.
 */
export type JobPosting = {
	title: string
	company: string
	location: string
	/** Lowercased keywords worth mirroring, in posting order, deduped. */
	keywords: string[]
}

const ROLE_WORDS =
	"Engineer|Developer|Designer|Manager|Analyst|Scientist|Architect|Instructor"

export function parseJobPosting(text: string): JobPosting {
	const source = text.replace(/\r\n/g, "\n").trim()
	const flat = source.replace(/\s+/g, " ")

	const title =
		source.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
		flat.match(
			new RegExp(
				`\\b(?:an?|the)\\s+((?:(?:Senior|Staff|Lead|Principal|Junior)\\s+)?[A-Z][\\w/-]*(?:\\s+[A-Z][\\w/-]*){0,3}\\s+(?:${ROLE_WORDS}))`,
			),
		)?.[1]?.trim() ||
		flat.match(
			new RegExp(
				`\\b((?:(?:Senior|Staff|Lead|Principal|Junior)\\s+)?(?:Software|Backend|Frontend|Full[- ]Stack|Platform|Mobile)\\s+(?:${ROLE_WORDS}))`,
				"i",
			),
		)?.[1]?.trim() ||
		""

	// "Living Goods is seeking an experienced Senior Software Engineer" — the
	// company is the subject of the sentence, not the object of the role. The
	// "Frontend Engineer, Twiga Foods (Remote)" header form is covered too.
	const company =
		flat.match(/^([A-Z][\w&.,' -]{2,40})\s+is\s+(?:seeking|looking for|hiring)/)?.[1]?.trim() ||
		flat.match(/\bat\s+([A-Z][\w&.,' -]{2,40})(?:[,.]|\s+we\b)/)?.[1]?.trim() ||
		source.match(/^#?\s*[\w\s/&-]+?,\s*([A-Z][\w&.' -]{2,40})\s*\(/)?.[1]?.trim() ||
		""

	const location =
		flat.match(/\b(Remote(?:[- ]first)?|Hybrid|On-?site)\b(?:\s+(?:in|from)\s+([A-Z][\w' -]+))?/)?.[0]?.trim() ||
		flat.match(
			/\b(Nairobi|Lagos|Accra|Kampala|Dar es Salaam|Cape Town|London|Berlin|Amsterdam|Dubai)\b/,
		)?.[1]?.trim() ||
		""

	return { title, company, location, keywords: keywordsFrom(source) }
}

const KEYWORD_PATTERN =
	/\b(typescript|javascript|react|vue|node(?:\.js)?|ruby(?: on rails)?|golang|go|kotlin|swift|python|java|dart|flutter|rust|graphql|rest|grpc|postgres(?:ql)?|mysql|mongodb|sqlite|redis|docker|kubernetes|containerd|terraform|aws|gcp|azure|cloudflare|workers|ci\/cd|microservices|distributed systems|offline-first|android|ios|ai|llm|genai|machine learning|code review|mentoring|architecture|fhir|spring boot|etcd)\b/gi

export function keywordsFrom(text: string): string[] {
	const seen = new Set<string>()
	const keywords: string[] = []
	for (const match of text.match(KEYWORD_PATTERN) ?? []) {
		const key = match.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		keywords.push(key)
	}
	return keywords
}
