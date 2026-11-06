/**
 * Publish gates: the invariants an article must satisfy regardless of which
 * model wrote it, at what temperature, on which day.
 *
 * LLM output is not reproducible; the properties of a good article are. This
 * module encodes those properties once, so the orchestrator, the eval harness
 * and the publish path all assert the same things instead of drifting apart the
 * way three hand-rolled checklists eventually do.
 *
 * The figure gate is the one that matters commercially: for KRA, eTIMS, ODPC
 * and CNVA content a hallucinated penalty amount is a liability, not a typo.
 * Every money/percentage figure must either appear in the evidence the draft was
 * written from, or carry a footnote/link marker at the point of use.
 */

export type FaqItem = { q: string; a: string }

export type ArticleAuditInput = {
	slug: string
	title: string
	metaDescription: string
	markdown: string
	faq?: FaqItem[]
	/** Figures the evidence pack actually supports, in any format. */
	approvedFigures?: string[]
	minWords?: number
	maxWords?: number
	minInternalLinks?: number
	minFaq?: number
}

export type Severity = "error" | "warning"

export type AuditFinding = { code: string; severity: Severity; detail: string }

export type ArticleAudit = {
	slug: string
	hash: string
	ok: boolean
	words: number
	h1Count: number
	internalLinks: number
	faqCount: number
	titleLength: number
	metaLength: number
	figures: string[]
	unsupportedFigures: string[]
	findings: AuditFinding[]
}

/**
 * FNV-1a, 32-bit, hex. Not a security hash — a cheap fingerprint so a re-draft
 * of the same brief can be diffed, and a publish can prove which version of the
 * text is live.
 */
export function contentHash(text: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, "0")
}

/** Every figure a reader could act on, in the form it appears in the text. */
const FIGURE_RE =
	/(?:KES|KSh|Ksh|USD|EUR|GBP)\s?\d[\d,]*(?:\.\d+)?|\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:%|per cent)|\b\d{1,3}(?:,\d{3})+\b/g

export function figuresIn(text: string): string[] {
	return text.match(FIGURE_RE) ?? []
}

function countH1(markdown: string): number {
	return markdown.split("\n").filter((line) => /^#\s+\S/.test(line.trim())).length
}

function countInternalLinks(markdown: string): number {
	return (markdown.match(/\]\(\/[^)\s]*\)/g) ?? []).length
}

/**
 * Audit one article against the publish contract.
 *
 * Errors block publishing; warnings are shown to the operator and recorded, so a
 * slow quality drift becomes visible before it is a ranking problem.
 */
export function auditArticle(input: ArticleAuditInput): ArticleAudit {
	const minWords = input.minWords ?? 300
	const maxWords = input.maxWords ?? 2_500
	const minLinks = input.minInternalLinks ?? 3
	const minFaq = input.minFaq ?? 3
	const findings: AuditFinding[] = []

	const words = input.markdown.split(/\s+/).filter(Boolean).length
	const h1Count = countH1(input.markdown)
	const internalLinks = countInternalLinks(input.markdown)
	const faqCount = input.faq?.length ?? 0
	const titleLength = input.title.trim().length
	const metaLength = input.metaDescription.trim().length
	const figures = figuresIn(input.markdown)
	const unsupported = unsupportedFigures(input.markdown, input.approvedFigures)

	if (!input.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
		findings.push({ code: "slug", severity: "error", detail: `"${input.slug}" is not a valid slug` })
	}
	if (titleLength < 10 || titleLength > 140) {
		findings.push({ code: "title", severity: "error", detail: `title is ${titleLength} chars (10–140)` })
	}
	if (metaLength < 60 || metaLength > 180) {
		findings.push({ code: "meta", severity: "error", detail: `meta description is ${metaLength} chars (60–180)` })
	} else if (metaLength < 120 || metaLength > 160) {
		findings.push({ code: "meta_band", severity: "warning", detail: `meta is ${metaLength} chars (120–160 is the sweet spot)` })
	}
	if (words < minWords) {
		findings.push({ code: "words", severity: "error", detail: `${words} words, minimum ${minWords}` })
	} else if (words > maxWords) {
		findings.push({ code: "words_long", severity: "warning", detail: `${words} words, above ${maxWords}` })
	}
	if (h1Count !== 1) {
		findings.push({ code: "h1", severity: "error", detail: `${h1Count} H1 headings, exactly 1 required` })
	}
	if (internalLinks < minLinks) {
		findings.push({ code: "internal_links", severity: "warning", detail: `${internalLinks} internal links, ${minLinks}+ expected` })
	}
	if (faqCount < minFaq) {
		findings.push({ code: "faq", severity: "warning", detail: `${faqCount} FAQ entries, ${minFaq}+ expected` })
	}
	if (unsupported.length > 0) {
		findings.push({
			code: "unsupported_figures",
			severity: "error",
			detail: `no evidence or citation for: ${unsupported.slice(0, 6).join(", ")}`,
		})
	}

	return {
		slug: input.slug,
		hash: contentHash(`${input.title}\n${input.metaDescription}\n${input.markdown}`),
		ok: findings.every((f) => f.severity !== "error"),
		words,
		h1Count,
		internalLinks,
		faqCount,
		titleLength,
		metaLength,
		figures,
		unsupportedFigures: unsupported,
		findings,
	}
}

/** One line for a Slack message or a log, errors first. */
export function summariseAudit(audit: ArticleAudit): string {
	const errors = audit.findings.filter((f) => f.severity === "error")
	const warnings = audit.findings.filter((f) => f.severity === "warning")
	const parts = [`${audit.ok ? "PASS" : "FAIL"} ${audit.slug} (${audit.words}w, ${audit.h1Count} H1, ${audit.internalLinks} links)`]
	if (errors.length) parts.push(`errors: ${errors.map((e) => e.code).join(",")}`)
	if (warnings.length) parts.push(`warnings: ${warnings.map((w) => w.code).join(",")}`)
	return parts.join(" | ")
}


function figureKey(raw: string): string {
	return raw.replace(/[^\d.]/g, "").replace(/\.$/, "")
}

function approvedKeys(approved: string[]): Set<string> {
	const keys = new Set<string>()
	for (const raw of approved) {
		const key = figureKey(raw)
		if (!key) continue
		keys.add(key)
		// "KES 1,000" and "1000" must match, and so must "1,000.00" and "1000".
		const integer = key.split(".")[0]
		if (integer && integer !== key) keys.add(integer)
	}
	return keys
}

/**
 * Figures with neither an evidence match nor a citation at the point of use.
 *
 * The citation allowance is deliberate: a well-sourced article may quote a
 * number the evidence pack does not hold, as long as it links to where it came
 * from. What is not allowed is an unowned number that reads like fact.
 */
export function unsupportedFigures(text: string, approved: string[] = []): string[] {
	const keys = approvedKeys(approved)
	const unsupported: string[] = []
	for (const match of text.matchAll(FIGURE_RE)) {
		const raw = match[0]
		const at = match.index ?? 0
		const key = figureKey(raw)
		if (!key) continue
		const integer = key.split(".")[0]
		if (keys.has(key) || (integer && keys.has(integer))) continue
		const after = text.slice(at + raw.length, at + raw.length + 60)
		if (after.includes("[^") || /\]\(https?:/.test(after)) continue
		if (!unsupported.includes(raw)) unsupported.push(raw)
	}
	return unsupported
}
