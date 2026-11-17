/**
 * The base CV as structured facts.
 *
 * Asking a model to emit raw LaTeX failed every time it was tried — escaping,
 * packages, page limits, one shot inside a token cap. Rendering is a solved,
 * testable problem; the model's only interesting contribution is *which* facts
 * to emphasise. So the facts are parsed here, once, and `render.ts` turns them
 * into LaTeX with no model in the loop.
 */
export type ResumeEntry = {
	title: string
	organisation: string
	period: string
	details: string[]
}

export type ResumeProject = {
	name: string
	period: string
	stack: string
	detail: string
}

export type CareerProfile = {
	name: string
	contact: {
		location: string
		email: string
		phone: string
		links: Array<{ label: string; url: string }>
		availability: string[]
	}
	summary: string
	experience: ResumeEntry[]
	projects: ResumeProject[]
	education: string[]
	certifications: string[]
	/** Skill group label → individual skills, in the profile's own order. */
	skills: Array<{ group: string; items: string[] }>
	references: string[]
}

/** The CV is Markdown we author ourselves, so the parse can stay strict. */
export function parseCareerProfile(markdown: string): CareerProfile {
	const text = markdown.replace(/\r\n/g, "\n")
	const name = text.match(/^#\s+(?:\S+\s+)*?—\s*(.+)$/m)?.[1]?.trim() ?? ""
	const sections = splitSections(text)

	const contactLines = lines(sections.contact)
	const contact = {
		location: field(contactLines, "location"),
		email: field(contactLines, "email"),
		phone: field(contactLines, "phone"),
		links: contactLinks(contactLines),
		availability: splitList(field(contactLines, "availability")),
	}

	const experience: ResumeEntry[] = []
	let current: ResumeEntry | null = null
	for (const line of lines(sections.experience)) {
		const heading = line.match(/^\*\*(.+?)\*\*\s*\((.*?)\)\s*$/)
		if (heading) {
			const [title = "", organisation = ""] = (heading[1] ?? "").split(/\s+—\s+/)
			current = {
				title: title.trim(),
				organisation: organisation.trim(),
				period: (heading[2] ?? "").trim(),
				details: [],
			}
			experience.push(current)
			continue
		}
		const bullet = line.match(/^[-*]\s+(.*)$/)
		if (bullet && current) current.details.push((bullet[1] ?? "").trim())
	}

	const projects = blocks(sections["key projects"]).flatMap((block) => {
		const heading = block[0]?.match(/^\*\*(.+?)\*\*\s*\((.*?)\)\s*$/)
		if (!heading) return []
		const [period = "", stack = ""] = (heading[2] ?? "").split(/\s*;\s*/)
		return [
			{
				name: (heading[1] ?? "").trim(),
				period: period.trim(),
				stack: stack.trim(),
				detail: block.slice(1).join(" ").trim(),
			},
		]
	})

	return {
		name,
		contact,
		summary: (sections["professional summary"] ?? "").trim(),
		experience,
		projects,
		education: bulletItems(sections.education),
		certifications: bulletItems(sections.certifications),
		skills: lines(sections.skills).flatMap((line) => {
			const match = line.match(/^[-*]\s+\*\*(.+?):\*\*\s*(.+)$/)
			if (!match) return []
			return [{ group: (match[1] ?? "").trim(), items: splitList(match[2] ?? "") }]
		}),
		references: bulletItems(sections.references),
	}
}

/**
 * How a person names one entry: "Software Developer — AdanianLabs".
 *
 * The CV has two entries titled "Software Developer", so a title alone is not an
 * identity. Every message and rejection that names an entry uses this label.
 */
export function entryLabel(entry: ResumeEntry): string {
	return entry.organisation
		? `${entry.title} — ${entry.organisation}`
		: entry.title
}

/** Case/dash/space-insensitive comparison key for titles and employers. */
function labelKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * Every entry a label could mean, most specific reading first.
 *
 * A model (or a person) can name an entry by its full heading, by its title, or
 * by the employer alone — "change the Nathan Digital dates" is the normal way to
 * ask, and it must resolve even though the title is "Frontend Developer". When a
 * title is shared by two jobs the caller gets both candidates and has to choose;
 * guessing would silently edit the wrong employer.
 */
export function matchExperienceEntries(
	profile: CareerProfile,
	label: string,
): ResumeEntry[] {
	const wanted = labelKey(label)
	if (!wanted) return []
	const exact = (value: string) => labelKey(value) === wanted
	const combined = profile.experience.filter((entry) =>
		exact(entryLabel(entry)),
	)
	if (combined.length) return combined
	const byTitle = profile.experience.filter((entry) => exact(entry.title))
	if (byTitle.length) return byTitle
	const byEmployer = profile.experience.filter(
		(entry) => entry.organisation && exact(entry.organisation),
	)
	if (byEmployer.length) return byEmployer
	return profile.experience.filter((entry) =>
		[entry.title, entry.organisation]
			.filter(Boolean)
			.map(labelKey)
			.some((field) => field.includes(wanted) || wanted.includes(field)),
	)
}

/**
 * The one entry a label means, or why it does not mean exactly one.
 *
 * `findExperienceEntry` is the lenient form tailoring uses (first match); an edit
 * must never be lenient, because the wrong match is a wrong fact on the page.
 */
export type ExperienceMatch =
	| { ok: true; entry: ResumeEntry }
	| { ok: false; reason: "none" | "ambiguous"; candidates: ResumeEntry[] }

export function resolveExperienceEntry(
	profile: CareerProfile,
	label: string,
): ExperienceMatch {
	const matches = matchExperienceEntries(profile, label)
	const [only] = matches
	if (only && matches.length === 1) return { ok: true, entry: only }
	if (!matches.length) return { ok: false, reason: "none", candidates: [] }
	return { ok: false, reason: "ambiguous", candidates: matches }
}

/** First match — the tailoring path, which falls back to the base CV anyway. */
export function findExperienceEntry(
	profile: CareerProfile,
	title: string,
): ResumeEntry | undefined {
	return matchExperienceEntries(profile, title)[0]
}

/**
 * The base CV's own Markdown, written back out.
 *
 * This is the inverse of `parseCareerProfile`, and it exists so an edit can be
 * persisted without inventing a second storage format: the Markdown *is* the
 * document, LaTeX is one rendering of it. A working CV (base + confirmed edits,
 * or the profile the last PDF was rendered from) round-trips through
 * parse → render → parse unchanged, which is what makes an edit a small patch
 * in code instead of a model rewriting the whole file.
 */
export function renderCareerProfileMarkdown(profile: CareerProfile): string {
	const contact = [
		profile.contact.location ? `- Location: ${profile.contact.location}` : "",
		profile.contact.email ? `- Email: ${profile.contact.email}` : "",
		profile.contact.phone ? `- Phone: ${profile.contact.phone}` : "",
		...profile.contact.links.map((link) => `- ${link.label}: ${link.url}`),
		profile.contact.availability.length
			? `- Availability: ${profile.contact.availability.join("; ")}`
			: "",
	].filter(Boolean)

	const experience = profile.experience.flatMap((entry) => [
		`**${entry.title}${entry.organisation ? ` — ${entry.organisation}` : ""}** (${entry.period})`,
		...entry.details.map((detail) => `- ${detail}`),
	])

	const projects = profile.projects.flatMap((project) => [
		`**${project.name}** (${[project.period, project.stack].filter(Boolean).join("; ")})`,
		project.detail,
	])

	const skills = profile.skills.map(
		(group) => `- **${group.group}:** ${group.items.join(", ")}`,
	)

	const bullets = (items: string[]) => items.map((item) => `- ${item}`)

	const sections: string[] = [
		`# Base CV${profile.name ? ` — ${profile.name}` : ""}`,
	]
	const section = (heading: string, body: string[]) => {
		if (body.length) sections.push(`## ${heading}`, body.join("\n"))
	}
	section("Contact", contact)
	section("Professional summary", profile.summary ? [profile.summary] : [])
	section("Experience", experience)
	section("Key projects", projects)
	section("Education", bullets(profile.education))
	section("Certifications", bullets(profile.certifications))
	section("Skills", skills)
	section("References", bullets(profile.references))
	return `${sections.join("\n\n")}\n`
}

export function splitSections(markdown: string): Record<string, string> {
	const sections: Record<string, string> = {}
	let heading = ""
	for (const line of markdown.split("\n")) {
		const match = line.match(/^##\s+(.+?)\s*$/)
		if (match) {
			heading = (match[1] ?? "").toLowerCase()
			sections[heading] ??= ""
			continue
		}
		if (heading) sections[heading] += `${line}\n`
	}
	return sections
}

function lines(section: string | undefined): string[] {
	return (section ?? "")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() && !line.trim().startsWith(">"))
}

function blocks(section: string | undefined): string[][] {
	const out: string[][] = []
	for (const line of lines(section)) {
		if (/^\*\*/.test(line) || !out.length) out.push([line])
		else out[out.length - 1]?.push(line)
	}
	return out
}

function field(input: string[], label: string): string {
	const match = input
		.map((line) => line.match(/^[-*]\s+(?:\*\*)?([^:]+?)(?:\*\*)?:\s*(.+)$/))
		.find((entry) => entry?.[1]?.trim().toLowerCase() === label)
	return (match?.[2] ?? "").trim()
}

function contactLinks(input: string[]): Array<{ label: string; url: string }> {
	return input.flatMap((line) => {
		const match = line.match(
			/^[-*]\s+(?:\*\*)?(LinkedIn|GitHub|Portfolio)(?:\*\*)?:\s*(\S+)$/i,
		)
		if (!match) return []
		const url = (match[2] ?? "").trim()
		return [
			{
				label: (match[1] ?? "").trim(),
				url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
			},
		]
	})
}

function bulletItems(section: string | undefined): string[] {
	return lines(section).flatMap((line) => {
		const match = line.match(/^[-*]\s+(.*)$/)
		return match ? [(match[1] ?? "").trim()] : []
	})
}

export function splitList(value: string): string[] {
	return value
		.split(/\s*(?:,|;|\band\b)\s*/i)
		.map((item) => item.trim())
		.filter(Boolean)
}
