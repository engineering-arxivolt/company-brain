/**
 * Turning a sandbox workspace into a pull request.
 *
 * The container is a throwaway workspace: it has no credentials and nothing
 * in it survives its sleep. The worker is the opposite — it holds the GitHub
 * connection. So the change travels from the container to the worker, and the
 * worker is what talks to GitHub.
 *
 * That split is the whole point. The throwaway environment never holds a
 * token, and the durable side never runs untrusted code.
 *
 * The safety properties are deliberate:
 *
 * - The pull request is always a **draft**. Nothing merges itself; a human
 *   reads the diff on the PR page and decides.
 * - The branch is always **new**. A tool that could push to main is a tool
 *   that can lose the repository.
 * - The diff goes in the PR body. The reviewer sees the change where they
 *   approve it, not in a chat message.
 */
import type { McpConnectionRow } from "../mcp/store"
import type { ToolProviderHandle } from "../mcp/provider"
import type { SandboxClient } from "./client"

const MAX_FILES_PER_PR = 20
const MAX_FILE_CHARS = 120_000
const MAX_BODY_CHARS = 60_000

/** Branches a tool must never push to. */
const PROTECTED_BRANCHES = new Set([
	"main",
	"master",
	"production",
	"prod",
	"release",
	"trunk",
	"default",
])

export function isProtectedBranch(branch: string): boolean {
	return PROTECTED_BRANCHES.has(branch.trim().toLowerCase())
}

export function isValidBranchName(branch: string): boolean {
	const value = branch.trim()
	if (!value || value.length > 100) return false
	return /^[A-Za-z0-9._\-/]+$/.test(value) && !value.includes("..")
}

/** The first JSON payload inside an MCP tool result (structured wins). */
export function extractPayload(result: unknown): unknown {
	if (!result || typeof result !== "object") return null
	const r = result as { structuredContent?: unknown; content?: unknown }
	if (r.structuredContent != null) return r.structuredContent
	if (Array.isArray(r.content)) {
		for (const part of r.content) {
			if (!part || typeof part !== "object") continue
			const p = part as { type?: unknown; text?: unknown }
			if (p.type !== "text" || typeof p.text !== "string") continue
			try {
				return JSON.parse(p.text)
			} catch {}
		}
	}
	return null
}

export function errorText(result: unknown): string | null {
	if (!result || typeof result !== "object") return null
	const r = result as { isError?: unknown; content?: unknown }
	if (r.isError !== true) return null
	const texts: string[] = []
	if (Array.isArray(r.content)) {
		for (const part of r.content) {
			if (!part || typeof part !== "object") continue
			const p = part as { type?: unknown; text?: unknown }
			if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
		}
	}
	return (
		texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300) ||
		"GitHub rejected the request"
	)
}

/** The pull request URL, wherever the response happens to carry it. */
export function findPullRequestUrl(payload: unknown): string | null {
	const seen = new Set<unknown>()
	const walk = (value: unknown, depth: number): string | null => {
		if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) {
			return null
		}
		seen.add(value)
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = walk(item, depth + 1)
				if (found) return found
			}
			return null
		}
		const record = value as Record<string, unknown>
		for (const key of ["html_url", "url", "pullRequestUrl", "prUrl"]) {
			const candidate = record[key]
			if (typeof candidate === "string" && candidate.includes("github.com"))
				return candidate
		}
		for (const nested of Object.values(record)) {
			const found = walk(nested, depth + 1)
			if (found) return found
		}
		return null
	}
	return walk(payload, 0)
}

export type OpenPullRequestArgs = {
	env: Env
	connection: McpConnectionRow
	handle: ToolProviderHandle
	client: SandboxClient
	sandboxId: string
	cwd: string
	owner: string
	repo: string
	baseBranch: string
	branch: string
	title: string
	body?: string | null
	/** Files to include. Defaults to everything the workspace changed. */
	paths?: readonly string[]
}

export type OpenPullRequestResult =
	| {
			ok: true
			url: string
			branch: string
			base: string
			files: string[]
			draft: true
	  }
	| { ok: false; error: string }

async function callTool(
	handle: ToolProviderHandle,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const result = await handle.callTool(name, args, { retryOnTimeout: true })
	const failure = errorText(result)
	if (failure) throw new Error(failure)
	return extractPayload(result)
}

export async function openPullRequestFromSandbox(
	args: OpenPullRequestArgs,
): Promise<OpenPullRequestResult> {
	if (!isValidBranchName(args.branch)) {
		return {
			ok: false,
			error: `"${args.branch}" is not a usable branch name. Use letters, digits, dots, dashes or slashes.`,
		}
	}
	if (isProtectedBranch(args.branch)) {
		return {
			ok: false,
			error: `Refusing to work on "${args.branch}". Propose a new branch and open the pull request from it.`,
		}
	}

	// What changed, and what to send. The workspace is the source of truth:
	// the model edits files there, so the diff is what it actually did.
	const diff = await args.client.diff({ sandboxId: args.sandboxId, cwd: args.cwd })
	const changed = diff.changedFiles.filter(
		(file) => !file.includes("..") && !file.startsWith("/"),
	)
	if (!changed.length) {
		return {
			ok: false,
			error:
				"Nothing has changed in the workspace yet. Edit a file with sandbox_write_file first, then check sandbox_diff.",
		}
	}
	const wanted = args.paths?.length ? changed.filter((f) => args.paths?.includes(f)) : changed
	if (!wanted.length) {
		return {
			ok: false,
			error: `None of the requested files changed. Changed files: ${changed.join(", ")}`,
		}
	}
	const files = wanted.slice(0, MAX_FILES_PER_PR)
	const payloads: Array<{ path: string; content: string }> = []
	for (const path of files) {
		const read = await args.client.readTextFile({
			sandboxId: args.sandboxId,
			path,
		})
		if (read.truncated) {
			return {
				ok: false,
				error: `${path} is too large to send in a pull request (over ${MAX_FILE_CHARS} characters). Make the change smaller, or apply it through the GitHub connector instead.`,
			}
		}
		payloads.push({ path, content: read.content })
	}

	const body = [
		args.body?.trim() || "",
		"",
		"## Changes",
		"",
		"```diff",
		diff.diff.slice(0, MAX_BODY_CHARS),
		"```",
	]
		.join("\n")
		.trim()

	try {
		await callTool(args.handle, "create_branch", {
			owner: args.owner,
			repo: args.repo,
			branch: args.branch,
			from_branch: args.baseBranch,
		})
		await callTool(args.handle, "push_files", {
			owner: args.owner,
			repo: args.repo,
			branch: args.branch,
			files: payloads,
			message: args.title,
		})
		const pr = await callTool(args.handle, "create_pull_request", {
			owner: args.owner,
			repo: args.repo,
			title: args.title,
			head: args.branch,
			base: args.baseBranch,
			body,
			draft: true,
		})
		const url = findPullRequestUrl(pr)
		if (!url) {
			return {
				ok: false,
				error:
					"GitHub accepted the push but did not return a pull request URL. Check the repository's pull requests tab.",
			}
		}
		return {
			ok: true,
			url,
			branch: args.branch,
			base: args.baseBranch,
			files: payloads.map((file) => file.path),
			draft: true,
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}
