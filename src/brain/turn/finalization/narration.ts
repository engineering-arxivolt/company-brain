import type { ModelMessage } from "ai"

export const NARRATION_RETRY_INSTRUCTION = [
	"<narration_only_retry>",
	"Your last response only stated an intention; it did not answer the request.",
	"Do the work now with the available tools instead of narrating what you will do.",
	"Then call finish_turn exactly once with the complete answer. If a concrete dependency prevents completion, call finish_turn with an honest account of what was done and what remains blocked.",
	"</narration_only_retry>",
].join("\n")

type NarrationCandidate = {
	reply: string
	narrationOnly?: boolean
}

export type NarrationOnlyResolution<Candidate extends NarrationCandidate> =
	| { action: "retry"; messages: ModelMessage[] }
	| { action: "publish"; candidate: Candidate }

export function honestNarrationOnlyStatus(completedToolSteps: number): string {
	const steps = Math.max(0, Math.floor(completedToolSteps))
	const done = steps
		? `I completed ${steps} tool step${steps === 1 ? "" : "s"} before the turn stalled.`
		: "No tool work was completed before the turn stalled."
	return `${done} The requested work is still unfinished, and I don't have a complete answer to deliver.`
}

/**
 * Converts a narration-only candidate into either one tool-enabled retry or a
 * truthful terminal status. The caller owns model execution and approval
 * handling; this function owns the bounded stop-path contract.
 */
export async function resolveNarrationOnlyOutput<
	Candidate extends NarrationCandidate,
>(args: {
	candidate: Candidate
	hasTerminalProposal: boolean
	stepsRemaining: number
	retryUsed: boolean
	pauseRequested: boolean
	completedToolSteps: number
	messages: ModelMessage[]
	responseMessages: () => Promise<ModelMessage[]>
	compactMessages: (messages: ModelMessage[]) => ModelMessage[]
}): Promise<NarrationOnlyResolution<Candidate>> {
	const { candidate } = args
	if (!candidate.narrationOnly) {
		return { action: "publish", candidate }
	}
	if (
		!args.hasTerminalProposal &&
		!args.retryUsed &&
		args.stepsRemaining > 0 &&
		!args.pauseRequested
	) {
		const responseMessages = await args.responseMessages()
		return {
			action: "retry",
			messages: [
				...args.compactMessages([...args.messages, ...responseMessages]),
				{ role: "user", content: NARRATION_RETRY_INSTRUCTION },
			],
		}
	}
	return {
		action: "publish",
		candidate: {
			...candidate,
			reply: honestNarrationOnlyStatus(args.completedToolSteps),
		},
	}
}
