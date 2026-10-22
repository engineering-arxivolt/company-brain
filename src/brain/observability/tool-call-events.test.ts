import { beforeEach, describe, expect, it, vi } from "vitest"

type Captured = { event: string; args: Record<string, unknown> }

const captured: Captured[] = []

vi.mock("@/lib/posthog", () => {
	const record =
		(event: string) =>
		(args: Record<string, unknown>): void => {
			captured.push({ event, args })
		}
	return {
		captureAiToolCall: record("$ai_tool_call"),
		captureAiSpan: record("$ai_span"),
		captureAiGeneration: record("$ai_generation"),
		captureAiTrace: record("$ai_trace"),
		captureAiDecision: record("$ai_decision"),
		captureAiGenerationAwaitable: async () => {},
		captureAiSpanAwaitable: async () => {},
		captureAiDecisionAwaitable: async () => {},
		captureAiToolCallAwaitable: async () => {},
		flushTelemetry: async () => {},
	}
})

import { createBrainTurnTelemetry } from "./index"

describe("per-tool $ai_tool_call", () => {
	beforeEach(() => {
		captured.length = 0
	})

	it("emits one event per tool call, nested under the turn span", () => {
		const telemetry = createBrainTurnTelemetry("org-1", "user-1", {
			traceId: "trace-1",
			sessionId: "session-1",
		})
		telemetry.onToolCallStart("call-1")
		telemetry.onToolCallFinish({
			toolCallId: "call-1",
			toolName: "sandbox_run",
			success: true,
			input: { command: "npm test -- --token ghp_secret" },
			output: { exitCode: 0, output: "ok" },
		})

		const event = captured.find((entry) => entry.event === "$ai_tool_call")
		expect(event).toBeDefined()
		expect(event?.args).toMatchObject({
			traceId: "trace-1",
			sessionId: "session-1",
			spanId: "call-1",
			parentId: telemetry.turnSpanId,
			toolName: "sandbox_run",
			groups: { company: "org-1" },
		})
		expect(event?.args.properties).toMatchObject({
			orgId: "org-1",
			tool_name: "sandbox_run",
			tool_category: "sandbox",
			sandbox_action: "run",
			sandbox_command: "npm",
			sandbox_exit_code: 0,
			tool_success: true,
		})
		expect(JSON.stringify(event?.args)).not.toContain("ghp_secret")
	})

	it("marks a failed call and keeps the error kind", () => {
		const telemetry = createBrainTurnTelemetry("org-1", "user-1")
		telemetry.onToolCallStart("call-2")
		telemetry.onToolCallFinish({
			toolCallId: "call-2",
			toolName: "sandbox_read_file",
			success: false,
			input: { path: "/workspace/x" },
			output: { status: "error", kind: "sandbox_error" },
		})
		const event = captured.find((entry) => entry.event === "$ai_tool_call")
		expect(event?.args.isError).toBe(true)
		expect(event?.args.properties).toMatchObject({
			tool_category: "sandbox",
			sandbox_action: "read",
			tool_error_kinds: "sandbox_error",
			tool_is_error: true,
		})
	})

	it("still emits for MCP apps and code mode", () => {
		const telemetry = createBrainTurnTelemetry("org-1", "user-1")
		telemetry.onToolCallStart("call-3")
		telemetry.onToolCallFinish({
			toolCallId: "call-3",
			toolName: "mcp_linear",
			success: true,
			input: { action: "list" },
			output: { ok: true },
		})
		telemetry.onToolCallStart("call-4")
		telemetry.onToolCallFinish({
			toolCallId: "call-4",
			toolName: "run_app_code",
			success: true,
			input: { code: "return 1" },
			output: { result: 1 },
		})
		const events = captured.filter((entry) => entry.event === "$ai_tool_call")
		expect(events.map((entry) => (entry.args.properties as any).tool_category)).toEqual([
			"mcp",
			"code_mode",
		])
		// The program source is never sent.
		expect(JSON.stringify(events.at(-1)?.args)).not.toContain("return 1")
	})
})
