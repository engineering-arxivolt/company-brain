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
import { buildContentRoundBlocks } from "./cards"
import { planDailyDrafts, planDailyKinds } from "./plan"
import { funnelBalance } from "./taxonomy"
import {
	angleForKind,
	buildBriefEvidence,
	buildEvidenceFrame,
	normaliseEvidence,
	parseEvidenceJson,
	parseUsedFactIds,
} from "./evidence"
import {
	claimContentDraft,
	CONTENT_DRAFT_STALE_CLAIM_MS,
	dismissContentDraft,
	ensureContentDraftTable,
	failContentRemix,
	finishContentPush,
	finishContentRemix,
	getContentDraft,
	getContentDraftByBufferPostId,
	insertContentDraft,
	listDraftsForRound,
	listRecentContentRounds,
	listRecentDrafts,
	startContentRound,
	supersedePendingDrafts,
	sweepStaleContentDrafts,
	updateContentRound,
	type NewContentDraft,
} from "./store"
import {
	buildContentFrame,
	channelLabelFor,
	serviceProfile,
	socialStyle,
} from "./voice"
import { mapWithConcurrency } from "./concurrency"

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

	it("leads with the kinds the evidence found, not the weekday rotation", () => {
		// The rotation is the floor: what actually happened decides the topic,
		// so a post is not about the kind of thing that happens on that weekday.
		const plan = planDailyDrafts({
			dayOfWeek: 1,
			channels,
			angles: [{ kind: "hot_take" }, { kind: "lesson" }],
		})
		expect(plan.map((p) => p.kind)).toEqual(["hot_take", "lesson"])
	})

	it("skips an angle whose kind was covered recently", () => {
		const plan = planDailyDrafts({
			dayOfWeek: 1,
			channels,
			recentKinds: ["hot_take"],
			angles: [{ kind: "hot_take" }, { kind: "build_log" }],
		})
		expect(plan.map((p) => p.kind)).toEqual(["build_log"])
	})

	it("falls back to the rotation when the evidence found nothing", () => {
		const plan = planDailyDrafts({ dayOfWeek: 1, channels, angles: [] })
		expect(plan.length).toBe(3)
		expect(plan.map((p) => p.kind)).toEqual(planDailyKinds(1, [], 3))
	})

	it("labels every draft with its funnel job and vehicle", () => {
		const plan = planDailyDrafts({ dayOfWeek: 1, channels })
		expect(plan.map((p) => [p.kind, p.funnel, p.vehicle])).toEqual([
			["build_log", "MOF", "build_log"],
			["lesson", "MOF", "story"],
			["spotlight", "BOF", "proof"],
		])
	})
})

describe("funnelBalance", () => {
	it("counts the round and names a missing stage", () => {
		const balance = funnelBalance([
			{ funnel: "TOF" },
			{ funnel: "TOF" },
			{ funnel: "MOF" },
		])
		expect(balance.counts).toEqual({ TOF: 2, MOF: 1, BOF: 0 })
		expect(balance.missing).toEqual(["BOF"])
		expect(balance.note).toContain("2 TOF")
		expect(balance.note).toContain("no BOF")
	})

	it("falls back to the kind before the funnel is stored", () => {
		const balance = funnelBalance([{ kind: "spotlight" }])
		expect(balance.counts.BOF).toBe(1)
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

	it("always sends the scheduling type Buffer requires", () => {
		// Buffer's create-post lists schedulingType as required, so a request
		// without it is rejected for a missing field — which reads as Buffer
		// being broken rather than the request being incomplete.
		const plan = buildCreatePostArgs(
			{
				type: "object",
				properties: {
					channelId: { type: "string" },
					text: { type: "string" },
					schedulingType: { enum: ["notification", "automatic"] },
					saveToDraft: { type: "boolean" },
				},
			},
			{ text, channelId: "chan_1", channelService: "linkedin", channelType: "page" },
		)
		expect(plan.args.schedulingType).toBe("automatic")
		expect(plan.args.saveToDraft).toBe(true)
	})

	it("asks for a notification where Buffer cannot publish by itself", () => {
		// Facebook groups and Instagram personal profiles only accept a
		// reminder that a human publishes by hand.
		for (const channel of [
			{ service: "facebook", type: "group" },
			{ service: "instagram", type: "profile" },
		]) {
			const plan = buildCreatePostArgs(
				{
					type: "object",
					properties: {
						channelId: { type: "string" },
						text: { type: "string" },
						schedulingType: { enum: ["notification", "automatic"] },
					},
				},
				{
					text,
					channelId: "chan_1",
					channelService: channel.service,
					channelType: channel.type,
				},
			)
			expect(plan.args.schedulingType).toBe("notification")
		}
	})

	it("attaches the source as a link preview card", () => {
		const plan = buildCreatePostArgs(
			{
				type: "object",
				properties: {
					channelId: { type: "string" },
					text: { type: "string" },
					metadata: {
						type: "object",
						properties: { linkAttachment: { type: "object" } },
					},
				},
			},
			{
				text,
				channelId: "chan_1",
				linkUrl: "https://arxivolt.dev/blog/launch",
				linkTitle: "We shipped the thing",
			},
		)
		expect(plan.args.metadata).toEqual({
			linkAttachment: {
				url: "https://arxivolt.dev/blog/launch",
				title: "We shipped the thing",
			},
		})
	})
})

describe("content evidence", () => {
	it("reads a packet out of a reply that wrapped it in prose", () => {
		const reply = `Here is what I found.\n{"angles":[{"kind":"build_log","why":"We shipped it","facts":[{"claim":"Merged the billing fix","source":"github.com/arxivolt/runtime PR 42","quote":"fix: billing"}]}]}\nHope that helps.`
		const parsed = parseEvidenceJson(reply)
		expect(parsed).not.toBeNull()
		const evidence = normaliseEvidence(parsed)
		expect(evidence.angles).toHaveLength(1)
		expect(evidence.angles[0]?.kind).toBe("build_log")
		expect(evidence.facts[0]?.claim).toBe("Merged the billing fix")
		expect(evidence.facts[0]?.quote).toBe("fix: billing")
	})

	it("repairs a packet a model wrote with trailing commas", () => {
		const parsed = parseEvidenceJson(
			'{"angles":[{"kind":"lesson","why":"x","facts":[]},],}',
		)
		expect(parsed).not.toBeNull()
		expect(normaliseEvidence(parsed).angles[0]?.kind).toBe("lesson")
	})

	it("drops angles whose kind is not a real draft kind", () => {
		const evidence = normaliseEvidence({
			angles: [
				{ kind: "viral_thread", why: "x", facts: [] },
				{ kind: "lesson", why: "y", facts: [] },
			],
		})
		expect(evidence.angles.map((a) => a.kind)).toEqual(["lesson"])
	})

	it("drops facts with no source, because they cannot be checked", () => {
		const evidence = normaliseEvidence({
			angles: [
				{
					kind: "lesson",
					why: "y",
					facts: [
						{ claim: "Something happened", source: "" },
						{ claim: "Something else happened", source: "slack #seo" },
					],
				},
			],
		})
		expect(evidence.facts).toHaveLength(1)
		expect(evidence.facts[0]?.source).toBe("slack #seo")
	})

	it("matches an angle to a kind and leaves the rest alone", () => {
		const evidence = normaliseEvidence({
			angles: [{ kind: "build_log", why: "y", facts: [] }],
		})
		expect(angleForKind(evidence, "build_log")?.kind).toBe("build_log")
		expect(angleForKind(evidence, "hot_take")).toBeNull()
	})

	it("reads which facts a draft used", () => {
		expect(parseUsedFactIds("The post\nSOURCES:\n- github\nFACTS: F1, F3")).toEqual([
			"F1",
			"F3",
		])
		expect(parseUsedFactIds("The post\nSOURCES:\n- github")).toEqual([])
	})

	it("asks the evidence turn for JSON and tells it to look at what happened", () => {
		const frame = buildEvidenceFrame({
			instruction: "post about the pricing change",
			recentKinds: ["lesson"],
			channels: [{ id: "c1", service: "linkedin", name: "Arxivolt" }],
		})
		expect(frame).toContain("post about the pricing change")
		expect(frame).toContain("Reply with JSON only")
		expect(frame).toContain("linkedin")
	})

	it("uses the Founder Brain to steer the search without treating it as a source", () => {
		const frame = buildEvidenceFrame({
			founderBrief:
				"FOUNDER BRAIN — durable context from the founder. This is not evidence.",
		})
		expect(frame).toContain("FOUNDER BRAIN")
		expect(frame).toContain("find the primary source")
	})

	it("turns the operator's brief into labelled fallback evidence", () => {
		const evidence = buildBriefEvidence(
			"Build-log round: the 8-hex slug fix and the repair patch.",
			["build_log", "lesson", "build_log"],
		)
		expect(evidence.facts).toHaveLength(1)
		expect(evidence.facts[0]?.source).toBe("operator brief")
		expect(evidence.facts[0]?.claim).toContain("8-hex slug")
		expect(evidence.angles.map((angle) => angle.kind)).toEqual([
			"build_log",
			"lesson",
		])
		expect(angleForKind(evidence, "lesson")?.facts[0]?.source).toBe(
			"operator brief",
		)
	})

	it("does not invent fallback evidence from an empty brief", () => {
		expect(buildBriefEvidence("   ", ["lesson"]).facts).toEqual([])
		expect(buildBriefEvidence(undefined, ["lesson"]).angles).toEqual([])
	})

	it("splits a long brief into separate claims", () => {
		const evidence = buildBriefEvidence(
			"Post about the 8-hex slug fix; it stops cross-customer name collisions. Then post about the repair patch; it can no longer poison the deploy payload.",
			["build_log"],
		)
		expect(evidence.facts.length).toBeGreaterThan(1)
		expect(evidence.facts[0]?.id).toBe("F1")
		expect(evidence.angles[0]?.origin).toBe("brief")
		expect(
			evidence.facts.every((fact) => fact.source === "operator brief"),
		).toBe(true)
	})

	it("keeps a link from the brief so the card can show it", () => {
		const evidence = buildBriefEvidence(
			"Post the slug fix; the commit is at https://github.com/Arxivolt/Runtime/commit/79f40d7 and it stops cross-customer name collisions.",
			["build_log"],
		)
		expect(evidence.facts[0]?.url).toBe(
			"https://github.com/Arxivolt/Runtime/commit/79f40d7",
		)
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
			funnel: "MOF",
			vehicle: "build_log",
			status: "pending",
			channelService: "twitter",
		})
		expect(listDraftsForRound(agent, "round_1")).toHaveLength(1)
	})

	it("stores explicit funnel/vehicle labels and finds a pushed draft by post id", () => {
		const { agent } = sqliteAgent()
		const saved = insertContentDraft(
			agent,
			draftInput({ funnel: "BOF", vehicle: "proof" }),
		)
		claimContentDraft(agent, saved.id, "pushing")
		finishContentPush(agent, saved.id, {
			ok: true,
			bufferPostId: "buffer_1",
			bufferMode: "draft",
		})
		const byPost = getContentDraftByBufferPostId(agent, "buffer_1")
		expect(byPost).toMatchObject({
			id: saved.id,
			funnel: "BOF",
			vehicle: "proof",
			status: "pushed",
		})
		expect(getContentDraftByBufferPostId(agent, "missing")).toBeNull()
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

	it("gives the draft a funnel job and vehicle", () => {
		const frame = buildContentFrame({
			kind: "spotlight",
			channel: { id: "c1", service: "linkedin", name: "Arxivolt" },
		})
		expect(frame).toContain("Funnel job: BOF · action")
		expect(frame).toContain("Give someone who is already interested a reason to act")
		expect(frame).toContain("Vehicle: Proof")
		expect(frame).toContain("Never mention them in the post")
	})

	it("injects the Founder Brain as context, not evidence", () => {
		const frame = buildContentFrame({
			kind: "build_log",
			channel: null,
			founderBrief:
				"FOUNDER BRAIN — durable context from the founder. This is not evidence.",
		})
		expect(frame).toContain("FOUNDER BRAIN")
		expect(frame).toContain("It is not a fact source")
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

describe("review cards", () => {
	it("shows the funnel/vehicle labels and the round mix", () => {
		const { agent } = sqliteAgent()
		const a = insertContentDraft(
			agent,
			draftInput({
				kind: "behind_the_scenes",
				funnel: "TOF",
				vehicle: "story",
				body: "A small detail from the work.",
			}),
		)
		const b = insertContentDraft(
			agent,
			draftInput({
				kind: "spotlight",
				funnel: "BOF",
				vehicle: "proof",
				body: "What someone can do now.",
			}),
		)
		const { blocks } = buildContentRoundBlocks(listDraftsForRound(agent, "round_1"), {
			bufferConnected: true,
			evidenceFacts: 2,
		})
		const json = JSON.stringify(blocks)
		expect(json).toContain("TOF · reach")
		expect(json).toContain("BOF · action")
		expect(json).toContain("Story")
		expect(json).toContain("Proof")
		expect(json).toContain("Round mix: 1 TOF")
		expect(json).toContain("no MOF")
		expect(a.id).toBeTruthy()
		expect(b.id).toBeTruthy()
	})
})

describe("content rounds", () => {
	it("records and updates a round's status", () => {
		const { agent } = sqliteAgent()
		const round = startContentRound(agent, {
			id: "round_1",
			automationId: "auto_1",
			teamId: "T1",
			ownerUserId: "user_1",
			trigger: "run_now",
			brief: "Build-log round about the slug fix",
		})
		expect(round.status).toBe("running")
		expect(round.brief).toContain("slug fix")

		updateContentRound(agent, "round_1", { status: "writing" })
		updateContentRound(agent, "round_1", { status: "posted", drafts: 3 })
		const latest = listRecentContentRounds(agent, 5)
		expect(latest[0]?.id).toBe("round_1")
		expect(latest[0]?.status).toBe("posted")
		expect(latest[0]?.drafts).toBe(3)
	})

	it("records a failed round with its error", () => {
		const { agent } = sqliteAgent()
		startContentRound(agent, {
			id: "round_2",
			automationId: "auto_1",
			brief: "anything",
		})
		updateContentRound(agent, "round_2", {
			status: "failed",
			error: "evidence turn timed out",
		})
		const latest = listRecentContentRounds(agent, 1)
		expect(latest[0]?.status).toBe("failed")
		expect(latest[0]?.error).toContain("timed out")
	})
})

describe("mapWithConcurrency", () => {
	it("keeps the input order and never runs more than the limit at once", async () => {
		let running = 0
		let peak = 0
		const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
			running++
			peak = Math.max(peak, running)
			await new Promise((resolve) => setTimeout(resolve, 5))
			running--
			return n * 2
		})
		expect(results).toEqual([2, 4, 6, 8, 10])
		expect(peak).toBeLessThanOrEqual(2)
	})
})
