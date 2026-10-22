import { getSandbox } from "@cloudflare/sandbox"
import {
	boundedArtifactStream,
	type SandboxClient,
	type SandboxFileInfo,
} from "./client"
import {
	normalizeCwd,
	normalizePath,
	normalizeSearchLimit,
	normalizeTimeout,
	safeRepoDir,
	sandboxLimits,
	shellQuote,
	truncateText,
	validateCommand,
	validateRepoUrl,
} from "./guards"

// Sandboxes sleep after this long idle. A sleeping container loses its
// filesystem, which the marker file below detects.
//
// The sleep window is a billing decision as much as a lifecycle one: a
// container that stays hot is billed the whole time, and a turn that used the
// sandbox once in the morning was still paying for it half an hour later.
// Five minutes is long enough to finish the work in one session and short
// enough that an abandoned container goes cold quickly.
const SLEEP_AFTER = "5m"

// Written when a sandbox is set up. A container that woke from sleep starts
// from the image again and won't have it, so the session gets recreated.
const READY_MARKER = "/workspace/.company-brain-ready"

// What a caller sees when the container restarted underneath it. The old
// failure was a bare "No such file or directory" for a file the model had
// just created, which reads as a bug in the command rather than a container
// that had gone to sleep.
const WORKSPACE_RESET_MESSAGE =
	"The sandbox restarted while it was idle, so its workspace is empty again. " +
	"Call sandbox_start to set it up once more, then redo the work that was lost."

// Tool paths are relative to the sandbox root, as they were on Daytona, where
// the default working directory is "workspace".
function absolute(path: string): string {
	return path.startsWith("/") ? path : `/${path}`
}

function sandboxFor(env: Env, sandboxId: string) {
	if (!env.Sandbox) throw new Error("The Sandbox binding is not configured.")
	return getSandbox(env.Sandbox, sandboxId, { sleepAfter: SLEEP_AFTER })
}

/**
 * True when the container still holds the workspace it was set up with.
 *
 * A container that slept came back from the image without the marker file,
 * which means the clone, the generated files and everything else in the
 * workspace is gone. Detecting that before running a command turns a baffling
 * "file not found" into the truth.
 */
async function workspaceIsIntact(
	env: Env,
	sandboxId: string,
): Promise<boolean> {
	try {
		const result = await sandboxFor(env, sandboxId).exists(READY_MARKER)
		return result.exists
	} catch {
		// The container could not be reached at all; that is a different
		// failure and the caller's own error handling reports it better.
		return true
	}
}

export function createCloudflareSandboxClient(env: Env): SandboxClient {
	const client: SandboxClient = {
		async isSandboxRunning(sandboxId) {
			try {
				const result = await sandboxFor(env, sandboxId).exists(READY_MARKER)
				return result.exists
			} catch {
				return false
			}
		},

		async createSandbox(args) {
			const repo = args.repoUrl ? validateRepoUrl(args.repoUrl) : null
			if (repo && !repo.ok) throw new Error(repo.error)

			// Lowercase: sandbox ids double as preview hostnames.
			const sandboxId = `brain-${crypto.randomUUID()}`
			const sandbox = sandboxFor(env, sandboxId)
			await sandbox.exec(
				`mkdir -p /workspace && touch ${shellQuote(READY_MARKER)}`,
			)
			if (!repo) return { sandboxId, defaultCwd: "workspace" }

			const defaultCwd = safeRepoDir(repo.url)
			const clone = await client.runCommand({
				sandboxId,
				command: `git clone --depth 1 -- ${shellQuote(repo.url)} ${shellQuote(absolute(defaultCwd))}`,
				cwd: "workspace",
				timeoutSec: 120,
			})
			return {
				sandboxId,
				defaultCwd,
				repoUrl: repo.url,
				cloneOutput: clone.output,
			}
		},

		async runCommand(args) {
			const timeoutSec = normalizeTimeout(args.timeoutSec)
			const command = validateCommand(args.command)
			if (!command.ok) {
				return {
					exitCode: 126,
					output: command.error,
					truncated: false,
					cwd: args.cwd,
					timeoutSec,
				}
			}
			if (!(await workspaceIsIntact(env, args.sandboxId))) {
				return {
					exitCode: 125,
					output: WORKSPACE_RESET_MESSAGE,
					truncated: false,
					cwd: args.cwd,
					timeoutSec,
				}
			}
			const cwd = normalizeCwd(args.cwd, "workspace")
			// cd inside the command so a missing directory is an ordinary error.
			const result = await sandboxFor(env, args.sandboxId).exec(
				`cd ${shellQuote(absolute(cwd))} && ${command.command}`,
				{ timeout: timeoutSec * 1000 },
			)
			const combined = [result.stdout, result.stderr]
				.filter((part) => part.length > 0)
				.join("\n")
			const truncated = truncateText(combined)
			return {
				exitCode: result.exitCode,
				output: truncated.text,
				truncated: truncated.truncated,
				cwd,
				timeoutSec,
			}
		},

		async listFiles(args) {
			const sandbox = sandboxFor(env, args.sandboxId)
			if (!(await workspaceIsIntact(env, args.sandboxId))) {
				return { files: [], path: args.path, workspaceReset: true }
			}
			const path = normalizePath(args.path, "workspace")
			const glob = args.glob?.trim()
			if (glob) {
				const found = await sandbox.exec(
					`find ${shellQuote(absolute(path))} -name ${shellQuote(glob)} -not -path '*/.git/*' 2>/dev/null | head -200`,
				)
				return {
					files: found.stdout.split("\n").filter(Boolean),
					path,
					glob,
				}
			}
			const listed = await sandbox.listFiles(absolute(path))
			const files: SandboxFileInfo[] = listed.files
				.slice(0, 200)
				.map((file) => ({
					name: file.name,
					isDir: file.type === "directory",
					size: file.size,
					modTime: file.modifiedAt,
				}))
			return { files, path }
		},

		async readTextFile(args) {
			const path = normalizePath(args.path, "workspace")
			if (!(await workspaceIsIntact(env, args.sandboxId))) {
				throw new Error(WORKSPACE_RESET_MESSAGE)
			}
			const file = await sandboxFor(env, args.sandboxId).readFile(
				absolute(path),
			)
			const text =
				file.encoding === "base64"
					? new TextDecoder().decode(
							Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)),
						)
					: file.content
			const truncated = truncateText(text, sandboxLimits.maxTextFileChars)
			return { path, content: truncated.text, truncated: truncated.truncated }
		},

		async writeFile(args) {
			const path = normalizePath(args.path, "workspace")
			if (!(await workspaceIsIntact(env, args.sandboxId))) {
				throw new Error(WORKSPACE_RESET_MESSAGE)
			}
			const sandbox = sandboxFor(env, args.sandboxId)
			const parent = absolute(path).split("/").slice(0, -1).join("/")
			if (parent && parent !== "") {
				await sandbox.mkdir(parent, { recursive: true }).catch(() => {})
			}
			await sandbox.writeFile(absolute(path), args.content)
			return { path, bytes: args.content.length }
		},

		async search(args) {
			const query = args.query.trim()
			const root = absolute(normalizePath(args.path, "workspace"))
			const limit = normalizeSearchLimit(args.limit)
			// grep is given the pattern as an argument, quoted, so nothing in it
			// is read as shell syntax. -n prints line numbers, -I skips binaries.
			const glob = args.glob?.trim()
			const globArg = glob ? `--include=${shellQuote(glob)}` : ""
			const result = await sandboxFor(env, args.sandboxId).exec(
				`grep -rInI ${globArg} -e ${shellQuote(query)} ${shellQuote(root)} 2>/dev/null | head -n ${limit + 1}`,
				{ timeout: 30_000 },
			)
			const lines = result.stdout.split("\n").filter(Boolean)
			const truncated = lines.length > limit
			const matches = lines.slice(0, limit).map((line) => {
				// grep prints path:line:text, and the path may contain colons.
				const match = line.match(/^(.*?):(\d+):(.*)$/)
				return {
					file: match?.[1] ?? line,
					line: match?.[2] ? Number(match[2]) : 0,
					text: (match?.[3] ?? "").slice(0, 400),
				}
			})
			return { matches, truncated }
		},

		async diff(args) {
			const cwd = absolute(normalizeCwd(args.cwd, "workspace"))
			const sandbox = sandboxFor(env, args.sandboxId)
			const status = await sandbox.exec(
				`cd ${shellQuote(cwd)} && git status --porcelain 2>/dev/null | head -n 200`,
				{ timeout: 20_000 },
			)
			const changedFiles = status.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => line.slice(3).trim())
				.filter(Boolean)
			if (!changedFiles.length) {
				return { status: status.stdout.trim(), diff: "", changedFiles, truncated: false }
			}
			const diff = await sandbox.exec(
				`cd ${shellQuote(cwd)} && git diff --no-color 2>/dev/null | head -c ${sandboxLimits.maxDiffChars}`,
				{ timeout: 30_000 },
			)
			const truncated = diff.stdout.length >= sandboxLimits.maxDiffChars
			return {
				status: status.stdout.trim(),
				diff: diff.stdout,
				changedFiles,
				truncated,
			}
		},

		async getArtifact(args) {
			const out = await client.getArtifactStream(args)
			const content = await new Response(out.content).arrayBuffer()
			return {
				path: out.path,
				sizeBytes: content.byteLength,
				content,
				truncated: false,
			}
		},

		async getArtifactStream(args) {
			args.signal?.throwIfAborted()
			const path = normalizePath(args.path, "workspace")
			if (!(await workspaceIsIntact(env, args.sandboxId))) {
				throw new Error(WORKSPACE_RESET_MESSAGE)
			}
			const file = await sandboxFor(env, args.sandboxId).readFile(
				absolute(path),
				{ encoding: "none" },
			)
			if (!Number.isSafeInteger(file.size) || file.size <= 0) {
				await file.content.cancel()
				throw new Error("Artifact has an invalid size.")
			}
			if (file.size > sandboxLimits.maxArtifactBytes) {
				await file.content.cancel()
				throw new Error("Artifact is too large.", {
					cause: `${file.size} bytes, max ${sandboxLimits.maxArtifactBytes}`,
				})
			}
			return {
				path,
				sizeBytes: file.size,
				content: boundedArtifactStream(file.content, file.size),
			}
		},
	}
	return client
}
