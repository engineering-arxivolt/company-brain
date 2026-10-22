/**
 * The writing rules that live in a repository, turned into playbooks.
 *
 * Arxivolt's content rules are markdown files in a GitHub repository
 * (`Arxivolt/content-engine`), not workspace skills: brand voice, the platform
 * rules for LinkedIn and X, the hook list, the founder lane, the UTM
 * convention. JEV classifies workspace skills, so those files were invisible
 * to it — the writer had the Founder Brain and the generic "Social Content"
 * playbook, and none of the house style.
 *
 * This module fetches those files and saves each one as a skill, so the
 * normal routing applies: JEV picks the right one for the turn, and the
 * writer can load a second when the first is not enough.
 */
import { createSkill, listSkills, updateSkill } from "../../skills/store"
import {
	normalizeSkillName,
	SKILL_BODY_MAX_BYTES,
	SKILL_DESCRIPTION_MAX_CHARS,
	SKILL_NAME_MAX_CHARS,
} from "../../skills/validation"
import type { CompanyBrainAgent } from "../../turn/agent"

export const CONTENT_ENGINE_REPO = "Arxivolt/content-engine"

/**
 * The nodes worth importing.
 *
 * The index and the weekly queue are deliberately left out: they are notes to
 * a human about what to write next, not rules about how to write it.
 */
export const CONTENT_ENGINE_NODES: Array<{
	path: string
	name: string
	description: string
}> = [
	{
		path: "nodes/10-brand-voice.md",
		name: "Arxivolt Brand Voice",
		description:
			"How Arxivolt writes: the voice, the register, the phrases that are banned and the ones that are house style.",
	},
	{
		path: "nodes/20-platform-linkedin.md",
		name: "Arxivolt LinkedIn Rules",
		description:
			"How a LinkedIn post is written and structured for Arxivolt: format, length, the CTA rule.",
	},
	{
		path: "nodes/30-platform-x.md",
		name: "Arxivolt X Rules",
		description:
			"How a post on X is written for Arxivolt: format, length, threads, the CTA rule.",
	},
	{
		path: "nodes/40-hooks.md",
		name: "Arxivolt Hooks",
		description:
			"The hook patterns that work for Arxivolt's audience, and the ones that do not.",
	},
	{
		path: "nodes/50-repurpose-chain.md",
		name: "Arxivolt Repurposing Chain",
		description:
			"How one piece of work becomes several posts without repeating itself.",
	},
	{
		path: "nodes/60-product-forge.md",
		name: "Arxivolt Forge Product Rules",
		description:
			"What may and may not be said about Forge in a post, and how the product is described.",
	},
	{
		path: "nodes/70-utms.md",
		name: "Arxivolt UTM Convention",
		description:
			"The UTM naming convention every Arxivolt link uses, so the scoreboard can attribute a post.",
	},
	{
		path: "nodes/80-founder-linkedin.md",
		name: "Arxivolt Founder Lane Rules",
		description:
			"The founder lane: first person, operator to operator, what the founder posts about and what never appears.",
	},
	{
		path: "nodes/80-substack.md",
		name: "Arxivolt Substack Rules",
		description:
			"What goes in the Substack note and what does not, and how it differs from a social post.",
	},
]

export type ContentEngineSyncResult = {
	repo: string
	created: string[]
	updated: string[]
	skipped: Array<{ path: string; reason: string }>
}

function fitBody(body: string, source: string): string {
	const header = `Source: ${source}\n\n`
	const room = SKILL_BODY_MAX_BYTES - header.length
	let text = body.trim()
	if (new TextEncoder().encode(text).byteLength > room) {
		// Keep the head of the file: the rules live at the top, and a
		// truncated tail is worse than a stated limit.
		text = `${text.slice(0, Math.max(200, Math.floor(room * 0.9)))}\n\n[Truncated: the source file is longer than a playbook body allows.]`
	}
	return `${header}${text}`
}

function fitDescription(description: string, body: string): string {
	const stated = description.trim()
	if (stated.length <= SKILL_DESCRIPTION_MAX_CHARS) return stated
	// Fall back to the file's first real line.
	const first = body
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("#"))
	return (first ?? stated).slice(0, SKILL_DESCRIPTION_MAX_CHARS)
}

/**
 * Fetch the nodes and save them as the operator's playbooks.
 *
 * Re-syncing updates the playbooks it created before and leaves every other
 * skill alone: a rule the operator rewrote by hand is not overwritten by the
 * file it came from.
 */
export async function syncContentEnginePlaybooks(args: {
	env: Env
	agent: CompanyBrainAgent
	orgId: string
	userId: string
	isAdmin: boolean
	repo?: string
	ref?: string
}): Promise<ContentEngineSyncResult> {
	const { env, agent, orgId, userId, isAdmin } = args
	const repo = args.repo?.trim() || CONTENT_ENGINE_REPO
	const ref = args.ref?.trim() || "main"
	const { operatorGitHubToken } = await import(
		"../../tools/github-connection"
	)
	const token = await operatorGitHubToken(env, orgId, userId).catch(() => null)
	if (!token) {
		return {
			repo,
			created: [],
			updated: [],
			skipped: CONTENT_ENGINE_NODES.map((node) => ({
				path: node.path,
				reason: "no GitHub connection for this user",
			})),
		}
	}
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.raw",
		Authorization: `Bearer ${token}`,
		"User-Agent": "company-brain",
	}
	const existing = listSkills(agent, { userId, isAdmin })
	const byName = new Map(
		existing.map((skill) => [normalizeSkillName(skill.name), skill]),
	)
	const result: ContentEngineSyncResult = {
		repo,
		created: [],
		updated: [],
		skipped: [],
	}

	for (const node of CONTENT_ENGINE_NODES) {
		let content: string
		try {
			const response = await fetch(
				`https://api.github.com/repos/${repo}/contents/${node.path}?ref=${encodeURIComponent(ref)}`,
				{ headers },
			)
			if (!response.ok) {
				result.skipped.push({
					path: node.path,
					reason: `fetch failed (${response.status})`,
				})
				continue
			}
			content = await response.text()
		} catch (err) {
			result.skipped.push({
				path: node.path,
				reason: err instanceof Error ? err.message : String(err),
			})
			continue
		}
		const body = fitBody(content, `${repo}/${node.path}`)
		const description = fitDescription(node.description, content)
		const name = node.name.slice(0, SKILL_NAME_MAX_CHARS)
		const current = byName.get(normalizeSkillName(name))
		try {
			if (current) {
				updateSkill(
					agent,
					current.id,
					{ name, description, body, scope: current.scope },
					userId,
					isAdmin,
					current.version,
				)
				result.updated.push(name)
			} else {
				createSkill(
					agent,
					{
						name,
						description,
						body,
						scope: "personal",
						origin: "web",
					},
					userId,
					isAdmin,
				)
				result.created.push(name)
			}
		} catch (err) {
			result.skipped.push({
				path: node.path,
				reason: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return result
}
