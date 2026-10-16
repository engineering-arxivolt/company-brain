import type { TurnDeps } from "./deps"

export const FINISH_TURN_TOOL_NAME = "finish_turn"

export const TURN_TERMINAL_OUTCOMES = [
	"answered",
	"blocked",
	"nothing_found",
] as const

export type TurnTerminalOutcome = (typeof TURN_TERMINAL_OUTCOMES)[number]

export type TurnTerminalProposal = {
	outcome: TurnTerminalOutcome
	reply: string
	/**
	 * Personality expression, validated at delivery (allowlist + outcome gate)
	 * and dropped silently when unset or invalid.
	 */
	reaction?: string
	/** Candidate id from this turn's search_gifs results; resolved server-side. */
	gifId?: string
}

type TerminalToolCall = {
	toolCallId: string
	toolName: string
	input?: unknown
}

export type TurnTerminalCapture = {
	record(toolCall: TerminalToolCall): TurnTerminalProposal | undefined
	requested(): boolean
	selected(): TurnTerminalProposal | undefined
	count(): number
}

function parseTerminalProposal(
	input: unknown,
): TurnTerminalProposal | undefined {
	if (!input || typeof input !== "object") return undefined
	const value = input as {
		outcome?: unknown
		reply?: unknown
		reaction?: unknown
		gif_id?: unknown
	}
	if (
		typeof value.outcome !== "string" ||
		!TURN_TERMINAL_OUTCOMES.includes(value.outcome as TurnTerminalOutcome) ||
		typeof value.reply !== "string" ||
		!value.reply.trim()
	) {
		return undefined
	}
	const proposal: TurnTerminalProposal = {
		outcome: value.outcome as TurnTerminalOutcome,
		reply: value.reply.trim(),
	}
	// Kept permissive here so a bad flourish never fails the answer; delivery
	// re-validates and drops unknown values.
	if (typeof value.reaction === "string" && value.reaction.trim()) {
		proposal.reaction = value.reaction.trim().toLowerCase().replace(/:/g, "")
	}
	if (typeof value.gif_id === "string" && value.gif_id.trim()) {
		proposal.gifId = value.gif_id.trim().slice(0, 64)
	}
	return proposal
}

/**
 * Captures terminal calls when execution starts, preserving the model-emitted
 * order instead of the completion order of concurrently executed tools.
 */
export function createTurnTerminalCapture(args?: {
	onProposal?: (proposal: TurnTerminalProposal) => void
}): TurnTerminalCapture {
	let selectedProposal: TurnTerminalProposal | undefined
	let proposalCount = 0
	return {
		record(toolCall) {
			if (toolCall.toolName !== FINISH_TURN_TOOL_NAME) return undefined
			const proposal = parseTerminalProposal(toolCall.input)
			if (!proposal) return undefined
			proposalCount += 1
			selectedProposal = proposal
			args?.onProposal?.(proposal)
			return proposal
		},
		requested: () => selectedProposal !== undefined,
		selected: () => selectedProposal,
		count: () => proposalCount,
	}
}

export function createFinishTurnTool(deps: TurnDeps) {
	return deps.tool({
		description:
			"Submit the complete final reply for this turn. Call this exactly once when the user's active requests have been answered, are concretely blocked, or the requested information was not found. The reply is what the user will receive, so make it standalone and complete. Do not continue working or write another answer after calling this tool.",
		inputSchema: deps.z.object({
			outcome: deps.z
				.enum(TURN_TERMINAL_OUTCOMES)
				.describe(
					"answered when the request is fulfilled; blocked when a concrete dependency prevents completion; nothing_found when the requested search completed without finding the information.",
				),
			reply: deps.z
				.string()
				.min(1)
				.describe(
					"The complete user-facing final reply in normal Slack Markdown.",
				),
			reaction: deps.z
				.string()
				.optional()
				.describe(
					"Optional celebratory reaction on a genuine win (answered only): one of tada, fire, clap, raised_hands, rocket, heart, white_check_mark. It lands on the message you are responding to. Omit on blocked, nothing_found, errors, incidents, or formal topics.",
				),
			gif_id: deps.z
				.string()
				.optional()
				.describe(
					"Optional id of one GIF candidate returned by search_gifs this turn, attached to your final message. Only on a genuine win (answered only), at most one per turn; omit if nothing fits or the moment is not a real celebration.",
				),
		}),
		execute: async ({ outcome }) => ({ accepted: true, outcome }),
	})
}
