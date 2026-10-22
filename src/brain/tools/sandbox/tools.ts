import type { ToolSet } from "ai"
import { logPreview } from "../../observability/log-utils"
import { uploadSlackFile } from "../../slack/client"
import type { CompanyBrainAgent } from "../../turn/agent"
import type { TurnDeps } from "../../turn/deps"
import { findGitHubConnection, operatorGitHubToken } from "../github-connection"
import {
	base64FromArrayBuffer,
	createSandboxClient,
	sandboxToolsConfigured,
} from "./client"
import {
	normalizeCwd,
	normalizePath,
	sandboxLimits,
	validateRepoUrl,
	validateSearchPattern,
} from "./guards"
import {
	clearSandboxEdits,
	deleteSandboxSession,
	listSandboxEdits,
	loadSandboxSession,
	saveSandboxEdit,
	type SandboxSessionScope,
	sandboxSessionKey,
	saveSandboxSession,
	touchSandboxSession,
} from "./sessions"
import { openPullRequestFromSandbox } from "./pull-request"

export type CreateSandboxToolsArgs = {
	env: Env
	agent: CompanyBrainAgent
	deps: TurnDeps
	scope: SandboxSessionScope
	/** Present only for an interactive Slack turn. Never persisted with session state. */
	slackArtifactDestination?: {
		botToken: string
		channel: string
		threadTs?: string
		signal?: AbortSignal
		canShare?: () => boolean
	}
	traceId: string
}

function missingSession() {
	return {
		isError: true,
		error: "No active sandbox. Call sandbox_start first.",
	}
}

function toolError(error: unknown) {
	return {
		isError: true,
		error: error instanceof Error ? error.message : String(error),
	}
}

function artifactFilename(path: string): string {
	const filename = path.split("/").filter(Boolean).at(-1)?.trim()
	return filename || "sandbox-artifact"
}

class SlackArtifactUploadError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SlackArtifactUploadError"
	}
}

export function createSandboxTools(args: CreateSandboxToolsArgs): ToolSet {
	if (!sandboxToolsConfigured(args.env)) return {}

	const { env, agent, deps, scope, traceId } = args
	const sessionKey = sandboxSessionKey(scope)
	// The operator's GitHub credential, fetched only when a clone turns out to
	// need it. The worker holds it; the container only ever sees it for the
	// length of one clone.
	const client = createSandboxClient(env, {
		githubToken: () => operatorGitHubToken(env, scope.orgId, scope.userId),
	})
	// Models sometimes inspect the same artifact twice while drafting their
	// answer. Reusing a successful upload keeps that from creating duplicates.
	const artifactUploads = new Map<
		string,
		Promise<{ fileId: string; sizeBytes: number; path: string }>
	>()

	/**
	 * The session, opened on demand.
	 *
	 * A model that reaches for a sandbox tool without setting one up first
	 * used to get "call sandbox_start first" and lose a round trip to it. A
	 * workspace opens itself instead, so the work starts where the model is.
	 */
	const ensureSession = async (goal: string) => {
		const existing = loadSandboxSession(agent, sessionKey)
		if (existing) return existing
		const created = await client.createSandbox({ goal })
		const session = saveSandboxSession(agent, {
			sessionKey,
			sandboxId: created.sandboxId,
			orgId: scope.orgId,
			userId: scope.userId ?? null,
			channel: scope.channel ?? null,
			threadTs: scope.threadTs ?? null,
			defaultCwd: created.defaultCwd,
			repoUrl: created.repoUrl ?? null,
			goal,
		})
		console.log(
			`[company-brain][${traceId}] sandbox opened on demand id=${session.sandboxId} cwd=${session.defaultCwd}`,
		)
		return session
	}

	const sandbox_start = deps.tool({
		description:
			"Create or reuse an isolated workspace for code/repo/file/PDF work, cloning a repository into it when you give one. Private repositories work too: the workspace is set up with the operator's own GitHub access. Call this before a long piece of work; a one-off sandbox tool call opens a workspace on its own.",
		inputSchema: deps.z.object({
			goal: deps.z
				.string()
				.min(1)
				.describe("Short description of what this workspace is for."),
			repoUrl: deps.z
				.string()
				.optional()
				.describe("Optional public https repository URL to clone."),
		}),
		execute: async ({ goal, repoUrl }) => {
			try {
				// Normalize the requested repo scope: null = bare workspace, a
				// normalized URL = specific repo. Reuse only when it matches the
				// running session's repo, else the model would keep operating from
				// the previous repo's workspace after switching repos.
				const requested = repoUrl ? validateRepoUrl(repoUrl) : null
				// Reject a bad repo URL before touching the existing session.
				if (requested && !requested.ok) {
					return { isError: true, error: requested.error }
				}
				const requestedRepo = requested ? requested.url : null

				const existing = loadSandboxSession(agent, sessionKey)
				const scopeMatches =
					existing != null &&
					requestedRepo !== undefined &&
					existing.repoUrl === requestedRepo
				// A live container is not the same as a ready workspace: a clone
				// that failed leaves the container running and the repository
				// missing, and reusing it means grepping an empty directory and
				// concluding the code does not exist.
				const workspaceReady = existing
					? await client.workspaceHasPath({
							sandboxId: existing.sandboxId,
							path: existing.defaultCwd,
						})
					: false
				if (
					existing &&
					scopeMatches &&
					workspaceReady &&
					(await client.isSandboxRunning(existing.sandboxId))
				) {
					const touched = touchSandboxSession(agent, existing)
					console.log(
						`[company-brain][${traceId}] sandbox_start reuse id=${touched.sandboxId} cwd=${touched.defaultCwd} repo=${touched.repoUrl ?? "-"}`,
					)
					return {
						reused: true,
						sandboxId: touched.sandboxId,
						defaultCwd: touched.defaultCwd,
						repoUrl: touched.repoUrl ?? undefined,
						expiresAt: touched.expiresAt,
					}
				}
				if (existing) {
					// Drop the session when the repo scope changed, or when the
					// sandbox already slept or stopped and lost its workspace, so a
					// cached id can't be reused wrongly.
					deleteSandboxSession(agent, sessionKey)
					const reason = scopeMatches ? "stale" : "repo-changed"
					console.log(
						`[company-brain][${traceId}] sandbox_start ${reason} id=${existing.sandboxId} repo=${existing.repoUrl ?? "-"} dropped; recreating`,
					)
				}

				artifactUploads.clear()
				const created = await client.createSandbox({ goal, repoUrl })
				const session = saveSandboxSession(agent, {
					sessionKey,
					sandboxId: created.sandboxId,
					orgId: scope.orgId,
					userId: scope.userId ?? null,
					channel: scope.channel ?? null,
					threadTs: scope.threadTs ?? null,
					defaultCwd: created.defaultCwd,
					repoUrl: created.repoUrl ?? null,
					goal,
				})
				// A cold container comes back from the image, so the edits this
				// session made have to be replayed on top of the fresh clone.
				// Without this, a container that slept halfway through a task
				// took the work with it.
				const edits = listSandboxEdits(agent, sessionKey)
				let replayed = 0
				for (const edit of edits) {
					const written = await client
						.writeFile({
							sandboxId: session.sandboxId,
							path: edit.path,
							content: edit.content,
						})
						.catch(() => null)
					if (written) replayed++
				}
				if (edits.length) {
					console.log(
						`[company-brain][${traceId}] sandbox_start replayed ${replayed}/${edits.length} edit(s) onto the fresh workspace`,
					)
				}
				console.log(
					`[company-brain][${traceId}] sandbox_start created id=${session.sandboxId} cwd=${session.defaultCwd} repo=${created.repoUrl ?? "-"}`,
				)
				return {
					reused: false,
					sandboxId: session.sandboxId,
					defaultCwd: session.defaultCwd,
					repoUrl: created.repoUrl,
					cloneOutput: created.cloneOutput,
					expiresAt: session.expiresAt,
					...(replayed > 0 ? { replayedEdits: replayed } : {}),
				}
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_run = deps.tool({
		description:
			"Run a bounded shell command in the active sandbox workspace. Use for inspection, package-backed analysis, tests, scripts, and artifact generation. External writes like git push/deploy are blocked in V1.",
		inputSchema: deps.z.object({
			command: deps.z.string().min(1).describe("Shell command to run."),
			reason: deps.z
				.string()
				.min(1)
				.describe("Why this command is needed for the user's request."),
			cwd: deps.z
				.string()
				.optional()
				.describe("Working directory. Defaults to the sandbox repo/workspace."),
			timeoutSec: deps.z
				.number()
				.int()
				.min(1)
				.max(sandboxLimits.maxTimeoutSec)
				.optional(),
		}),
		execute: async ({ command, reason, cwd, timeoutSec }) => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				// A command can replace an artifact at the same path, so cached Slack
				// file IDs are no longer safe once execution resumes.
				artifactUploads.clear()
				console.log(
					`[company-brain][${traceId}] sandbox_run id=${session.sandboxId} reason="${logPreview(reason)}" command="${logPreview(command)}"`,
				)
				const out = await client.runCommand({
					sandboxId: session.sandboxId,
					command,
					cwd: normalizeCwd(cwd, session.defaultCwd),
					timeoutSec,
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_list_files = deps.tool({
		description:
			"List files in the active sandbox workspace. Use glob to search by filename pattern.",
		inputSchema: deps.z.object({
			path: deps.z.string().optional().describe("Directory to list."),
			glob: deps.z
				.string()
				.optional()
				.describe("Optional filename glob, e.g. '*.ts' or '*.pdf'."),
		}),
		execute: async ({ path, glob }) => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				const out = await client.listFiles({
					sandboxId: session.sandboxId,
					path: normalizePath(path, session.defaultCwd),
					glob,
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_read_file = deps.tool({
		description:
			"Read a capped text file from the active sandbox. For binary files or generated PDFs/images, use sandbox_get_artifact instead.",
		inputSchema: deps.z.object({
			path: deps.z.string().min(1).describe("Path to the text file."),
		}),
		execute: async ({ path }) => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				const out = await client.readTextFile({
					sandboxId: session.sandboxId,
					path: normalizePath(path, session.defaultCwd),
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_get_artifact = deps.tool({
		description:
			"Retrieve a small generated artifact from the active sandbox, such as a PDF, CSV, image, or report. During an interactive Slack turn, it is automatically uploaded into the active thread so images render inline; otherwise it returns base64 content with metadata.",
		inputSchema: deps.z.object({
			path: deps.z.string().min(1).describe("Path to the generated artifact."),
		}),
		execute: async ({ path }) => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				const slackDestination = args.slackArtifactDestination
				if (!slackDestination) {
					const out = await client.getArtifact({
						sandboxId: session.sandboxId,
						path: normalizePath(path, session.defaultCwd),
					})
					touchSandboxSession(agent, session)
					return {
						path: out.path,
						sizeBytes: out.sizeBytes,
						base64: base64FromArrayBuffer(out.content),
						truncated: false,
					}
				}
				const artifactPath = normalizePath(path, session.defaultCwd)
				const existing = artifactUploads.get(artifactPath)
				if (existing) {
					const uploaded = await existing
					touchSandboxSession(agent, session)
					return {
						path: uploaded.path,
						sizeBytes: uploaded.sizeBytes,
						uploaded: true,
						reusedUpload: true,
						slackFileId: uploaded.fileId,
					}
				}

				// Install the promise before awaiting any I/O so parallel tool calls
				// for the same path share one upload rather than racing two files.
				const uploadPromise = (async () => {
					const out = await client.getArtifactStream({
						sandboxId: session.sandboxId,
						path: artifactPath,
						signal: slackDestination.signal,
					})
					touchSandboxSession(agent, session)

					const filename = artifactFilename(out.path)
					const upload = await uploadSlackFile(slackDestination.botToken, {
						channel: slackDestination.channel,
						threadTs: slackDestination.threadTs,
						filename,
						sizeBytes: out.sizeBytes,
						content: out.content,
						altText: `Generated artifact: ${filename}`,
						signal: slackDestination.signal,
						canShare: slackDestination.canShare,
					})
					if (!upload.ok) {
						const scopeHint =
							upload.error === "missing_scope"
								? " Reinstall Company Brain to grant files:write."
								: ""
						throw new SlackArtifactUploadError(
							`Created ${filename}, but Slack could not upload it (${upload.stage}: ${upload.error}).${scopeHint}`,
						)
					}
					return {
						fileId: upload.fileId,
						sizeBytes: out.sizeBytes,
						path: out.path,
					}
				})()
				artifactUploads.set(artifactPath, uploadPromise)
				let uploaded: Awaited<typeof uploadPromise>
				try {
					uploaded = await uploadPromise
				} catch (error) {
					if (artifactUploads.get(artifactPath) === uploadPromise) {
						artifactUploads.delete(artifactPath)
					}
					throw error
				}
				return {
					path: uploaded.path,
					sizeBytes: uploaded.sizeBytes,
					uploaded: true,
					slackFileId: uploaded.fileId,
				}
			} catch (error) {
				if (error instanceof SlackArtifactUploadError) throw error
				return toolError(error)
			}
		},
	})

	const sandbox_write_file = deps.tool({
		description:
			"Write or replace a file in the active sandbox workspace. Use it to make a real edit to code you have read — a fix, a new file, a config change — and then use sandbox_diff to review what changed. The write stays inside the sandbox until you open a pull request from it.",
		inputSchema: deps.z.object({
			path: deps.z
				.string()
				.min(1)
				.describe("Path to the file, relative to the workspace root."),
			content: deps.z
				.string()
				.describe("The full new contents of the file."),
			reason: deps.z
				.string()
				.min(1)
				.describe("Why this edit is needed for the user's request."),
		}),
		execute: async ({ path, content, reason }) => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				const target = normalizePath(path, session.defaultCwd)
				console.log(
					`[company-brain][${traceId}] sandbox_write_file path=${target} chars=${content.length} reason="${logPreview(reason)}"`,
				)
				const out = await client.writeFile({
					sandboxId: session.sandboxId,
					path: target,
					content,
				})
				// Keep the edit outside the container: a container that goes to
				// sleep loses its filesystem, and the work should not die with
				// it.
				saveSandboxEdit(agent, sessionKey, target, content)
				touchSandboxSession(agent, session)
				return { ...out, written: true }
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_search = deps.tool({
		description:
			"Search the active sandbox workspace for a pattern (a regular expression, or a plain word). Use it to find where something lives in a cloned repository before reading files — reading a codebase one file at a time does not scale. Returns file, line number and the matching line.",
		inputSchema: deps.z.object({
			query: deps.z
				.string()
				.min(1)
				.describe("The pattern to search for, e.g. 'DEGRADED_NOTICE' or 'createAutomation\\('."),
			path: deps.z
				.string()
				.optional()
				.describe("Directory to search in. Defaults to the workspace root."),
			glob: deps.z
				.string()
				.optional()
				.describe("Only search files matching this glob, e.g. '*.ts'."),
			limit: deps.z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe("Maximum matches to return. Defaults to 40."),
		}),
		execute: async ({ query, path, glob, limit }) => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				const pattern = validateSearchPattern(query)
				if (!pattern.ok) return { error: pattern.error }
				const out = await client.search({
					sandboxId: session.sandboxId,
					query: pattern.query,
					path: normalizePath(path, session.defaultCwd),
					glob,
					limit,
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_diff = deps.tool({
		description:
			"Show what changed in the active sandbox workspace: the changed files and the diff. Run it after editing files, before proposing the change to anyone — a change nobody has seen is a change nobody can approve.",
		inputSchema: deps.z.object({}),
		execute: async () => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				const out = await client.diff({
					sandboxId: session.sandboxId,
					cwd: session.defaultCwd,
				})
				touchSandboxSession(agent, session)
				return out
			} catch (error) {
				return toolError(error)
			}
		},
	})

	const sandbox_open_pull_request = deps.tool({
		description:
			"Open a DRAFT pull request from the changes in the active sandbox. Use it after sandbox_write_file and sandbox_diff, once the change is ready for a human to review. The pull request always targets a new branch and is always a draft: it is never merged and never deployed. The diff is included in the pull request body so the reviewer sees exactly what changed.",
		inputSchema: deps.z.object({
			owner: deps.z.string().min(1).describe("Repository owner, e.g. Arxivolt."),
			repo: deps.z.string().min(1).describe("Repository name, e.g. arxivolt-engine."),
			base_branch: deps.z
				.string()
				.min(1)
				.describe("Branch the pull request merges into, e.g. main."),
			branch: deps.z
				.string()
				.min(1)
				.describe("New branch to push the change to. Never use main or master."),
			title: deps.z.string().min(1).describe("Pull request title."),
			body: deps.z
				.string()
				.optional()
				.describe("What the change does and why."),
			paths: deps.z
				.array(deps.z.string())
				.optional()
				.describe("Files to include. Defaults to every changed file."),
		}),
		execute: async ({
			owner,
			repo,
			base_branch,
			branch,
			title,
			body,
			paths,
		}) => {
			try {
				const session = await ensureSession(
					"workspace opened on demand for a sandbox tool call",
				)
				const connection = await findGitHubConnection(
					env,
					scope.orgId,
					scope.userId,
				)
				if (!connection) {
					return {
						isError: true,
						error:
							"No GitHub connection is available. Connect GitHub under Settings → Connectors first.",
					}
				}
				const { connectToolProvider } = await import("../mcp/provider")
				const handle = await connectToolProvider(
					env,
					connection,
					`${env.PUBLIC_URL}/brain/mcp-connections/callback`,
				)
				try {
					const result = await openPullRequestFromSandbox({
						env,
						connection,
						handle,
						client,
						sandboxId: session.sandboxId,
						cwd: session.defaultCwd,
						owner,
						repo,
						baseBranch: base_branch,
						branch,
						title,
						body,
						paths,
					})
					if (!result.ok) return { isError: true, error: result.error }
					// The change is in GitHub now, so the working copy of it does
					// not need to survive the next cold start.
					clearSandboxEdits(agent, sessionKey)
					console.log(
						`[company-brain][${traceId}] sandbox_open_pull_request repo=${owner}/${repo} branch=${result.branch} files=${result.files.length} url=${result.url}`,
					)
					return {
						...result,
						note: "This is a draft pull request. Nothing is merged and nothing is deployed until a human reviews it.",
					}
				} finally {
					await handle.close().catch(() => {})
				}
			} catch (error) {
				return toolError(error)
			}
		},
	})

	return {
		sandbox_start,
		sandbox_run,
		sandbox_list_files,
		sandbox_read_file,
		sandbox_get_artifact,
		sandbox_write_file,
		sandbox_search,
		sandbox_diff,
		sandbox_open_pull_request,
	}
}
