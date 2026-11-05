/**
 * The cover letter: one page, addressed, and built only from profile facts.
 *
 * No model means no invented achievements — every sentence here is a
 * rearrangement of something the base CV already says, aimed at the posting's
 * own vocabulary.
 */
import type { JobPosting } from "./job-posting"
import type { CareerProfile } from "./profile"
import { escapeLatex } from "./render"

export function renderCoverLetterTex(
	profile: CareerProfile,
	posting: JobPosting,
	bodyParagraphs?: string[],
): string {
	const role = posting.title || "the advertised role"
	const company = posting.company || "your team"
	const availability = profile.contact.availability.join(", ")

	// A tailored letter replaces the whole body; the header, address block and
	// sign-off stay deterministic. Every paragraph is escaped like the rest.
	const paragraphs = (bodyParagraphs?.length
		? bodyParagraphs
		: defaultParagraphs(profile, posting)
	).map(escapeLatex)

	return [
		"\\documentclass[11pt,a4paper]{article}",
		"\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}\\usepackage{lmodern}",
		"\\usepackage[margin=2.5cm]{geometry}\\usepackage{hyperref}\\usepackage{xcolor}",
		"\\hypersetup{colorlinks=true,urlcolor=black}",
		"\\pagestyle{empty}",
		"\\definecolor{accent}{RGB}{27,58,92}\\definecolor{muted}{RGB}{88,96,108}\\definecolor{ink}{RGB}{30,34,40}",
		"\\color{ink}\\setlength{\\parindent}{0pt}",
		"\\setlength{\\parskip}{6pt}",
		"\\begin{document}",
		`{\\fontsize{15}{18}\\selectfont\\bfseries\\color{accent}${escapeLatex(profile.name)}}`,
		`{\\small\\color{muted} \\; $\\vert$ \\; ${escapeLatex(profile.contact.location)} \\; $\\vert$ \\; ${escapeLatex(profile.contact.email)} \\; $\\vert$ \\; ${escapeLatex(profile.contact.phone)}}`,
		"\\\\[-8pt]{\\color{accent}\\rule{\\linewidth}{2.2pt}}",
		"\\vspace{6pt}\n\\begin{flushright}",
		"\\today",
		"\\end{flushright}",
		"\\vspace{0.4cm}",
		"\\begin{flushleft}",
		"Hiring Team\\\\",
		`${escapeLatex(company)}\\\\`,
		escapeLatex(posting.location),
		"\\end{flushleft}",
		"\\vspace{0.3cm}",
		`Dear Hiring Team${posting.company ? ` at ${escapeLatex(company)}` : ""},`,
		...paragraphs,
		"Sincerely,\\\\[12pt]",
		escapeLatex(profile.name),
		"\\end{document}",
	]
		.filter((line) => line !== "")
		.join("\n")
}

/** The template body, used when no tailored paragraphs were provided. */
function defaultParagraphs(
	profile: CareerProfile,
	posting: JobPosting,
): string[] {
	const role = posting.title || "the advertised role"
	const company = posting.company || "your team"
	const matchedSkills = matchingSkills(profile, posting).slice(0, 4)
	const highlight = bestMatchingHighlight(profile, posting)
	const availability = profile.contact.availability.join(", ")
	return [
		`I am applying for the ${role} role${posting.company ? ` at ${company}` : ""}. ${profile.summary}`,
		highlight
			? `Most recently, ${highlight}`
			: "My background spans the responsibilities in the posting, from design through to production support.",
		matchedSkills.length
			? `The posting's focus maps onto work I have already done: ${matchedSkills.join(", ")}.`
			: "",
		availability ? `${capitalise(availability)}.` : "",
		"I would welcome the chance to discuss how this experience fits what you are building. My CV is attached, and I am available for an interview at your convenience.",
	].filter(Boolean)
}

/** Skills the posting names, in the posting's order. */
export function matchingSkills(
	profile: CareerProfile,
	posting: JobPosting,
): string[] {
	const owned = profile.skills.flatMap((group) => group.items)
	const matched: string[] = []
	for (const keyword of posting.keywords) {
		const hit = owned.find((item) => {
			const value = item.toLowerCase()
			return value === keyword || value.includes(keyword) || keyword.includes(value)
		})
		if (hit && !matched.includes(hit)) matched.push(hit)
	}
	return matched
}

/**
 * One achievement that speaks to the posting: the CV bullet sharing the most
 * vocabulary with it. Empty when nothing overlaps — better a generic sentence
 * than a claim that does not fit.
 */
export function bestMatchingHighlight(
	profile: CareerProfile,
	posting: JobPosting,
): string {
	const wanted = new Set(posting.keywords)
	let best = { score: 0, text: "" }
	for (const entry of profile.experience) {
		for (const detail of entry.details) {
			const words = detail.toLowerCase().match(/[a-z][a-z.+#-]{3,}/g) ?? []
			const score = words.filter((word) => wanted.has(word)).length
			if (score > best.score) best = { score, text: detail }
		}
	}
	if (!best.text) return ""
	// Recast into first person without inventing anything: the CV says what was
	// built; the letter says what I built.
	return lowerFirst(best.text).replace(/\.$/, "")
}

function capitalise(value: string): string {
	return value.length ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value
}

function lowerFirst(value: string): string {
	return value.length ? `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}` : value
}
