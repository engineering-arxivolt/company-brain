import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import type { CompanyBrainAgent } from "../../turn/agent"
import {
	buildListPostsArgs,
	ensureContentMetricTable,
	listContentMetrics,
	normaliseBufferMetrics,
	normaliseBufferOrganizationId,
	normaliseBufferPosts,
	recordBufferMetrics,
	summariseBufferPerformance,
} from "../performance"
import {
	claimContentDraft,
	finishContentPush,
	insertContentDraft,
} from "../store"
import {
	buildMarketTask,
	isContextConnection,
	normaliseMarketSignals,
} from "./market"
import { extractMcpJson, parseFirstJsonValue } from "./mcp"

function sqliteAgent() {
	const db = new DatabaseSync(":memory:")
	const agent = {
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?")
			const statement = db.prepare(text)
			const upper = text.trimStart().toUpperCase()
			const returnsRows = upper.startsWith("SELECT") || /RETURNING/.test(upper)
			return returnsRows
				? statement.all(...(values as never[]))
				: (statement.run(...(values as never[])), [])
		},
	} as unknown as CompanyBrainAgent
	return { agent, db }
}

const BUFFER_POSTS = {
	edges: [
		{
			node: {
				id: "post_1",
				status: "sent",
				text: "We shipped the thing.",
				dueAt: "2026-10-20T10:00:00.000Z",
				sentAt: "2026-10-20T10:00:00.000Z",
				channelId: "chan_1",
				channelService: "linkedin",
				metrics: [
					{ type: "impressions", value: 1200, unit: "count" },
					{ type: "reactions", value: 34, unit: "count" },
					{ type: "comments", value: 5, unit: "count" },
					{ type: "shares", value: 2, unit: "count" },
					{ type: "clicks", value: 11, unit: "count" },
					{ type: "engagementRate", value: 4.3, unit: "percentage" },
				],
				metricsUpdatedAt: "2026-10-22T00:10:24.458Z",
			},
		},
	],
}

describe("buffer performance parsing", () => {
	it("normalises the metric array into stable names", () => {
		const metrics = normaliseBufferMetrics([
			{ type: "impressions", value: "1,200" },
			{ type: "reactions", value: 34 },
			{ type: "Eng. Rate", value: "4.3%" },
			{ type: "saves", value: 7 },
		])
		expect(metrics.impressions).toBe(1200)
		expect(metrics.reactions).toBe(34)
		expect(metrics.engagementRate).toBe(4.3)
		expect(metrics.saves).toBe(7)
	})

	it("reads the GraphQL edges shape and dedupes", () => {
		const posts = normaliseBufferPosts({
			...BUFFER_POSTS,
			edges: [...BUFFER_POSTS.edges, ...BUFFER_POSTS.edges],
		})
		expect(posts).toHaveLength(1)
		expect(posts[0]).toMatchObject({
			id: "post_1",
			channelService: "linkedin",
			metrics: { impressions: 1200, reactions: 34, clicks: 11 },
		})
	})

	it("pulls the organization id from get_account", () => {
		expect(
			normaliseBufferOrganizationId({
				id: "account_1",
				organizations: [{ id: "org_1", name: "My org" }],
			}),
		).toBe("org_1")
		expect(normaliseBufferOrganizationId({ organizationId: "org_2" })).toBe(
			"org_2",
		)
	})

	it("builds a bounded sent-posts query", () => {
		const args = buildListPostsArgs("org_1", {
			days: 7,
			now: new Date("2026-10-22T12:00:00.000Z"),
		})
		expect(args).toMatchObject({
			organizationId: "org_1",
			status: ["sent"],
			includeMetrics: true,
			dueAt: {
				start: "2026-10-15T12:00:00.000Z",
				end: "2026-10-22T12:00:00.000Z",
			},
		})
	})

	it("summarises totals without inventing a denominator", () => {
		const posts = normaliseBufferPosts(BUFFER_POSTS)
		expect(summariseBufferPerformance(posts)).toMatchObject({
			posts: 1,
			impressions: 1200,
			reactions: 34,
			comments: 5,
			shares: 2,
			clicks: 11,
			engagementRate: 4.3,
		})
	})

	it("round-trips the latest snapshot and links the draft", () => {
		const { agent } = sqliteAgent()
		ensureContentMetricTable(agent)
		const draft = insertContentDraft(agent, {
			automationId: "auto_1",
			roundId: "round_1",
			kind: "build_log",
			funnel: "BOF",
			vehicle: "proof",
			body: "We shipped it.",
			traceId: "trace_1",
		})
		claimContentDraft(agent, draft.id, "pushing")
		finishContentPush(agent, draft.id, {
			ok: true,
			bufferPostId: "post_1",
			bufferMode: "draft",
		})
		expect(recordBufferMetrics(agent, normaliseBufferPosts(BUFFER_POSTS))).toBe(1)
		const snapshots = listContentMetrics(agent)
		expect(snapshots[0]).toMatchObject({
			bufferPostId: "post_1",
			draftId: draft.id,
			channelService: "linkedin",
			metrics: { impressions: 1200 },
		})
	})
})

describe("MCP result parsing", () => {
	it("parses the first JSON value and ignores trailing rate-limit metadata", () => {
		const payload = extractMcpJson({
			content: [
				{
					type: "text",
					text: `${JSON.stringify(BUFFER_POSTS)}\n{"rateLimit":[{"remaining":9}]}`,
				},
			],
		})
		expect(payload).toMatchObject({ edges: [{ node: { id: "post_1" } }] })
	})

	it("returns null for prose with no JSON", () => {
		expect(parseFirstJsonValue("no json here")).toBeNull()
	})
})

describe("market signals", () => {
	it("matches Context.dev connections by slug or URL", () => {
		expect(
			isContextConnection({
				serverSlug: "context-dev",
				serverUrl: "",
			} as never),
		).toBe(true)
		expect(
			isContextConnection({
				serverSlug: "custom",
				serverUrl: "https://mcp.context.dev/mcp",
			} as never),
		).toBe(true)
		expect(
			isContextConnection({ serverSlug: "buffer", serverUrl: "" } as never),
		).toBe(false)
	})

	it("puts the founder's positioning and focus into the task", () => {
		const task = buildMarketTask({
			positioning: "Compliance software for Kenyan fintechs.",
			icp: "Heads of compliance",
			focus: "the new data protection rules",
			now: new Date("2026-10-22T00:00:00.000Z"),
		})
		expect(task).toContain("2026-10-22")
		expect(task).toContain("Kenyan fintechs")
		expect(task).toContain("Heads of compliance")
		expect(task).toContain("data protection rules")
		expect(task).toContain('"signals"')
	})

	it("normalises the requested shape and drops unsourced duplicates", () => {
		const signals = normaliseMarketSignals({
			signals: [
				{
					topic: "New licensing rules",
					why_it_matters: "Changes who can launch.",
					source_url: "https://example.com/rules",
					quote: "The deadline is December.",
					icp_relevance: "Every regulated fintech.",
				},
				{
					topic: "New licensing rules",
					why_it_matters: "Duplicate.",
					source_url: "https://example.com/rules",
				},
				{
					topic: "A discussion thread",
					source_url: "not-a-url",
				},
			],
		})
		expect(signals).toHaveLength(2)
		expect(signals[0]).toMatchObject({
			topic: "New licensing rules",
			sourceUrl: "https://example.com/rules",
			quote: "The deadline is December.",
		})
		expect(signals[1]?.sourceUrl).toBeNull()
	})

	it("unwraps a prose answer that actually contains JSON", () => {
		const signals = normaliseMarketSignals({
			answer: JSON.stringify({
				signals: [{ topic: "A sourced signal", source_url: "https://x.test" }],
			}),
		})
		expect(signals[0]).toMatchObject({
			topic: "A sourced signal",
			sourceUrl: "https://x.test",
		})
	})

	it("reads Context.dev's json_content structured output", () => {
		const signals = normaliseMarketSignals({
			json_content: {
				signals: [
					{
						topic: "A licensing change",
						why_it_matters: "It changes who can launch.",
						source_url: "https://example.com/licensing",
					},
				],
			},
			sources: ["https://example.com/licensing"],
		})
		expect(signals).toHaveLength(1)
		expect(signals[0]?.topic).toBe("A licensing change")
	})
})
