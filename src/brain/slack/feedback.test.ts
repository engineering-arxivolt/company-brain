import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import type { CompanyBrainAgent } from "../turn/agent"
import { isFeedbackReactionEvent, type SlackEventInner } from "./events"
import {
	BRAIN_EXPAND_REQUEST_TEXT,
	feedbackKindForReaction,
	getAnswerFeedback,
	recordAnswerFeedback,
	retractAnswerFeedback,
	shouldStartAnswerExpansion,
	type BrainAnswerFeedback,
} from "./feedback"

/** Runs the module's real SQL against a real SQLite engine, as the DO does. */
function sqliteAgent() {
	const db = new DatabaseSync(":memory:")
	const agent = {
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?")
			const statement = db.prepare(text)
			return text.trimStart().toUpperCase().startsWith("SELECT")
				? statement.all(...(values as never[]))
				: (statement.run(...(values as never[])), [])
		},
	} as unknown as CompanyBrainAgent
	return { agent, db }
}

const base: Omit<BrainAnswerFeedback, "kind" | "reaction"> = {
	channel: "C1",
	messageTs: "1792143424.343019",
	reactorUser: "U1",
	traceId: "trace_1",
	threadTs: "1792143424.343019",
	createdAt: 1_700_000_000_000,
}

function reactionEvent(
	overrides: Partial<SlackEventInner> = {},
): SlackEventInner {
	return {
		type: "reaction_added",
		reaction: "thumbsup",
		user: "U1",
		item: { type: "message", channel: "C1", ts: "1792143424.343019" },
		...overrides,
	} as SlackEventInner
}

describe("feedbackKindForReaction", () => {
	it("maps the three teammate reactions", () => {
		expect(feedbackKindForReaction("thumbsup")).toBe("positive")
		expect(feedbackKindForReaction("thumbsdown")).toBe("negative")
		expect(feedbackKindForReaction("question")).toBe("expand")
	})

	it("ignores everything else, including undefined", () => {
		expect(feedbackKindForReaction("mag")).toBeUndefined()
		expect(feedbackKindForReaction("tada")).toBeUndefined()
		expect(feedbackKindForReaction(undefined)).toBeUndefined()
	})
})

describe("isFeedbackReactionEvent", () => {
	it("accepts adds and removes of the feedback reactions", () => {
		expect(isFeedbackReactionEvent(reactionEvent())).toBe(true)
		expect(
			isFeedbackReactionEvent(
				reactionEvent({ type: "reaction_removed", reaction: "question" }),
			),
		).toBe(true)
		expect(
			isFeedbackReactionEvent(reactionEvent({ reaction: "thumbsdown" })),
		).toBe(true)
	})

	it("rejects debug/mute reactions and non-message items", () => {
		expect(
			isFeedbackReactionEvent(reactionEvent({ reaction: "mag" })),
		).toBe(false)
		expect(
			isFeedbackReactionEvent(
				reactionEvent({ reaction: "black_square_for_stop" }),
			),
		).toBe(false)
		expect(
			isFeedbackReactionEvent(
				reactionEvent({
					item: { type: "file", channel: "C1", ts: "1.2" },
				} as Partial<SlackEventInner>),
			),
		).toBe(false)
	})

	it("rejects message events", () => {
		expect(
			isFeedbackReactionEvent(reactionEvent({ type: "message" })),
		).toBe(false)
	})
})

describe("answer feedback rows against real SQLite", () => {
	it("round-trips a recorded vote", () => {
		const { agent } = sqliteAgent()
		const written = recordAnswerFeedback(agent, {
			...base,
			reaction: "thumbsup",
			kind: "positive",
		})
		expect(written).not.toBeNull()
		expect(
			getAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U1",
			}),
		).toMatchObject({
			reaction: "thumbsup",
			kind: "positive",
			traceId: "trace_1",
			threadTs: base.threadTs,
		})
	})

	it("keeps one row per reactor and lets a newer vote replace the old", () => {
		const { agent, db } = sqliteAgent()
		recordAnswerFeedback(agent, {
			...base,
			reaction: "thumbsup",
			kind: "positive",
		})
		recordAnswerFeedback(agent, {
			...base,
			reaction: "thumbsdown",
			kind: "negative",
			createdAt: base.createdAt + 1,
		})
		const rows = db
			.prepare("SELECT reaction, kind FROM brain_answer_feedback")
			.all()
		expect(rows).toEqual([{ reaction: "thumbsdown", kind: "negative" }])
	})

	it("keeps separate rows for separate reactors", () => {
		const { agent, db } = sqliteAgent()
		recordAnswerFeedback(agent, {
			...base,
			reaction: "thumbsup",
			kind: "positive",
		})
		recordAnswerFeedback(agent, {
			...base,
			reactorUser: "U2",
			reaction: "question",
			kind: "expand",
		})
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM brain_answer_feedback").get(),
		).toEqual({ n: 2 })
	})

	it("returns undefined for an unknown vote", () => {
		const { agent } = sqliteAgent()
		expect(
			getAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U9",
			}),
		).toBeUndefined()
	})

	it("retracts only when the removed emoji matches the stored vote", () => {
		const { agent } = sqliteAgent()
		recordAnswerFeedback(agent, {
			...base,
			reaction: "thumbsup",
			kind: "positive",
		})
		expect(
			retractAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U1",
				reaction: "question",
			}),
		).toBe(false)
		expect(
			getAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U1",
			}),
		).not.toBeUndefined()
		expect(
			retractAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U1",
				reaction: "thumbsup",
			}),
		).toBe(true)
		expect(
			getAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U1",
			}),
		).toBeUndefined()
	})

	it("swallows storage failures instead of throwing", () => {
		const agent = {
			sql: () => {
				throw new Error("durable storage unavailable")
			},
		} as unknown as CompanyBrainAgent
		expect(
			recordAnswerFeedback(agent, {
				...base,
				reaction: "thumbsup",
				kind: "positive",
			}),
		).toBeNull()
		expect(
			getAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U1",
			}),
		).toBeUndefined()
		expect(
			retractAnswerFeedback(agent, {
				channel: "C1",
				messageTs: base.messageTs,
				reactorUser: "U1",
				reaction: "thumbsup",
			}),
		).toBe(false)
	})
})

describe("shouldStartAnswerExpansion", () => {
	const expandVote: BrainAnswerFeedback = {
		...base,
		reaction: "question",
		kind: "expand",
	}

	it("expands on a first ❓", () => {
		expect(
			shouldStartAnswerExpansion({
				action: "added",
				kind: "expand",
				prior: undefined,
			}),
		).toBe(true)
	})

	it("expands again after the reaction was removed and re-added", () => {
		expect(
			shouldStartAnswerExpansion({
				action: "added",
				kind: "expand",
				prior: { ...expandVote, reaction: "thumbsup", kind: "positive" },
			}),
		).toBe(true)
	})

	it("does not re-expand over a standing ❓", () => {
		expect(
			shouldStartAnswerExpansion({
				action: "added",
				kind: "expand",
				prior: expandVote,
			}),
		).toBe(false)
	})

	it("never expands on non-expand votes or removals", () => {
		expect(
			shouldStartAnswerExpansion({
				action: "added",
				kind: "positive",
				prior: undefined,
			}),
		).toBe(false)
		expect(
			shouldStartAnswerExpansion({
				action: "removed",
				kind: "expand",
				prior: undefined,
			}),
		).toBe(false)
	})
})

describe("expansion request text", () => {
	it("asks for depth without naming emoji or internals", () => {
		expect(BRAIN_EXPAND_REQUEST_TEXT).toContain("expand on your last answer")
		expect(BRAIN_EXPAND_REQUEST_TEXT).not.toContain("❓")
		expect(BRAIN_EXPAND_REQUEST_TEXT).not.toContain("reaction")
	})
})
