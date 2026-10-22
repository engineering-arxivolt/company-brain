/**
 * Per-tool telemetry.
 *
 * The turn trace records how many tools ran, but not which ones or how they
 * behaved, so a sandbox that is slow, a search that returns nothing, or a PR
 * that opens from a draft branch was only visible in `wrangler tail`. These
 * helpers turn a tool call into bounded, queryable properties for PostHog's
 * `$ai_tool_call` event.
 *
 * Privacy is the constraint that shapes every case below: repo names, paths,
 * counts, exit codes and durations are fine; file contents, search patterns
 * and command arguments are not sent at all. A sandbox write of a 40KB file
 * must not become a 40KB event.
 */
import { redactedPreview } from "./log-utils"

const MAX_PREVIEW_CHARS = 800
const MAX_LABEL_CHARS = 120

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}
}

function shortString(value: unknown, max = MAX_LABEL_CHARS): string | undefined {
	if (typeof value !== "string") return undefined
	const normalized = value.replace(/\s+/g, " ").trim()
	if (!normalized) return undefined
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function arrayLength(value: unknown): number | undefined {
	return Array.isArray(value) ? value.length : undefined
}

function textLength(value: unknown): number | undefined {
	return typeof value === "string" ? value.length : undefined
}

/** `owner/repo` from any GitHub URL shape, without credentials or query noise. */
export function repoSlugFromUrl(value: unknown): string | undefined {
	const raw = shortString(value, 300)
	if (!raw) return undefined
	const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:$|[/?#\s])/.exec(raw)
	if (match?.[1] && match[2]) return `${match[1]}/${match[2]}`
	return /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw : undefined
}

/**
 * The command family, not the command.
 *
 * A shell command can carry a path, a token or a customer name; its first word
 * (`git`, `npm`, `grep`, `python3`) is what answers "what is the sandbox being
 * used for?" without answering "what is in it?".
 */
export function commandFamily(value: unknown): string | undefined {
	const raw = shortString(value, 300)
	if (!raw) return undefined
	const first = raw.split(/[\s;|&]+/).find(Boolean)
	if (!first) return undefined
	const cleaned = first.replace(/^.*\//, "").replace(/[^\w.+-]/g, "")
	return cleaned ? cleaned.slice(0, 40) : undefined
}

export type ToolCategory =
	| "sandbox"
	| "code_mode"
	| "mcp"
	| "web"
	| "memory"
	| "skills"
	| "content"
	| "automation"
	| "slack"
	| "other"

const WEB_TOOLS = new Set([
	"search_web",
	"web_extract",
	"browse_website",
	"create_web_monitor",
	"search_gifs",
])

const MEMORY_TOOLS = new Set([
	"search_company_brain",
	"save_memory",
	"forget_memories",
	"resolve_entity",
	"list_memory_tags",
])

const SKILL_TOOLS = new Set(["load_skill", "save_skill", "import_skills"])

const SLACK_TOOLS = new Set([
	"post_update",
	"finish_turn",
	"search_messages",
	"lookup_user",
	"list_channels",
	"upload_file",
])

export function toolCategory(toolName: string): ToolCategory {
	if (toolName.startsWith("sandbox_")) return "sandbox"
	if (toolName === "run_app_code" || toolName === "mcp_execute_tool") {
		return "code_mode"
	}
	if (toolName.startsWith("mcp_") || toolName === "discover_app_methods") {
		return "mcp"
	}
	if (WEB_TOOLS.has(toolName)) return "web"
	if (MEMORY_TOOLS.has(toolName)) return "memory"
	if (SKILL_TOOLS.has(toolName)) return "skills"
	if (toolName === "content_studio") return "content"
	if (toolName.startsWith("create_automation") || toolName === "run_automation_now") {
		return "automation"
	}
	if (SLACK_TOOLS.has(toolName)) return "slack"
	return "other"
}

/**
 * The properties worth keeping for a sandbox call.
 *
 * Every sandbox tool gets `sandbox_action`, so the whole surface can be
 * counted and charted as one thing, and then the one or two numbers that say
 * whether the call did useful work.
 */
export function sandboxToolProperties(
	toolName: string,
	input: unknown,
	output: unknown,
): Record<string, unknown> {
	const i = asRecord(input)
	const o = asRecord(output)
	const base: Record<string, unknown> = { tool_category: "sandbox" }
	switch (toolName) {
		case "sandbox_start": {
			return {
				...base,
				sandbox_action: "start",
				sandbox_repo: repoSlugFromUrl(i.repoUrl),
				sandbox_reused: o.reused === true,
				sandbox_replayed_edits: finiteNumber(o.replayedEdits) ?? 0,
			}
		}
		case "sandbox_run": {
			return {
				...base,
				sandbox_action: "run",
				sandbox_command: commandFamily(i.command),
				sandbox_exit_code: finiteNumber(o.exitCode),
				sandbox_output_chars: textLength(o.output),
				sandbox_truncated: o.truncated === true,
			}
		}
		case "sandbox_search": {
			return {
				...base,
				sandbox_action: "search",
				sandbox_matches: arrayLength(o.matches),
				sandbox_truncated: o.truncated === true,
				sandbox_glob: shortString(i.glob),
			}
		}
		case "sandbox_write_file": {
			return {
				...base,
				sandbox_action: "write",
				sandbox_path: shortString(i.path, 200),
				sandbox_bytes:
					finiteNumber(o.bytes) ?? textLength(i.content),
			}
		}
		case "sandbox_diff": {
			return {
				...base,
				sandbox_action: "diff",
				sandbox_changed_files: arrayLength(o.changedFiles),
				sandbox_diff_chars: textLength(o.diff),
				sandbox_truncated: o.truncated === true,
			}
		}
		case "sandbox_open_pull_request": {
			const owner = shortString(i.owner, 80)
			const repo = shortString(i.repo, 80)
			return {
				...base,
				sandbox_action: "open_pull_request",
				sandbox_repo: owner && repo ? `${owner}/${repo}` : repoSlugFromUrl(i.repo),
				sandbox_branch: shortString(i.branch),
				sandbox_base_branch: shortString(i.base_branch ?? i.baseBranch),
				sandbox_files: arrayLength(o.files),
				sandbox_pr_draft: o.draft === true,
				sandbox_pr_url: shortString(o.url, 200),
			}
		}
		case "sandbox_read_file": {
			return {
				...base,
				sandbox_action: "read",
				sandbox_path: shortString(i.path, 200),
				sandbox_output_chars: textLength(o.content),
				sandbox_truncated: o.truncated === true,
			}
		}
		case "sandbox_list_files": {
			return {
				...base,
				sandbox_action: "list",
				sandbox_path: shortString(i.path, 200),
				sandbox_files: arrayLength(o.files),
			}
		}
		case "sandbox_get_artifact": {
			return {
				...base,
				sandbox_action: "artifact",
				sandbox_path: shortString(i.path, 200),
				sandbox_bytes: finiteNumber(o.sizeBytes),
			}
		}
		default:
			return { ...base, sandbox_action: toolName.replace(/^sandbox_/, "") }
	}
}

/** Code Mode properties: size and outcome, never the program itself. */
export function codeModeToolProperties(
	toolName: string,
	input: unknown,
	output: unknown,
): Record<string, unknown> {
	const i = asRecord(input)
	const o = asRecord(output)
	if (toolName === "run_app_code") {
		return {
			tool_category: "code_mode",
			code_mode_action: "run_app_code",
			code_mode_source_chars: textLength(i.code ?? i.source ?? i.program),
			code_mode_output_chars: textLength(o.result ?? o.output),
		}
	}
	if (toolName === "discover_app_methods") {
		return {
			tool_category: "mcp",
			mcp_action: "discover",
			mcp_apps: arrayLength(asRecord(output).apps),
		}
	}
	return {
		tool_category: "code_mode",
		code_mode_action: toolName,
	}
}

/**
 * What the model sent and got, bounded and redacted.
 *
 * Sandbox writes and reads are deliberately blank: the structured properties
 * already describe the call, and echoing a file body into an analytics event
 * is how customer code ends up in a product-analytics project.
 */
export function toolTextPreviews(
	toolName: string,
	input: unknown,
	output: unknown,
): { input?: string; output?: string } {
	// Every sandbox tool: inputs carry commands and file bodies, outputs carry
	// repository source. The structured properties already say what happened.
	if (toolName.startsWith("sandbox_") || toolName === "run_app_code") {
		return {}
	}
	return {
		input: redactedPreview(input, MAX_PREVIEW_CHARS),
		output: redactedPreview(output, MAX_PREVIEW_CHARS),
	}
}

/** Everything that is not category-specific. */
export function toolCallProperties(args: {
	toolName: string
	input?: unknown
	output?: unknown
	success: boolean
	isError: boolean
	latencyMs?: number
	errorKinds?: readonly string[]
}): Record<string, unknown> {
	const category = toolCategory(args.toolName)
	const specific =
		category === "sandbox"
			? sandboxToolProperties(args.toolName, args.input, args.output)
			: category === "code_mode" || args.toolName === "discover_app_methods"
				? codeModeToolProperties(args.toolName, args.input, args.output)
				: { tool_category: category }
	return {
		...specific,
		tool_name: args.toolName,
		tool_category: category,
		tool_success: args.success,
		...(args.latencyMs !== undefined
			? { tool_latency_ms: args.latencyMs }
			: {}),
		...(args.errorKinds?.length
			? { tool_error_kinds: args.errorKinds.join(",") }
			: {}),
		...(args.isError ? { tool_is_error: true } : {}),
	}
}
