import { describe, expect, it } from "vitest"
import {
	MIN_FEEDBACK_SAMPLES,
	qualityScores,
	scoreFromTally,
	shouldSuppress,
	tallyVotes,
} from "./answer-quality"

const vote = (key: string, kind: "positive" | "negative") => ({ key, kind })

describe("tallyVotes", () => {
	it("counts up and down per key and ignores everything else", () => {
		const tallies = tallyVotes([
			vote("document-delivery", "positive"),
			vote("document-delivery", "positive"),
			vote("document-delivery", "negative"),
			{ key: "document-delivery", kind: "expand" },
		])
		expect(tallies.get("document-delivery")).toEqual({ positive: 2, negative: 1 })
	})
})

describe("scoreFromTally", () => {
	it("is null with no votes, not zero", () => {
		// Zero would read as "perfectly average" and hide a silent playbook.
		expect(scoreFromTally({ positive: 0, negative: 0 })).toBeNull()
	})

	it("runs from -1 to 1", () => {
		expect(scoreFromTally({ positive: 3, negative: 0 })).toBe(1)
		expect(scoreFromTally({ positive: 0, negative: 3 })).toBe(-1)
		expect(scoreFromTally({ positive: 2, negative: 1 })).toBeCloseTo(1 / 3)
	})
})

describe("qualityScores", () => {
	it("ranks what the team actually judged", () => {
		const scores = qualityScores([
			vote("career", "positive"),
			vote("career", "positive"),
			vote("flow", "negative"),
			vote("flow", "negative"),
			vote("flow", "positive"),
		])
		expect(scores.find((entry) => entry.key === "career")?.score).toBe(1)
		expect(scores.find((entry) => entry.key === "flow")).toMatchObject({
			positive: 1,
			negative: 2,
			samples: 3,
		})
	})
})

describe("shouldSuppress", () => {
	const score = (positive: number, negative: number) => {
		const samples = positive + negative
		return {
			key: "k",
			positive,
			negative,
			samples,
			score: samples ? (positive - negative) / samples : null,
		}
	}

	it("ignores a small sample, however negative", () => {
		expect(shouldSuppress(score(0, 1))).toBe(false)
		expect(shouldSuppress(score(0, MIN_FEEDBACK_SAMPLES - 1))).toBe(false)
	})

	it("suppresses a playbook people keep down-voting", () => {
		expect(shouldSuppress(score(0, 3))).toBe(true)
		expect(shouldSuppress(score(1, 3))).toBe(true) // -0.5
	})

	it("leaves a merely mixed playbook alone", () => {
		expect(shouldSuppress(score(1, 2))).toBe(false) // -0.33
		expect(shouldSuppress(score(3, 1))).toBe(false)
	})

	it("never suppresses on no votes", () => {
		expect(shouldSuppress(undefined)).toBe(false)
		expect(shouldSuppress(score(0, 0))).toBe(false)
	})
})
