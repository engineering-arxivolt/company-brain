import type { ToolSet } from "ai"
import { addTurnWarning, type TurnState } from "./state"

type AnyExecute = (input: unknown, callOptions: unknown) => unknown

/**
 * Tools that only read.
 *
 * An identical call to one of these, inside one turn and with no state-changing
 * call in between, cannot return anything the turn does not already have. That
 * makes the repeat pure waste — and on a weak model, a loop: a real turn spent
 * most of its steps asking memory the same question three times because the
 * answer was not there.
 *
 * Paged readers are deliberately absent: read_current_thread and the Slack
 * search tools return a *different* batch for the same arguments.
 */
const READ_ONLY_TOOLS = new Set<string>([
	"search_company_brain",
	"recall_tagged_memories",
	"outline_memory_tree",
	"read_memory_node",
	"list_memory_tags",
	"resolve_entity",
	"inspect_people_directory",
	"get_configuration",
	"discover_app_methods",
	"search_web",
	"web_extract",
	"browse_website",
	"sandbox_read_file",
	"sandbox_list_files",
	"sandbox_search",
])

/** Two blocked repeats mean the model is looping, not searching. */
const LOOP_WARNING_AFTER = 2

function sortedValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedValue)
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>
		const sorted: Record<string, unknown> = {}
		for (const key of Object.keys(record).sort()) {
			sorted[key] = sortedValue(record[key])
		}
		return sorted
	}
	return value
}

/** Argument identity that does not depend on key order. */
export function toolCallKey(name: string, input: unknown): string {
	try {
		return `${name}:${JSON.stringify(sortedValue(input))}`
	} catch {
		return `${name}:${String(input)}`
	}
}

export type DuplicateGuardOptions = {
	traceId: string
	turnState?: TurnState
	/** Fires for each blocked repeat, so a loop shows up in the logs and metrics. */
	onBlocked?: (info: { tool: string; count: number }) => void
}

/**
 * Stops a turn from re-running the same read with the same arguments.
 *
 * The second identical read returns a note instead of a result: the answer is
 * already in the transcript, so the model should use it, ask the asker for what
 * is genuinely missing, or answer. Any call that is not a known read clears the
 * cache first — a file read after a write has to see the new bytes.
 */
export function guardDuplicateToolCalls(
	tools: ToolSet,
	options: DuplicateGuardOptions,
): ToolSet {
	const seen = new Set<string>()
	let blocked = 0
	const records = tools as unknown as Record<string, Record<string, unknown>>

	for (const [name, definition] of Object.entries(records)) {
		const original = definition?.execute
		if (typeof original !== "function") continue
		records[name] = {
			...definition,
			execute: async (input: unknown, callOptions: unknown) => {
				const execute = original as AnyExecute
				if (!READ_ONLY_TOOLS.has(name)) {
					// Anything else may have changed the world, so a cached
					// read could now be stale.
					seen.clear()
					return await execute(input, callOptions)
				}
				const key = toolCallKey(name, input)
				if (!seen.has(key)) {
					seen.add(key)
					return await execute(input, callOptions)
				}
				blocked += 1
				console.log(
					`[company-brain][${options.traceId}] duplicate tool call blocked name=${name} repeats=${blocked}`,
				)
				options.onBlocked?.({ tool: name, count: blocked })
				if (blocked >= LOOP_WARNING_AFTER && options.turnState) {
					addTurnWarning(
						options.turnState,
						`Loop: ${blocked} repeated tool calls were blocked this turn, and each result is already above. Re-running them returns nothing new. Ask the asker for whatever is genuinely missing, or finish_turn with what you have.`,
					)
				}
				return {
					duplicate: true,
					tool: name,
					note: "You already called this tool with these exact arguments in this turn; its result is above and will not be returned again. Use that result. If something is genuinely missing, ask the asker for it or answer with what you have.",
				}
			},
		}
	}

	return tools
}
