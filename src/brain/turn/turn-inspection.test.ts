import { describe, expect, it } from "vitest"
import type { DecisionView } from "./decision-log"
import { flowReasonFrom, summarizeTurn } from "./turn-inspection"

/** A decision row as the log hands it back, with only the fields that matter. */
function decision(overrides: Partial<DecisionView>): DecisionView {
	return {
		traceId: "trace-1",
		kind: "turn_route",
		subject: "route",
		choice: "career",
		reason: null,
		confidence: null,
		alternatives: null,
		source: "rules",
		actor: "U-1",
		supersedes: null,
		createdAt: 1_000,
		...overrides,
	}
}

describe("flowReasonFrom", () => {
	it("reads the reason out of the recorded string", () => {
		expect(flowReasonFrom("flow=document-ask")).toBe("document-ask")
		expect(flowReasonFrom("flow=no-picture-noun")).toBe("no-picture-noun")
	})

	it("says unrecorded rather than guessing when there is nothing", () => {
		expect(flowReasonFrom(null)).toBe("unrecorded")
	})

	it("keeps an unexpected shape visible instead of blanking it", () => {
		// A hand-written or older row still has to tell the reader something.
		expect(flowReasonFrom("legacy: whatever")).toBe("legacy: whatever")
	})
})

describe("summarizeTurn", () => {
	it("answers the four questions a turn raises", () => {
		const summary = summarizeTurn([
			decision({
				alternatives: { career: 1 },
				reason: "flow=document-ask",
				createdAt: 1_000,
			}),
			decision({
				kind: "model_selection",
				subject: "main_turn",
				choice: "claude-sonnet-5",
				reason: "Main turn resolved at effort medium.",
				source: "resolve_brain_main_profile",
				createdAt: 1_010,
			}),
			decision({
				kind: "skill_selection",
				subject: "make me a CV and a cover letter",
				choice: "document-delivery",
				reason: "Cleared the 0.65 confidence bar.",
				confidence: 0.91,
				alternatives: { "document-delivery": 0.91, none: 0.09 },
				source: "jev:llama-3.1-8b",
				createdAt: 1_020,
			}),
			decision({
				kind: "mcp_effect",
				subject: "linear:create_issue",
				choice: "write",
				reason: "Tool annotations say this mutates.",
				source: "mcp_annotations",
				createdAt: 1_030,
			}),
		])

		expect(summary.route).toEqual({
			primary: "career",
			matched: ["career"],
			flow: "document-ask",
		})
		expect(summary.model?.choice).toBe("claude-sonnet-5")
		expect(summary.skill).toMatchObject({
			choice: "document-delivery",
			confidence: 0.91,
			source: "jev:llama-3.1-8b",
		})
		expect(summary.tools).toEqual([
			{ subject: "linear:create_issue", choice: "write", reason: "Tool annotations say this mutates." },
		])
		expect(summary.decisionCount).toBe(4)
		expect(summary.durationMs).toBe(30)
	})

	it("keeps every route that claimed the turn, not just the winner", () => {
		const summary = summarizeTurn([
			decision({ alternatives: { campaign: 1, "research-report": 1 } }),
		])
		expect(summary.route?.primary).toBe("career")
		expect(summary.route?.matched).toEqual(["campaign", "research-report"])
	})

	it("takes the last decision of each kind, because the last one shaped the answer", () => {
		const summary = summarizeTurn([
			decision({ kind: "model_selection", choice: "claude-haiku-4.5", createdAt: 1_000 }),
			decision({ kind: "model_selection", choice: "claude-opus-4.8", createdAt: 1_100 }),
		])
		expect(summary.model?.choice).toBe("claude-opus-4.8")
	})

	it("reads a turn that decided almost nothing", () => {
		const summary = summarizeTurn([])
		expect(summary).toEqual({
			route: null,
			model: null,
			skill: null,
			tools: [],
			decisionCount: 0,
			startedAt: null,
			finishedAt: null,
			durationMs: null,
		})
	})

	it("does not invent a duration from a single timestamp", () => {
		const summary = summarizeTurn([decision({ createdAt: 5_000 })])
		expect(summary.startedAt).toBe(5_000)
		expect(summary.finishedAt).toBe(5_000)
		expect(summary.durationMs).toBeNull()
	})

	it("marks a route with no alternatives as the only claimant", () => {
		const summary = summarizeTurn([decision({ alternatives: null })])
		expect(summary.route?.matched).toEqual([])
	})
})
