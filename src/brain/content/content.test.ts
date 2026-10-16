import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	buildCreatePostArgs,
	extractJsonPayload,
	findPostId,
	isBufferConnection,
	normalizeBufferChannels,
	toolError,
} from "./buffer"
import { planDailyDrafts, planDailyKinds } from "./plan"
import {
	claimContentDraft,
	CONTENT_DRAFT_STALE_CLAIM_MS,
	dismissContentDraft,
	ensureContentDraftTable,
	failContentRemix,
	finishContentPush,
	finishContentRemix,
	getContentDraft,
	insertContentDraft,
	listDraftsForRound,
	listRecentDrafts,
	supersedePendingDrafts,
	sweepStaleContentDrafts,
	type NewContentDraft,
} from "./store"
import {
	buildContentFrame,
	channelLabelFor,
	serviceProfile,
	socialStyle,
} from "./voice"

/** Runs the module's real SQL against a real SQLite engine, as the DO does. */
function sqliteAgent() {
	const db = new DatabaseSync(":memory:")
	const agent = {
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?")
			const statement = db.prepare(text)
			const upper = text.trimStart().toUpperCase()
			const returnsRows =
				upper.startsWith("SELECT") || /RETURNING/.test(upper)
			return returnsRows
				? statement.all(...(values as never[]))
				: (statement.run(...(values as never[])), [])
		},
	} as unknown as CompanyBrainAgent
	return { agent, db }
}

function draftInput(overrides: Partial<NewContentDraft> = {}): NewContentDraft {
	return {
		automationId: "auto_1",
		roundId: "round_1",
		teamId: "T1",
		ownerUserId: "user_1",
		ownerSlackUserId: "U1",
		dmChannelId: "D1",
		kind: "build_log",
		channelId: "chan_x",
		channelService: "twitter",
		channelLabel: "X (Twitter) — us",
		body: "We shipped the thing. It does the thing now.",
		traceId: "trace_1",
		...overrides,
	}
}

describe("planDailyKinds", () => {
	it("returns three distinct kinds for a weekday", () => {
		const kinds = planDailyKinds(1, [])
		expect(kinds).toHaveLength(3)
		expect(new Set(kinds).size).toBe(3)
		expect(kinds[0]).toBe("build_log")
	})

	it("skips kinds covered in the recent window", () => {
		const kinds = planDailyKinds(1, ["build_log", "lesson", "spotlight"])
		expect(kinds).toHaveLength(3)
		expect(kinds).not.toContain("build_log")
		expect(kinds).not.toContain("lesson")
		expect(kinds).not.toContain("spotlight")
	})

	it("still fills the day when everything was recent", () => {
		const all = ["build_log", "lesson", "spotlight", "behind_the_scenes", "hot_take", "question"]
		const kinds = planDailyKinds(1, all)
		expect(kinds).toHaveLength(3)
		expect(new Set(kinds).size).toBe(3)
	})
})

describe("planDailyDrafts", () => {
	const channels = [
		{ id: "c1", service: "twitter", name: "us" },
		{ id: "c2", service: "linkedin", name: "Company" },
	]

	it("rotates channels round-robin from a day offset", () => {
		const plan = planDailyDrafts({ dayOfWeek: 1, channels })
		expect(plan).toHaveLength(3)
		expect(plan.map((p) => p.channel?.id)).toEqual(["c2", "c1", "c2"])
	})

	it("writes channel-less drafts when nothing is connected", () => {
		const plan = planDailyDrafts({ dayOfWeek: 3, channels: [] })
		expect(plan.every((p) => p.channel === null)).toBe(true)
	})
})

describe("buildCreatePostArgs", () => {
	const text = "hello world"

	it("prefers a boolean draft toggle", () => {
		const plan = buildCreatePostArgs(
			{
				type: "object",
				properties: {
					channelId: { type: "string" },
					text: { type: "string" },
					saveToDraft: { type: "boolean" },
				},
			},
			{ text, channelId: "chan_1" },
		)
		expect(plan.mode).toBe("draft")
		expect(plan.args).toMatchObject({
			channelId: "chan_1",
			text,
			saveToDraft: true,
		})
	})

	it("uses a draft enum value when present", () => {
		const plan = buildCreatePostArgs(
			{
				type: "object",
				properties: {
					channelId: { type: "string" },
					text: { type: "string" },
					mode: { enum: ["shareNow", "addToQueue", "draft"] },
				},
			},
			{ text, channelId: "chan_1" },
		)
		expect(plan.mode).toBe("draft")
		expect(plan.args.mode).toBe("draft")
	})

	it("falls back to a queue value before bare create", () => {
		const plan = buildCreatePostArgs(
			{
				type: "object",
				properties: {
					channelId: { type: "string" },
					text: { type: "string" },
					schedulingType: { enum: ["shareNow", "addToQueue"] },
				},
			},
			{ text, channelId: "chan_1" },
		)
		expect(plan.mode).toBe("queue")
		expect(plan.args.schedulingType).toBe("addToQueue")
	})

	it("maps plural channel keys to an array", () => {
		const plan = buildCreatePostArgs(
			{
				type: "object",
				properties: {
					channelIds: { type: "array" },
					content: { type: "string" },
				},
			},
			{ text, channelId: "chan_1" },
		)
		expect(plan.args.channelIds).toEqual(["chan_1"])
		expect(plan.args.content).toBe(text)
	})

	it("does the best it can without a schema", () => {
		const plan = buildCreatePostArgs(undefined, { text, channelId: "c" })
		expect(plan.mode).toBe("standard")
		expect(plan.args).toEqual({ text, channelId: "c" })
	})
})

describe("normalizeBufferChannels", () => {
	it("reads the common shapes and dedupes", () => {
		const channels = normalizeBufferChannels({
			data: {
				channels: [
					{ id: "1", service: "twitter", name: "us" },
					{ id: "1", service: "twitter", name: "us again" },
					{
						channel: { id: "2", service: "linkedin", displayName: "Company" },
					},
				],
			},
		})
		expect(channels).toEqual([
			{ id: "1", service: "twitter", name: "us" },
			{ id: "2", service: "linkedin", name: "Company" },
		])
	})

	it("accepts a bare array", () => {
		expect(
			normalizeBufferChannels([{ channelId: "9", platform: "Bluesky" }]),
		).toEqual([{ id: "9", service: "bluesky", name: "bluesky" }])
	})

	it("returns empty for junk", () => {
		expect(normalizeBufferChannels(null)).toEqual([])
		expect(normalizeBufferChannels({ ok: true })).toEqual([])
	})
})

describe("findPostId / extractJsonPayload / toolError", () => {
	it("finds ids in nested shapes", () => {
		expect(findPostId({ post: { id: "p_1" } })).toBe("p_1")
		expect(findPostId({ data: { post: { postId: "p_2" } } })).toBe("p_2")
		expect(findPostId({ ok: true })).toBeNull()
	})

	it("parses fenced and wrapped JSON text", () => {
		const result = {
			content: [
				{
					type: "text",
					text: '```json\n{"channels":[{"id":"1","service":"x"}]}\n```',
				},
			],
		}
		expect(extractJsonPayload(result)).toMatchObject({
			channels: [{ id: "1" }],
		})
	})

	it("surfaces tool errors", () => {
		expect(toolError({ isError: true, content: [{ type: "text", text: "nope" }] })).toBe("nope")
		expect(toolError({ content: [] })).toBeNull()
	})
})

describe("isBufferConnection", () => {
	it("matches slug or URL", () => {
		expect(
			isBufferConnection({ serverSlug: "buffer", serverUrl: "" } as never),
		).toBe(true)
		expect(
			isBufferConnection({
				serverSlug: "custom-abc",
				serverUrl: "https://mcp.buffer.com/mcp",
			} as never),
		).toBe(true)
		expect(
			isBufferConnection({ serverSlug: "linear", serverUrl: "" } as never),
		).toBe(false)
	})
})

describe("content draft store", () => {
	it("round-trips a draft", () => {
		const { agent } = sqliteAgent()
		const saved = insertContentDraft(agent, draftInput())
		const loaded = getContentDraft(agent, saved.id)
		expect(loaded).toMatchObject({
			automationId: "auto_1",
			roundId: "round_1",
			kind: "build_log",
			status: "pending",
			channelService: "twitter",
		})
		expect(listDraftsForRound(agent, "round_1")).toHaveLength(1)
	})

	it("claim is single-owner and stale claims are reclaimable", () => {
		const { agent, db } = sqliteAgent()
		const saved = insertContentDraft(agent, draftInput())
		const first = claimContentDraft(agent, saved.id, "pushing")
		expect(first?.status).toBe("pushing")
		expect(claimContentDraft(agent, saved.id, "pushing")).toBeNull()
		// Age the claim past the stale cutoff: it becomes reclaimable.
		db.prepare(
			"UPDATE brain_content_draft SET updated_at = ? WHERE id = ?",
		).run(Date.now() - CONTENT_DRAFT_STALE_CLAIM_MS - 1000, saved.id)
		const again = claimContentDraft(agent, saved.id, "pushing")
		expect(again?.status).toBe("pushing")
	})

	it("push settles to pushed, or parks back to pending with the error", () => {
		const { agent } = sqliteAgent()
		const a = insertContentDraft(agent, draftInput())
		claimContentDraft(agent, a.id, "pushing")
		finishContentPush(agent, a.id, {
			ok: true,
			bufferPostId: "p_9",
			bufferMode: "draft",
		})
		expect(getContentDraft(agent, a.id)).toMatchObject({
			status: "pushed",
			bufferPostId: "p_9",
			bufferMode: "draft",
		})

		const b = insertContentDraft(agent, draftInput())
		claimContentDraft(agent, b.id, "pushing")
		finishContentPush(agent, b.id, { ok: false, error: "boom" })
		expect(getContentDraft(agent, b.id)).toMatchObject({
			status: "pending",
			error: "boom",
		})
	})

	it("remix replaces the body and can pin a channel", () => {
		const { agent } = sqliteAgent()
		const saved = insertContentDraft(
			agent,
			draftInput({ channelId: null, channelService: null, channelLabel: null }),
		)
		claimContentDraft(agent, saved.id, "remixing")
		finishContentRemix(agent, saved.id, {
			body: "Fresh angle.",
			sourcesJson: "[]",
			flagsJson: "[]",
			channelId: "new_chan",
			channelService: "linkedin",
			channelLabel: "LinkedIn",
		})
		expect(getContentDraft(agent, saved.id)).toMatchObject({
			status: "pending",
			body: "Fresh angle.",
			channelId: "new_chan",
			channelService: "linkedin",
		})

		const failed = insertContentDraft(agent, draftInput())
		claimContentDraft(agent, failed.id, "remixing")
		failContentRemix(agent, failed.id, "turn_error")
		expect(getContentDraft(agent, failed.id)).toMatchObject({
			status: "pending",
			error: "turn_error",
		})
	})

	it("dismiss only from pending", () => {
		const { agent } = sqliteAgent()
		const saved = insertContentDraft(agent, draftInput())
		expect(dismissContentDraft(agent, saved.id)).toBe(true)
		expect(getContentDraft(agent, saved.id)?.status).toBe("dismissed")
		expect(dismissContentDraft(agent, saved.id)).toBe(false)
	})

	it("a new round supersedes older pending drafts of the same automation only", () => {
		const { agent } = sqliteAgent()
		const old1 = insertContentDraft(agent, draftInput({ roundId: "round_old" }))
		const old2 = insertContentDraft(agent, draftInput({ roundId: "round_old" }))
		const other = insertContentDraft(
			agent,
			draftInput({ automationId: "auto_2", roundId: "round_old" }),
		)
		const fresh = insertContentDraft(agent, draftInput({ roundId: "round_new" }))
		const superseded = supersedePendingDrafts(agent, "auto_1", [fresh.id])
		expect(superseded).toBe(2)
		expect(getContentDraft(agent, old1.id)?.status).toBe("superseded")
		expect(getContentDraft(agent, old2.id)?.status).toBe("superseded")
		expect(getContentDraft(agent, other.id)?.status).toBe("pending")
		expect(getContentDraft(agent, fresh.id)?.status).toBe("pending")
	})

	it("recent drafts are windowed and ordered newest-first", () => {
		const { agent, db } = sqliteAgent()
		const old = insertContentDraft(agent, draftInput())
		db.prepare(
			"UPDATE brain_content_draft SET created_at = ? WHERE id = ?",
		).run(Date.now() - 8 * 24 * 60 * 60 * 1000, old.id)
		const fresh = insertContentDraft(agent, draftInput())
		const recent = listRecentDrafts(agent, "auto_1")
		expect(recent.map((d) => d.id)).toEqual([fresh.id])
	})

	it("sweeps stale claims back to pending", () => {
		const { agent, db } = sqliteAgent()
		const saved = insertContentDraft(agent, draftInput())
		ensureContentDraftTable(agent)
		db.prepare(
			"UPDATE brain_content_draft SET status = 'pushing', updated_at = ? WHERE id = ?",
		).run(Date.now() - CONTENT_DRAFT_STALE_CLAIM_MS - 5, saved.id)
		expect(sweepStaleContentDrafts(agent)).toBe(1)
		const recovered = getContentDraft(agent, saved.id)
		expect(recovered?.status).toBe("pending")
		expect(recovered?.error).toContain("interrupted")
	})
})

describe("voice", () => {
	it("knows platform limits", () => {
		expect(serviceProfile("twitter").limit).toBe(280)
		expect(serviceProfile("x").limit).toBe(280)
		expect(serviceProfile("linkedin").limit).toBe(3000)
		expect(serviceProfile("something-new").limit).toBe(2000)
	})

	it("frames a draft with recipe, platform, guardrails, and anti-repeat", () => {
		const frame = buildContentFrame({
			kind: "build_log",
			channel: { id: "c1", service: "linkedin", name: "Company" },
			focus: "Lean into the launch energy.",
			recentBodies: ["We shipped X last week."],
		})
		expect(frame).toContain("shipped, finished, or fixed")
		expect(frame).toContain("LinkedIn")
		expect(frame).toContain("Lean into the launch energy.")
		expect(frame).toContain("We shipped X last week.")
		expect(frame).toContain("NOTHING_NEW")
		expect(frame).toContain("SOURCES:")
		expect(frame).toContain("copywriting")
		expect(frame).toContain("Never publish customer")
	})

	it("frame without a channel or focus stays valid", () => {
		const frame = buildContentFrame({ kind: "question", channel: null })
		expect(frame).toContain("general social")
		expect(frame).not.toContain("Previous attempt")
	})

	it("remix frames carry the previous attempt", () => {
		const frame = buildContentFrame({
			kind: "hot_take",
			channel: null,
			previousAttempt: "The old angle.",
		})
		expect(frame).toContain("Previous attempt")
		expect(frame).toContain("The old angle.")
	})

	it("socialStyle strips markdown emphasis and dashes", () => {
		expect(socialStyle("We shipped **it** — finally.")).toBe(
			"We shipped it, finally.",
		)
		expect(socialStyle("*Fast* and done.")).toBe("Fast and done.")
	})

	it("labels channels for the card", () => {
		expect(
			channelLabelFor({ service: "linkedin", name: "Company page" }),
		).toBe("LinkedIn — Company page")
		expect(channelLabelFor({ service: "twitter", name: "twitter" })).toBe(
			"X (Twitter)",
		)
		expect(channelLabelFor(null)).toBeNull()
	})
})
