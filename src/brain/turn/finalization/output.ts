import type { ModelMessage } from "ai"
import {
	isPublishableSlackReply,
	sanitizeSlackReply,
	stripDraftingSelfTalk,
} from "../../observability/reply-quality"
import type { TurnTerminalProposal } from "../terminal"

export type TurnReplySource = "terminal" | "text" | "response" | "empty"

type TurnReplyResult = {
	readonly text: PromiseLike<string>
	readonly response: PromiseLike<{ messages: ModelMessage[] }>
}

function assistantDrafts(messages: ModelMessage[]): string[] {
	const drafts: string[] = []
	for (const message of messages) {
		if (message.role !== "assistant") continue
		if (typeof message.content === "string") {
			drafts.push(message.content)
			continue
		}
		for (const part of message.content) {
			if (part.type === "text") drafts.push(part.text)
		}
	}
	return drafts
}

function publishable(text: string): string {
	const reply = sanitizeSlackReply(text)
	return isPublishableSlackReply(reply) ? reply : ""
}

/** Selects reply content without invoking another model or judging semantics. */
export async function selectTurnReply(args: {
	result: TurnReplyResult
	terminalProposal?: TurnTerminalProposal
}): Promise<{ reply: string; source: TurnReplySource }> {
	/** Candidates that had text but were not publishable as written. */
	const rejected: string[] = []
	const consider = (text: string): string => {
		const reply = publishable(text)
		if (!reply && text.trim()) rejected.push(text.trim())
		return reply
	}

	if (args.terminalProposal) {
		const reply = consider(args.terminalProposal.reply)
		if (reply) return { reply, source: "terminal" }
	}

	try {
		const reply = consider(await args.result.text)
		if (reply) return { reply, source: "text" }
	} catch {
		// The response transcript below is the deterministic recovery source.
	}

	try {
		const { messages } = await args.result.response
		const reply = assistantDrafts(messages)
			.map(consider)
			.filter(Boolean)
			.sort((left, right) => right.length - left.length)[0]
		if (reply) return { reply, source: "response" }
	} catch {
		// The salvage below and the caller's empty-reply fallback own the rest.
	}

	// Last resort: a candidate rejected only for one drafting sentence still says
	// something to the asker. Strip that sentence rather than erasing the turn.
	const recovered = rejected
		.map((text) => sanitizeSlackReply(stripDraftingSelfTalk(text)))
		.filter((text) => isPublishableSlackReply(text))
		.sort((left, right) => right.length - left.length)[0]
	if (recovered) {
		console.warn(
			`[company-brain] reply recovered by stripping drafting self-talk chars=${recovered.length} rejected=${rejected.length}`,
		)
		return { reply: recovered, source: "response" }
	}
	if (rejected.length) {
		// Nothing usable, but say what was thrown away — otherwise the canned
		// apology is the only trace of it.
		const longest = [...rejected].sort((left, right) => right.length - left.length)[0] ?? ""
		console.warn(
			`[company-brain] reply empty: ${rejected.length} candidate(s) rejected, longest="${longest.slice(0, 120).replace(/\s+/g, " ")}"`,
		)
	}

	return { reply: "", source: "empty" }
}
