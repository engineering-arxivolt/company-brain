/**
 * Importing playbooks from a skill repository.
 *
 * The brain's skills are stored per organization and surfaced to the model as
 * a short index, so a partner repository's `SKILL.md` files are useful raw
 * material but not ready-made playbooks: they are written for a different
 * harness (slash commands, relative reference files, connected MCP servers
 * that may not exist here), and several of them describe a workflow that the
 * brain can only follow if it knows where the rest of the repository is.
 *
 * This module does the translation it can do mechanically:
 *
 * - relative links become absolute repository links, so a `references/…`
 *   pointer is still readable instead of dangling;
 * - the source, ref and licence are recorded in the body, because Apache-2.0
 *   material has to keep its attribution;
 * - descriptions and bodies are fitted to the brain's limits, and anything
 *   that cannot be fitted is reported rather than silently truncated into
 *   nonsense.
 *
 * What it deliberately does not do is pretend a playbook applies here. The
 * pack list is curated, and every imported body carries the note that the
 * tools named in it may not exist.
 */
import {
	createSkill,
	listSkills,
	updateSkill,
} from "./store"
import {
	normalizeSkillName,
	SKILL_BODY_MAX_BYTES,
	SKILL_DESCRIPTION_MAX_CHARS,
	SKILL_NAME_MAX_CHARS,
	validateSkillInput,
	type SkillEditableInput,
} from "./validation"

const SOURCE_LINE_PREFIX = "Source:"
const IMPORT_NOTE =
	"Imported into Company Brain. Treat `/name` as this playbook, not a slash command, and use only the tools that exist here."

/** The marker that makes a re-import an update instead of a duplicate. */
export function importMarker(repo: string, path: string): string {
	return `<!-- company-brain:imported ${repo} ${path} -->`
}

export type SkillPack = {
	repo: string
	ref: string
	license: string
	/** Exact `plugin/skill` paths or plugin prefixes, matched by selectSkillPaths. */
	select: string[]
	/** Prepended to every body in the pack: how to use it in this harness. */
	preamble?: string
}

/**
 * Curated from anthropics/knowledge-work-plugins (Apache-2.0).
 *
 * The repository holds 252 playbooks; importing all of them would fill the
 * organization cap with material about bio-research, payroll and enterprise
 * sales that no turn here will ever route to. This is the subset that matches
 * what Arxivolt actually does: engineering, marketing and pSEO, compliance,
 * product, data, design, and customer support.
 */
const KNOWLEDGE_WORK_SELECT = [
	// engineering
	"engineering/architecture",
	"engineering/code-review",
	"engineering/debug",
	"engineering/deploy-checklist",
	"engineering/documentation",
	"engineering/incident-response",
	"engineering/standup",
	"engineering/system-design",
	"engineering/tech-debt",
	"engineering/testing-strategy",
	// marketing
	"marketing/brand-review",
	"marketing/campaign-plan",
	"marketing/competitive-brief",
	"marketing/content-creation",
	"marketing/draft-content",
	"marketing/email-sequence",
	"marketing/performance-report",
	"marketing/seo-audit",
	// small business (the closest thing in the pack to an operator's job)
	"small-business/brand-style",
	"small-business/content-strategy",
	"small-business/lead-triage",
	"small-business/outreach-composer",
	"small-business/proposal-builder",
	"small-business/report-builder",
	"small-business/seo-ai-visibility",
	"small-business/social-content-engine",
	// product
	"product-management/metrics-review",
	"product-management/product-brainstorming",
	"product-management/roadmap-update",
	"product-management/sprint-planning",
	"product-management/synthesize-research",
	"product-management/write-spec",
	// operations and compliance
	"operations/change-request",
	"operations/compliance-tracking",
	"operations/process-doc",
	"operations/risk-assessment",
	"operations/runbook",
	// data
	"data/analyze",
	"data/explore-data",
	"data/sql-queries",
	"data/validate-data",
	// design
	"design/accessibility-review",
	"design/design-critique",
	"design/ux-copy",
	// customer support
	"customer-support/draft-response",
	"customer-support/kb-article",
	"customer-support/ticket-triage",
]

export const SKILL_PACKS: Record<string, SkillPack> = {
	"knowledge-work": {
		repo: "anthropics/knowledge-work-plugins",
		ref: "main",
		license: "Apache-2.0",
		select: KNOWLEDGE_WORK_SELECT,
	},
	anidoodle: {
		repo: "alexgreensh/anidoodle",
		ref: "main",
		license: "Apache-2.0",
		select: ["plugins/anidoodle/skills/anidoodle"],
		preamble: [
			"**Before you start:** the engine and reference files live in the repository, not in this body.",
			"Clone it into a sandbox first — `sandbox_start({ repoUrl: \"https://github.com/alexgreensh/anidoodle\" })` —",
			"then work from `workspace/anidoodle/plugins/anidoodle/skills/anidoodle` (read `SKILL.md` there for the full playbook, and `references/` for the workflows it points at).",
			"Render with the Node tools in that directory; return the rendered files with `sandbox_get_artifact`.",
		].join("\n"),
	},
}

export type SkillRepoFile = { path: string; type: "blob" | "tree" }

/**
 * Whether a SKILL.md path is selected.
 *
 * Three forms are accepted so both a whole plugin (`engineering`) and one
 * playbook (`engineering/debug`, or just `debug`) can be named without the
 * caller having to know the repository layout.
 */
export function selectSkillPaths(
	files: readonly SkillRepoFile[],
	select: readonly string[] | undefined,
): string[] {
	const skillPaths = files
		.filter((file) => file.type === "blob" && /\/SKILL\.md$/i.test(file.path))
		.map((file) => file.path)
	if (!select?.length) return skillPaths
	const wanted = select
		.map((entry) => entry.trim().replace(/^\/+|\/+$/g, ""))
		.filter(Boolean)
	if (!wanted.length) return skillPaths
	return skillPaths.filter((path) => {
		const dir = path.replace(/\/SKILL\.md$/i, "")
		const slug = dir.split("/").at(-1) ?? ""
		// `marketing/skills/seo-audit` should answer to both its real path and
		// the `plugin/skill` shorthand a person would write.
		const compact = dir.replace(/\/skills\//g, "/")
		return wanted.some(
			(entry) =>
				dir === entry ||
				dir.startsWith(`${entry}/`) ||
				compact === entry ||
				compact.startsWith(`${entry}/`) ||
				slug === entry ||
				dir.endsWith(`/${entry}`),
		)
	})
}

/** The body a stored skill gets. */
export function fitSkillBody(args: {
	body: string
	repo: string
	ref: string
	path: string
	license: string
	preamble?: string
}): { body: string; truncated: boolean } {
	const source = `${SOURCE_LINE_PREFIX} ${args.repo} \`${args.path}\` (${args.ref}, ${args.license}). ${IMPORT_NOTE}`
	const head = args.preamble ? `${args.preamble}\n\n` : ""
	const marker = importMarker(args.repo, args.path)
	const footer = `\n\n---\n${marker}\n${source}\n`
	let body = `${head}${args.body.trim()}${footer}`
	const encoder = new TextEncoder()
	if (encoder.encode(body).byteLength <= SKILL_BODY_MAX_BYTES) {
		return { body, truncated: false }
	}
	// Cut on characters, then walk back to a byte boundary. The marker and
	// source line always survive, because the marker is what makes the next
	// import an update rather than a duplicate.
	const tail = `${footer}\n_[The rest of this playbook is in ${args.repo} at \`${args.path}\`.]_`
	const budget = SKILL_BODY_MAX_BYTES - encoder.encode(`${head}${tail}`).byteLength
	let cut = body.length
	while (cut > 0 && encoder.encode(body.slice(0, cut)).byteLength > budget) {
		cut -= 200
	}
	body = `${head}${body.slice(0, Math.max(0, cut)).trimEnd()}${tail}`
	return { body, truncated: true }
}

/** One line, and never longer than the index can render. */
export function fitSkillDescription(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim()
	if (normalized.length <= SKILL_DESCRIPTION_MAX_CHARS) return normalized
	return `${normalized.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
}

export function fitSkillName(value: string): string {
	const trimmed = value.trim().replace(/\s+/g, "-")
	return trimmed.slice(0, SKILL_NAME_MAX_CHARS)
}

/**
 * Make relative Markdown links resolvable.
 *
 * A playbook that says "read `references/calendar.md`" is only usable if that
 * path exists. It does not exist inside the brain, so the link becomes the
 * repository URL; the model can fetch it, and the reader can see where it
 * came from. Absolute links, anchors and mail links are left alone.
 */
export function rewriteRelativeLinks(
	body: string,
	args: { repo: string; ref: string; path: string },
): string {
	const baseDir = args.path.split("/").slice(0, -1).join("/")
	return body.replace(
		/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
		(full, target: string, title: string) => {
			if (
				!target ||
				/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target) ||
				target.startsWith("/")
			) {
				return full
			}
			const hashAt = target.indexOf("#")
			const rawPath = hashAt >= 0 ? target.slice(0, hashAt) : target
			const hash = hashAt >= 0 ? target.slice(hashAt) : ""
			if (!rawPath) return full
			const resolved = resolveRelative(baseDir, rawPath)
			if (!resolved) return full
			return `](https://github.com/${args.repo}/blob/${args.ref}/${resolved}${hash}${title})`
		},
	)
}

function resolveRelative(baseDir: string, target: string): string | null {
	const parts = baseDir ? baseDir.split("/") : []
	for (const segment of decodeURIComponent(target).split("/")) {
		if (!segment || segment === ".") continue
		if (segment === "..") {
			if (!parts.length) return null
			parts.pop()
			continue
		}
		parts.push(segment)
	}
	return parts.join("/")
}

export type ParsedSkill = {
	name: string
	description: string
	body: string
	path: string
	truncatedBody: boolean
}

export type SkillFetchResult = {
	repo: string
	ref: string
	skills: ParsedSkill[]
	skipped: Array<{ path: string; reason: string }>
}

export type FetchLike = (
	input: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

async function githubJson<T>(
	fetchImpl: FetchLike,
	url: string,
	headers: Record<string, string>,
): Promise<T> {
	const response = await fetchImpl(url, { headers })
	if (!response.ok) {
		throw new Error(
			`GitHub returned ${response.status} for ${url.replace(/^https:\/\/api\.github\.com/, "")}`,
		)
	}
	return JSON.parse(await response.text()) as T
}

/**
 * Fetch, parse and adapt every selected SKILL.md from a repository.
 *
 * GitHub is read through the API rather than raw.githubusercontent.com so one
 * credential covers public and private repositories alike.
 */
export async function fetchSkillsFromRepo(args: {
	fetchImpl: FetchLike
	repo: string
	ref?: string
	select?: readonly string[]
	max?: number
	license?: string
	preamble?: string
	token?: string | null
	/** For tests: skip the network entirely. */
	files?: Array<{ path: string; content: string }>
}): Promise<SkillFetchResult> {
	const repo = args.repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		throw new Error("Repository must look like owner/name.")
	}
	const ref = args.ref?.trim() || "main"
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "company-brain",
		...(args.token ? { Authorization: `Bearer ${args.token}` } : {}),
	}

	const fileTree: SkillRepoFile[] = args.files
		? args.files.map((file) => ({ path: file.path, type: "blob" as const }))
		: (
				await githubJson<{
					tree: Array<{ path: string; type: string }>
					truncated?: boolean
				}>(
					args.fetchImpl,
					`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
					headers,
				)
			).tree.map((entry) => ({
				path: entry.path,
				type: entry.type === "tree" ? ("tree" as const) : ("blob" as const),
			}))

	const selected = selectSkillPaths(fileTree, args.select).slice(0, args.max ?? 60)
	const skills: ParsedSkill[] = []
	const skipped: Array<{ path: string; reason: string }> = []

	// One request per playbook, six at a time. Sequential fetching of a
	// 47-skill pack takes long enough that the turn's tool timeout is a real
	// risk; unbounded concurrency burns the GitHub rate limit in a burst.
	const outcomes: Array<
		| { ok: true; path: string; content: string }
		| { ok: false; path: string; reason: string }
	> = new Array(selected.length)
	let cursor = 0
	const worker = async () => {
		while (cursor < selected.length) {
			const index = cursor++
			const path = selected[index] as string
			if (args.files) {
				outcomes[index] = {
					ok: true,
					path,
					content: args.files.find((file) => file.path === path)?.content ?? "",
				}
				continue
			}
			const response = await args.fetchImpl(
				`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
				{ headers: { ...headers, Accept: "application/vnd.github.raw" } },
			)
			outcomes[index] = response.ok
				? { ok: true, path, content: await response.text() }
				: {
						ok: false,
						path,
						reason: `contents fetch failed (${response.status})`,
					}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(6, selected.length) }, () => worker()),
	)

	for (const outcome of outcomes) {
		if (!outcome) continue
		if (!outcome.ok) {
			skipped.push({ path: outcome.path, reason: outcome.reason })
			continue
		}
		const parsed = parseSkillMarkdown(outcome.content, outcome.path, {
			repo,
			ref,
			license: args.license ?? "see the source repository",
			preamble: args.preamble,
		})
		if (!parsed.ok) {
			skipped.push({ path: outcome.path, reason: parsed.reason })
			continue
		}
		skills.push(parsed.skill)
	}

	return { repo, ref, skills, skipped }
}

export function parseSkillMarkdown(
	content: string,
	path: string,
	options: { repo: string; ref: string; license: string; preamble?: string },
):
	| { ok: true; skill: ParsedSkill }
	| { ok: false; reason: string } {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
	const lines = normalized.split("\n")
	if (lines[0]?.trim() !== "---") {
		return { ok: false, reason: "no YAML frontmatter" }
	}
	const end = lines.findIndex((line, index) => index > 0 && /^---[\t ]*$/.test(line))
	if (end < 0) return { ok: false, reason: "frontmatter is not closed" }
	const frontmatter = parseYamlSubset(lines.slice(1, end).join("\n"))
	const rawName = frontmatter.get("name")?.trim()
	const rawDescription = frontmatter.get("description")?.trim()
	if (!rawName) return { ok: false, reason: "frontmatter has no name" }
	if (!rawDescription) return { ok: false, reason: "frontmatter has no description" }

	const name = fitSkillName(rawName)
	const description = fitSkillDescription(rawDescription)
	const rawBody = rewriteRelativeLinks(lines.slice(end + 1).join("\n").trim(), {
		repo: options.repo,
		ref: options.ref,
		path,
	})
	const fitted = fitSkillBody({
		body: rawBody,
		repo: options.repo,
		ref: options.ref,
		path,
		license: options.license,
		preamble: options.preamble,
	})
	const validated = validateImportable({ name, description, body: fitted.body, scope: "org" })
	if (!validated.ok) return { ok: false, reason: validated.reason }
	return {
		ok: true,
		skill: {
			name: validated.input.name,
			description: validated.input.description,
			body: validated.input.body,
			path,
			truncatedBody: fitted.truncated,
		},
	}
}

function validateImportable(
	input: SkillEditableInput,
):
	| { ok: true; input: SkillEditableInput }
	| { ok: false; reason: string } {
	try {
		return { ok: true, input: validateSkillInput(input) }
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		}
	}
}

/**
 * The slice of YAML that SKILL.md frontmatter actually uses.
 *
 * `parseSkillMarkdown` in validation.ts exists for uploads, but it rejects any
 * description longer than the index limit instead of fitting it, and imported
 * skills routinely run to 600 characters. This keeps the same shape — plain
 * scalars, folded (`>`) and literal (`|`) blocks — and leaves validation to
 * the caller after fitting.
 */
export function parseYamlSubset(raw: string): Map<string, string> {
	const lines = raw.split("\n")
	const values = new Map<string, string>()
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? ""
		if (!line.trim() || line.trimStart().startsWith("#")) continue
		// Nested metadata (`metadata:`, `allowed-tools:`) is not part of the
		// skill contract; only top-level scalars matter here.
		if (/^\s+/.test(line)) continue
		const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
		if (!match) continue
		const key = (match[1] ?? "").toLowerCase()
		if (key !== "name" && key !== "description") continue
		const rawValue = (match[2] ?? "").trim()
		if (/^[>|][+-]?$/.test(rawValue)) {
			const block: string[] = []
			while (index + 1 < lines.length) {
				const candidate = lines[index + 1] ?? ""
				if (candidate.trim() && !/^\s+/.test(candidate)) break
				index += 1
				block.push(candidate.replace(/^ {1,4}/, ""))
			}
			const value = rawValue.startsWith(">")
				? block.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ").replace(/\n{2,}/g, "\n")
				: block.join("\n")
			values.set(key, value.trim())
			continue
		}
		values.set(key, unquote(rawValue))
	}
	return values
}

function unquote(value: string): string {
	const trimmed = value.trim()
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const decoded = JSON.parse(trimmed)
			if (typeof decoded === "string") return decoded.trim()
		} catch {}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'").trim()
	}
	return trimmed
}

export type PersistResult = {
	created: string[]
	updated: string[]
	skipped: Array<{ name: string; reason: string }>
}

export type RunSkillImportArgs = {
	env: Env
	agent: import("../turn/agent").CompanyBrainAgent
	viewer: { userId: string; isAdmin: boolean }
	orgId: string
	/** A curated pack name, a repository, or both (a pack supplies defaults). */
	pack?: string
	repo?: string
	ref?: string
	select?: readonly string[]
	max?: number
	fetchImpl?: FetchLike
}

export type RunSkillImportResult = PersistResult & {
	pack: string | null
	repo: string
	ref: string
	fetched: number
	skippedFiles: Array<{ path: string; reason: string }>
}

/** Fetch a pack (or a named repository) and write it into the organization. */
export async function runSkillImport(
	args: RunSkillImportArgs,
): Promise<RunSkillImportResult> {
	if (!args.viewer.isAdmin) {
		throw new Error("Only an organization admin can import skills.")
	}
	const pack = args.pack ? SKILL_PACKS[args.pack] : undefined
	if (args.pack && !pack) {
		throw new Error(
			`Unknown pack "${args.pack}". Available packs: ${Object.keys(SKILL_PACKS).join(", ")}.`,
		)
	}
	const repo = args.repo?.trim() || pack?.repo
	if (!repo) throw new Error("A pack name or a repository (owner/name) is required.")
	const ref = args.ref?.trim() || pack?.ref || "main"
	const { operatorGitHubToken } = await import("../tools/github-connection")
	const token = await operatorGitHubToken(
		args.env,
		args.orgId,
		args.viewer.userId,
	).catch(() => null)
	const fetched = await fetchSkillsFromRepo({
		fetchImpl: args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
		repo,
		ref,
		select: args.select ?? pack?.select,
		max: args.max,
		license: pack?.license,
		preamble: pack?.preamble,
		token,
	})
	const persisted = persistImportedSkills({
		agent: args.agent,
		viewer: args.viewer,
		repo: fetched.repo,
		ref: fetched.ref,
		skills: fetched.skills,
	})
	return {
		pack: args.pack ?? null,
		repo: fetched.repo,
		ref: fetched.ref,
		fetched: fetched.skills.length,
		skippedFiles: fetched.skipped,
		...persisted,
	}
}

/**
 * Write fetched skills into the organization.
 *
 * Re-importing the same repository updates the skills it created before and
 * leaves every other skill alone: a playbook someone edited by hand must not
 * be silently overwritten, and a name collision with a hand-written skill is
 * reported rather than resolved by guessing.
 */
export function persistImportedSkills(args: {
	agent: import("../turn/agent").CompanyBrainAgent
	viewer: { userId: string; isAdmin: boolean }
	repo: string
	ref: string
	skills: readonly ParsedSkill[]
}): PersistResult {
	const { agent, viewer, repo, skills } = args
	const existing = listSkills(agent, viewer)
	const byName = new Map(
		existing.map((skill) => [normalizeSkillName(skill.name), skill]),
	)
	const result: PersistResult = { created: [], updated: [], skipped: [] }

	for (const skill of skills) {
		const marker = importMarker(repo, skill.path)
		const current = byName.get(normalizeSkillName(skill.name))
		try {
			if (current) {
				if (!current.body.includes(marker)) {
					result.skipped.push({
						name: skill.name,
						reason:
							"a skill with this name already exists and was not imported from this repository",
					})
					continue
				}
				updateSkill(
					agent,
					current.id,
					{
						name: skill.name,
						description: skill.description,
						body: skill.body,
						scope: "org",
					},
					viewer.userId,
					viewer.isAdmin,
					current.version,
				)
				result.updated.push(skill.name)
				continue
			}
			createSkill(
				agent,
				{
					name: skill.name,
					description: skill.description,
					body: skill.body,
					scope: "org",
					origin: "upload",
				},
				viewer.userId,
				viewer.isAdmin,
			)
			result.created.push(skill.name)
		} catch (error) {
			result.skipped.push({
				name: skill.name,
				reason: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return result
}
