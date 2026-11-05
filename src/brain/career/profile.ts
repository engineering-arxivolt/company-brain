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
