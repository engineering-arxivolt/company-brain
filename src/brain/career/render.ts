import type { JobPosting } from "./job-posting"
import type { CareerProfile, ResumeEntry } from "./profile"

/**
 * LaTeX rendering for the career documents.
 *
 * Everything the model used to get wrong lives here, deterministically: escaping,
 * section structure, page-size margins, which facts go first. The output is a
 * complete `.tex` file that compiles in the sandbox image (core LaTeX only —
 * no titlesec/enumitem/lastpage, which are not installed there).
 */

const LATEX_ESCAPES: Record<string, string> = {
	"\\": "\\textbackslash{}",
	"&": "\\&",
	"%": "\\%",
	$: "\\$",
	"#": "\\#",
	_: "\\_",
	"{": "\\{",
	"}": "\\}",
	"~": "\\textasciitilde{}",
	"^": "\\textasciicircum{}",
}

/** Escape prose for LaTeX. Order matters: the backslash escape must come first. */
export function escapeLatex(value: string): string {
	return value
		.replace(/\\/g, "\\textbackslash{}")
		.replace(/[&%$#_{}~^]/g, (char) => LATEX_ESCAPES[char] ?? char)
}

/** Escape a URL for \href: LaTeX keeps % and # out of a bare argument. */
export function escapeUrl(value: string): string {
	return value.replace(/\\/g, "").replace(/[%#{}]/g, (char) =>
		char === "%" ? "\\%" : char === "#" ? "\\#" : char,
	)
}

function dateRange(period: string): string {
	return escapeLatex(period.replace(/–/g, "--"))
}

function entryLines(entry: ResumeEntry): string[] {
	const heading = [
		`\\textbf{${escapeLatex(entry.title)}}`,
		entry.organisation ? `\\textit{${escapeLatex(entry.organisation)}}` : "",
	]
		.filter(Boolean)
		.join(" --- ")
	return [
		`\\entry{${heading}}{${dateRange(entry.period)}}`,
		"\\begin{cvitems}",
		...entry.details.map((detail) => `  \\item ${escapeLatex(detail)}`),
		"\\end{cvitems}",
	]
}

/**
 * Skills in the posting's order first, then the rest: the only "tailoring" that
 * is safe to do without inventing anything.
 */
export function orderSkillsForPosting(
	profile: CareerProfile,
	posting: JobPosting,
): Array<{ group: string; items: string[] }> {
	const wanted = new Set(posting.keywords.map((keyword) => keyword.toLowerCase()))
	const score = (item: string) => {
		const value = item.toLowerCase()
		for (const keyword of wanted) {
			if (value.includes(keyword) || keyword.includes(value)) return 2
		}
		return 0
	}
	return profile.skills.map((group) => ({
		group: group.group,
		items: [...group.items].sort((a, b) => score(b) - score(a)),
	}))
}

export function renderResumeTex(
	profile: CareerProfile,
	posting: JobPosting,
): string {
	const contactBits = [
		escapeLatex(profile.contact.location),
		profile.contact.email
			? `\\href{mailto:${escapeUrl(profile.contact.email)}}{${escapeLatex(profile.contact.email)}}`
			: "",
		escapeLatex(profile.contact.phone),
	]
		.filter(Boolean)
		// Coloured separators read as design, not punctuation.
		.map((bit) => `{\\color{muted}${bit}}`)
		.join(` {\\color{accent}\\textbullet} `)

	const linkBits = profile.contact.links
		.map(
			(link) =>
				`\\href{${escapeUrl(link.url)}}{{\\color{muted}${escapeLatex(link.label)}}}`,
		)
		.join(` {\\color{accent}\\textbullet} `)

	const availability = profile.contact.availability
		// Escape each item, then join with the raw LaTeX bullet: escaping the
		// joined string would escape the \textbullet command itself. A base CV
		// that already says "open to" must not render "Open to open to ...".
		.map((item) => escapeLatex(item.replace(/^open to\s*/i, "")))
		.join("  \\textbullet  ")

	const skills = orderSkillsForPosting(profile, posting)
		.map(
			(group) =>
				`{\\color{ink}\\small\\bfseries ${escapeLatex(group.group)}}\\par\\vspace{3pt}\n${group.items
					.map((item) => skillBadge(item))
					.join("\\hspace{4pt}")}\\par\\vspace{3pt}`,
		)
		.join("\n")

	return [
		"\\documentclass[10pt,a4paper]{article}",
		"\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}\\usepackage{lmodern}",
		"\\usepackage[margin=1.35cm]{geometry}\\usepackage{hyperref}\\usepackage{xcolor}",
		// One palette, used everywhere: a deep blue doing the talking, cool
		// greys doing the receding.
		"\\definecolor{accent}{RGB}{27,58,92}",
		"\\definecolor{accentsoft}{RGB}{199,214,230}",
		"\\definecolor{softbg}{RGB}{238,243,248}",
		"\\definecolor{ink}{RGB}{30,34,40}",
		"\\definecolor{muted}{RGB}{88,96,108}",
		"\\hypersetup{colorlinks=true,linkcolor=accent,urlcolor=accent}",
		"\\pagestyle{empty}",
		"\\color{ink}",
		"\\setlength{\\parindent}{0pt}",
		// Accent-coloured bullets for every list in the document.
		"\\renewcommand{\\labelitemi}{{\\color{accent}\\small\\textbullet}}",
		"\\newcommand{\\cvsection}[1]{\\par\\vspace{7pt}{\\color{accent}\\footnotesize\\bfseries\\MakeUppercase{#1}}\\par\\vspace{2pt}{\\color{accent}\\rule{\\linewidth}{1.4pt}}\\par\\vspace{4pt}}",
		"\\newcommand{\\entry}[2]{\\par\\vspace{4pt}{#1 \\hfill {\\color{accent}\\small #2}}\\par\\vspace{1pt}}",
		"\\newenvironment{cvitems}{\\begin{itemize}\\setlength{\\itemsep}{0pt}\\setlength{\\parskip}{0pt}\\setlength{\\leftmargin}{1.2em}}{\\end{itemize}}",
		"\\begin{document}",
		// Name: big, in the accent colour, with a two-tone rule underneath.
		`{\\fontsize{24}{28}\\selectfont\\bfseries\\color{accent}${escapeLatex(profile.name)}}\\\\[6pt]`,
		`{\\small ${contactBits}}\\\\[3pt]`,
		linkBits ? `{\\small ${linkBits}}\\\\[3pt]` : "",
		availability
			? `\\colorbox{softbg}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep\\relax}{\\centering\\small\\textcolor{accent}{\\textbf{Open to} ${availability}}}}\\par\\vspace{2pt}`
			: "",
		"{\\color{accent}\\rule{\\linewidth}{2.2pt}}",
		profile.summary ? "\\cvsection{Professional Summary}" : "",
		profile.summary ? `{\\color{ink}${escapeLatex(profile.summary)}}` : "",
		profile.experience.length ? "\\cvsection{Experience}" : "",
		...profile.experience.flatMap(entryLines),
		profile.projects.length ? "\\cvsection{Selected Projects}" : "",
		...profile.projects.flatMap((project) => [
			`\\entry{\\textbf{${escapeLatex(project.name)}}${project.stack ? ` --- {\\color{muted}\\itshape ${escapeLatex(project.stack)}}` : ""}}{${dateRange(project.period)}}`,
			project.detail ? `{\\color{ink}${escapeLatex(project.detail)}}` : "",
		]),
		profile.education.length ? "\\cvsection{Education}" : "",
		...profile.education.map(
			(item) => `\\par\\vspace{3pt}{\\color{ink}${escapeLatex(item)}}`,
		),
		profile.certifications.length ? "\\cvsection{Certifications}" : "",
		...profile.certifications.map(
			(item) => `\\par\\vspace{3pt}{\\color{ink}${escapeLatex(item)}}`,
		),
		skills ? "\\cvsection{Skills}" : "",
		skills,
		profile.references.length ? "\\cvsection{References}" : "",
		...profile.references.map(
			(item) => `\\par\\vspace{3pt}{\\color{muted}\\small ${escapeLatex(item)}}`,
		),
		"\\end{document}",
	]
		.filter((line) => line !== "")
		.join("\n")
}

/**
 * A skill as a filled badge: soft background, accent text. The chain breaks
 * between badges (the \\hspace glue), so long lists wrap instead of overflowing.
 */
function skillBadge(skill: string): string {
	return `\\colorbox{softbg}{\\small\\textcolor{accent}{${escapeLatex(skill)}}}`
}
