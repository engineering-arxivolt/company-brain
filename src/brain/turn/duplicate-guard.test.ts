import { describe, expect, it } from "vitest"
import type { ToolSet } from "ai"
import { guardDuplicateToolCalls, toolCallKey } from "./duplicate-guard"
import { createTurnState } from "./state"

function tool(execute: (input: unknown) => unknown) {
	return { description: "test tool", execute } as unknown as ToolSet[string]
}

function state() {
	return createTurnState({ request: { text: "q", threadKey: "T:C:1" } })
}

/** The wrapped execute the model would call. */
function executeOf(tools: ToolSet, name: string) {
	const definition = (tools as Record<string, { execute?: unknown }>)[name]
	if (!definition || typeof definition.execute !== "function") {
		throw new Error(`missing tool ${name}`)
	}
	return definition.execute as (input: unknown) => Promise<unknown>
}

describe("toolCallKey", () => {
	it("ignores argument key order", () => {
		expect(toolCallKey("search_web", { q: "a", freshness: "last_week" })).toBe(
			toolCallKey("search_web", { freshness: "last_week", q: "a" }),
		)
	})

	it("separates different arguments and different tools", () => {
		expect(toolCallKey("search_web", { q: "a" })).not.toBe(
			toolCallKey("search_web", { q: "b" }),
		)
		expect(toolCallKey("search_web", { q: "a" })).not.toBe(
			toolCallKey("web_extract", { q: "a" }),
		)
	})
})

describe("guardDuplicateToolCalls", () => {
	it("runs a read once and answers the identical repeat from the transcript", async () => {
		let runs = 0
		const tools: ToolSet = {
			search_company_brain: tool((input) => {
				runs += 1
				return { hits: 1, echoed: input }
			}),
		}
		guardDuplicateToolCalls(tools, { traceId: "t1" })
		const execute = executeOf(tools, "search_company_brain")

		const first = await execute({ query: "my base CV" })
		const second = await execute({ query: "my base CV" })

		expect(runs).toBe(1)
		expect(first).toEqual({ hits: 1, echoed: { query: "my base CV" } })
		expect(second).toMatchObject({ duplicate: true, tool: "search_company_brain" })
	})

	it("lets the same tool run with different arguments", async () => {
		let runs = 0
		const tools: ToolSet = {
			search_web: tool(() => {
				runs += 1
				return { ok: true }
			}),
		}
		guardDuplicateToolCalls(tools, { traceId: "t1" })
		const execute = executeOf(tools, "search_web")

		await execute({ query: "a" })
		await execute({ query: "b" })
		expect(runs).toBe(2)
	})

	it("re-runs a read once something may have changed the world", async () => {
		let reads = 0
		const tools: ToolSet = {
			sandbox_read_file: tool(() => {
				reads += 1
				return { content: `v${reads}` }
			}),
			sandbox_write_file: tool(() => ({ written: true })),
		}
		guardDuplicateToolCalls(tools, { traceId: "t1" })
		const read = executeOf(tools, "sandbox_read_file")
		const write = executeOf(tools, "sandbox_write_file")

		await read({ path: "cv.tex" })
		await write({ path: "cv.tex", content: "new" })
		const afterWrite = await read({ path: "cv.tex" })

		expect(reads).toBe(2)
		expect(afterWrite).toEqual({ content: "v2" })
	})

	it("never blocks a tool that is not a known read", async () => {
		let runs = 0
		const tools: ToolSet = {
			schedule_reminder: tool(() => {
				runs += 1
				return { scheduled: true }
			}),
		}
		guardDuplicateToolCalls(tools, { traceId: "t1" })
		const execute = executeOf(tools, "schedule_reminder")

		await execute({ at: "tomorrow" })
		await execute({ at: "tomorrow" })
		expect(runs).toBe(2)
	})

	it("nudges a looping turn to ask or answer", async () => {
		const turnState = state()
		const blocked: string[] = []
		const tools: ToolSet = {
			recall_tagged_memories: tool(() => ({ found: false })),
		}
		guardDuplicateToolCalls(tools, {
			traceId: "t1",
			turnState,
			onBlocked: (info) => blocked.push(`${info.tool}:${info.count}`),
		})
		const execute = executeOf(tools, "recall_tagged_memories")

		await execute({ query: "Joseph Mindo" })
		await execute({ query: "Joseph Mindo" })
		expect(turnState.warnings.some((w) => w.startsWith("Loop:"))).toBe(false)
		await execute({ query: "Joseph Mindo" })

		expect(blocked).toEqual([
			"recall_tagged_memories:1",
			"recall_tagged_memories:2",
		])
		expect(turnState.warnings.some((w) => w.startsWith("Loop:"))).toBe(true)
	})
})
