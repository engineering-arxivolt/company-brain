import { describe, expect, it } from "vitest"
import {
	DEFAULT_STALE_AFTER_DAYS,
	factKey,
	msUntilNextDream,
	planConsolidation,
} from "./consolidate"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 12) // 2026-11-12

function doc(id: string, content: string, ageDays: number) {
	return { id, content, createdAt: NOW - ageDays * DAY }
}

describe("factKey", () => {
	it("treats the same note written two ways as one note", () => {
		expect(factKey("- Deploy is on Thursday, after standup.")).toBe(
			factKey("deploy is on thursday after standup"),
		)
		expect(factKey("> Résumé review: Joseph")).toBe(
			factKey("resume review joseph"),
		)
	})

	it("does not collapse notes that only share words", () => {
		expect(factKey("Deploy is on Thursday")).not.toBe(
			factKey("Deploy is on Friday"),
		)
		expect(factKey("Owner: Ada")).not.toBe(factKey("Owner: Grace"))
	})
})

describe("planConsolidation", () => {
	it("keeps the newest copy of a duplicated note", () => {
		const plan = planConsolidation(
			[
				doc("old", "Owner: Ada", 40),
				doc("new", "owner: ada", 2),
				doc("other", "Owner: Grace", 5),
			],
			{ now: NOW },
		)
		expect(plan.duplicates).toHaveLength(1)
		expect(plan.duplicates[0]?.keep).toBe("new")
		expect(plan.duplicates[0]?.drop).toEqual(["old"])
		expect(plan.distinct).toBe(2)
	})

	it("drops every older copy when a note appears three times", () => {
		const plan = planConsolidation(
			[
				doc("a", "Launch moved to May", 30),
				doc("b", "Launch moved to May", 20),
				doc("c", "Launch moved to May", 1),
			],
			{ now: NOW },
		)
		expect(plan.duplicates[0]?.keep).toBe("c")
		expect(plan.duplicates[0]?.drop.sort()).toEqual(["a", "b"])
	})

	it("never merges two different facts, however similar", () => {
		const plan = planConsolidation(
			[
				doc("a", "Deploy is on Thursday", 3),
				doc("b", "Deploy is on Friday", 3),
			],
			{ now: NOW },
		)
		expect(plan.duplicates).toEqual([])
		expect(plan.distinct).toBe(2)
	})

	it("marks old notes stale, and leaves fresh ones alone", () => {
		const plan = planConsolidation(
			[doc("fresh", "Pricing approved", 10), doc("old", "Pricing under review", 400)],
			{ now: NOW },
		)
		expect(plan.stale).toEqual([{ id: "old", ageDays: 400 }])
	})

	it("does not age a copy it is about to delete", () => {
		const plan = planConsolidation(
			[doc("old", "Same note", 400), doc("new", "Same note", 1)],
			{ now: NOW },
		)
		expect(plan.duplicates[0]?.drop).toEqual(["old"])
		expect(plan.stale).toEqual([])
	})

	it("honours a custom staleness window", () => {
		const plan = planConsolidation([doc("a", "Thirty days on", 30)], {
			now: NOW,
			staleAfterDays: 14,
		})
		expect(plan.stale).toEqual([{ id: "a", ageDays: 30 }])
		expect(DEFAULT_STALE_AFTER_DAYS).toBe(180)
	})

	it("ignores documents with no words in them", () => {
		const plan = planConsolidation([doc("empty", "   ", 1), doc("dots", "--", 1)], {
			now: NOW,
		})
		expect(plan.duplicates).toEqual([])
		expect(plan.stale).toEqual([])
		expect(plan.distinct).toBe(0)
	})

	it("handles an empty container", () => {
		expect(planConsolidation([], { now: NOW })).toEqual({
			duplicates: [],
			stale: [],
			distinct: 0,
		})
	})
})

describe("msUntilNextDream", () => {
	it("points at 03:00 UTC the same day when it is still ahead", () => {
		const now = new Date(Date.UTC(2026, 10, 12, 1, 30))
		expect(msUntilNextDream(now)).toBe(1.5 * 60 * 60 * 1000)
	})

	it("rolls to tomorrow when the hour has passed", () => {
		const now = new Date(Date.UTC(2026, 10, 12, 4, 0))
		expect(msUntilNextDream(now)).toBe(23 * 60 * 60 * 1000)
	})

	it("rolls to tomorrow at exactly the hour, so a run cannot loop", () => {
		const now = new Date(Date.UTC(2026, 10, 12, 3, 0))
		expect(msUntilNextDream(now)).toBe(24 * 60 * 60 * 1000)
	})
})
