import { describe, expect, it } from "vitest"
import {
	commandFamily,
	repoSlugFromUrl,
	sandboxToolProperties,
	toolCallProperties,
	toolCategory,
	toolTextPreviews,
} from "./tool-telemetry"

describe("toolCategory", () => {
	it("groups the sandbox surface together", () => {
		expect(toolCategory("sandbox_start")).toBe("sandbox")
		expect(toolCategory("sandbox_open_pull_request")).toBe("sandbox")
	})

	it("separates code mode, MCP, web, memory and skills", () => {
		expect(toolCategory("run_app_code")).toBe("code_mode")
		expect(toolCategory("mcp_linear")).toBe("mcp")
		expect(toolCategory("search_web")).toBe("web")
		expect(toolCategory("save_memory")).toBe("memory")
		expect(toolCategory("load_skill")).toBe("skills")
		expect(toolCategory("import_skills")).toBe("skills")
		expect(toolCategory("finish_turn")).toBe("slack")
		expect(toolCategory("something_new")).toBe("other")
	})
})

describe("repoSlugFromUrl", () => {
	it("reads owner/name from a clone URL, including a credentialed one", () => {
		expect(repoSlugFromUrl("https://github.com/Arxivolt/arxivolt-engine")).toBe(
			"Arxivolt/arxivolt-engine",
		)
		expect(
			repoSlugFromUrl(
				"https://x-access-token:ghp_secrettoken@github.com/Arxivolt/arxivolt-engine.git",
			),
		).toBe("Arxivolt/arxivolt-engine")
	})

	it("accepts a bare slug and rejects nonsense", () => {
		expect(repoSlugFromUrl("owner/repo")).toBe("owner/repo")
		expect(repoSlugFromUrl("not a repo")).toBeUndefined()
		expect(repoSlugFromUrl(undefined)).toBeUndefined()
	})
})

describe("commandFamily", () => {
	it("keeps the executable, never the arguments", () => {
		expect(commandFamily("npm test -- --token ghp_secret")).toBe("npm")
		expect(commandFamily("cd /workspace && python3 build.py")).toBe("cd")
		expect(commandFamily("/usr/bin/git status")).toBe("git")
	})
})

describe("sandboxToolProperties", () => {
	it("records a clone without the credential", () => {
		const props = sandboxToolProperties(
			"sandbox_start",
			{
				repoUrl:
					"https://x-access-token:ghp_secrettoken@github.com/Arxivolt/arxivolt-engine.git",
			},
			{ reused: false, replayedEdits: 2 },
		)
		expect(props).toMatchObject({
			tool_category: "sandbox",
			sandbox_action: "start",
			sandbox_repo: "Arxivolt/arxivolt-engine",
			sandbox_reused: false,
			sandbox_replayed_edits: 2,
		})
		expect(JSON.stringify(props)).not.toContain("ghp_")
	})

	it("records a run by exit code and command family, not the command", () => {
		const props = sandboxToolProperties(
			"sandbox_run",
			{ command: "npm test -- --token ghp_secret" },
			{ exitCode: 1, output: "1 failing", truncated: false },
		)
		expect(props).toMatchObject({
			sandbox_action: "run",
			sandbox_command: "npm",
			sandbox_exit_code: 1,
			sandbox_output_chars: 9,
			sandbox_truncated: false,
		})
		expect(JSON.stringify(props)).not.toContain("ghp_")
	})

	it("records a write by path and size, never the contents", () => {
		const props = sandboxToolProperties(
			"sandbox_write_file",
			{ path: "worker.js", content: "SECRET_SOURCE_CODE".repeat(1000) },
			{ bytesWritten: 18_000 },
		)
		expect(props).toMatchObject({
			sandbox_action: "write",
			sandbox_path: "worker.js",
			sandbox_bytes: 18_000,
		})
		expect(JSON.stringify(props)).not.toContain("SECRET_SOURCE_CODE")
	})

	it("records a draft PR with its repo, branch and file count", () => {
		const props = sandboxToolProperties(
			"sandbox_open_pull_request",
			{
				owner: "Arxivolt",
				repo: "arxivolt-engine",
				branch: "fix/redirects",
				base_branch: "main",
			},
			{ url: "https://github.com/Arxivolt/arxivolt-engine/pull/7", draft: true, files: ["a", "b"] },
		)
		expect(props).toMatchObject({
			sandbox_action: "open_pull_request",
			sandbox_repo: "Arxivolt/arxivolt-engine",
			sandbox_branch: "fix/redirects",
			sandbox_base_branch: "main",
			sandbox_pr_draft: true,
			sandbox_files: 2,
		})
	})
})

describe("toolTextPreviews", () => {
	it("does not echo sandbox payloads or a code-mode program", () => {
		expect(
			toolTextPreviews("sandbox_write_file", { content: "secret" }, { ok: true }),
		).toEqual({})
		expect(
			toolTextPreviews("sandbox_run", { command: "npm test -- --token x" }, { output: "source" }),
		).toEqual({})
		expect(toolTextPreviews("run_app_code", { code: "secret" }, {})).toEqual({})
	})

	it("redacts secrets in other tool payloads", () => {
		const preview = toolTextPreviews(
			"search_web",
			{ query: "token ghp_abcdefghijklmnopqrstuvwxyz" },
			undefined,
		)
		expect(preview.input).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz")
		expect(preview.input).toContain("[redacted]")
	})
})

describe("toolCallProperties", () => {
	it("merges the category, the sandbox detail and the outcome", () => {
		const props = toolCallProperties({
			toolName: "sandbox_run",
			input: { command: "git status" },
			output: { exitCode: 0, output: "" },
			success: true,
			isError: false,
			latencyMs: 420,
		})
		expect(props).toMatchObject({
			tool_name: "sandbox_run",
			tool_category: "sandbox",
			sandbox_action: "run",
			tool_success: true,
			tool_latency_ms: 420,
		})
		expect(props.tool_is_error).toBeUndefined()
	})
})
