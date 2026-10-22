/**
 * Read-only content operations tools.
 *
 * These are the two questions the operator will ask most often between
 * rounds: "what did the last posts do?" and "what is the market talking
 * about?". Both go straight to the connected source with a typed adapter, so
 * the answer is not a model's guess at what Buffer or Context.dev might say.
 */
import { generateId } from "@repo/lib/generate-id"
import { openSlackConversation } from "../slack/client"
import type { SlackLookupContext } from "../slack/channel-lookup"
import type { SlackOrg } from "../slack/workspace"
import {
	founderSectionText,
	getFounderBrain,
} from "../content/founder-brain"
import {
	describeAlertCandidates,
	listNewsBriefs,
	runNewsScan,
} from "../content/news"
import { syncContentEnginePlaybooks } from "../content/sources/content-engine"
import { runAlertWatch } from "../content/alerts"
import { listVisibleRuntimeSkills } from "../skills/store"
import {
	attachDrafts,
	fetchBufferPerformance,
	recordBufferMetrics,
	type PerformancePostWithDraft,
} from "../content/performance"
import {
	formatMarketSignals,
	scanMarket,
} from "../content/sources/market"
import type { CompanyBrainAgent } from "./agent"
import type { TurnDeps } from "./deps"

function clampDays(value: number | undefined): number {
	if (!Number.isFinite(value ?? NaN)) return 14
	return Math.max(1, Math.min(Math.round(value as number), 30))
}

function postSnippet(text: string): string {
	const clean = text.replace(/\s+/g, " ").trim()
	return clean ? clean.slice(0, 220) : "(no text)"
}

function formatPerformance(
	days: number,
	totals: {
		posts: number
		impressions: number
		reactions: number
		comments: number
		shares: number
		clicks: number
		engagementRate: number
	},
	posts: readonly PerformancePostWithDraft[],
): string {
	const lines = [
		`Buffer performance, last ${days} day${days === 1 ? "" : "s"}: ${totals.posts} sent post${totals.posts === 1 ? "" : "s"}.`,
	]
	if (!posts.length) {
		lines.push(
			"No sent posts in that window. Buffer metrics refresh daily and can lag about 24 hours, so a post published today may not appear yet.",
		)
		return lines.join("\n")
	}
	lines.push(
		`Impressions ${totals.impressions} · Reactions ${totals.reactions} · Comments ${totals.comments} · Shares ${totals.shares} · Clicks ${totals.clicks} · Avg engagement ${totals.engagementRate}%`,
	)
	const top = [...posts]
		.sort(
			(a, b) =>
				b.metrics.impressions - a.metrics.impressions ||
				b.metrics.reactions - a.metrics.reactions,
		)
		.slice(0, 5)
	lines.push("Top posts:")
	top.forEach((post, index) => {
		const labels = post.draft
			? ` · ${post.draft.funnel}/${post.draft.vehicle}`
			: " · no draft link"
		const channel = post.channelService ? ` · ${post.channelService}` : ""
		lines.push(
			`${index + 1}. "${postSnippet(post.text)}"${channel}${labels}: ${post.metrics.impressions} impressions, ${post.metrics.reactions} reactions, ${post.metrics.clicks} clicks, ${post.metrics.engagementRate}% engagement`,
		)
	})
	return lines.join("\n")
}

export type ContentPlaybooksToolArgs = {
	deps: TurnDeps
	agent: CompanyBrainAgent
	env: Env
	org: SlackOrg
	userId: string
	isAdmin: boolean
	traceId: string
}

/**
 * The house rules, as playbooks.
 *
 * Arxivolt's writing rules live in a repository, not in the workspace, so
 * JEV could not route to them. This pulls them in as skills, which is what
 * the router can see.
 */
export function createContentPlaybooksTool(args: ContentPlaybooksToolArgs) {
	const { deps } = args
	return deps.tool({
		description:
			"Sync Arxivolt's writing rules from the content-engine repository into the operator's playbooks, so the router can pre-select them when a post is written. Use it when the operator asks to import, sync or update the writing rules, the brand voice rules, the platform rules, or the house style. It never overwrites a playbook the operator wrote by hand.",
		inputSchema: deps.z.object({
			action: deps.z
				.enum(["sync", "list"])
				.optional()
				.describe(
					"sync (the default) pulls the rules from the repository. list shows the playbooks the operator can use.",
				),
			repo: deps.z
				.string()
				.optional()
				.describe(
					"Repository as owner/name. Defaults to Arxivolt/content-engine.",
				),
			ref: deps.z
				.string()
				.optional()
				.describe("Branch, tag or commit. Defaults to main."),
		}),
		execute: async ({ action, repo, ref }) => {
			if (action === "list") {
				const visible = listVisibleRuntimeSkills(args.agent, {
					userId: args.userId,
				})
				if (!visible.length) {
					return {
						ok: true,
						detail: "No playbooks are visible to this account yet.",
					}
				}
				return {
					ok: true,
					detail: `Playbooks available (the router pre-selects the best match for each turn):\n${visible
						.map((skill) => `- ${skill.name}: ${skill.description}`)
						.join("\n")}`,
				}
			}
			const result = await syncContentEnginePlaybooks({
				env: args.env,
				agent: args.agent,
				orgId: args.org.id,
				userId: args.userId,
				isAdmin: args.isAdmin,
				repo: repo ?? undefined,
				ref: ref ?? undefined,
			})
			const parts: string[] = []
			if (result.created.length)
				parts.push(`Added: ${result.created.join(", ")}.`)
			if (result.updated.length)
				parts.push(`Updated: ${result.updated.join(", ")}.`)
			if (result.skipped.length)
				parts.push(
					`Skipped ${result.skipped.length}: ${result.skipped
						.map((item) => `${item.path} (${item.reason})`)
						.join("; ")}.`,
				)
			if (!parts.length)
				parts.push("Nothing changed — the rules are already up to date.")
			return {
				ok: true,
				detail: `Writing rules synced from ${result.repo}. ${parts.join(" ")}`,
			}
		},
	})
}

export type ContentNewsToolArgs = {
	deps: TurnDeps
	agent: CompanyBrainAgent
	env: Env
	org: SlackOrg
	userId: string
	askerSlackUserId?: string
	slackLookup?: SlackLookupContext
	traceId: string
}

/**
 * The News Desk.
 *
 * "What is happening in AI, cloud and compliance that matters to us?" is the
 * question the founder actually has. The tool answers it with a brief of
 * filtered signals and a decision per signal — it never posts anything.
 */
export function createContentNewsTool(args: ContentNewsToolArgs) {
	const { deps } = args
	return deps.tool({
		description:
			"The News Desk: find the stories in AI, cloud and compliance that change something for our audience, filter them hard, and put them in front of the operator as a brief he can turn into posts. Use it for \"what's happening in our space\", \"any news about ODPC/eTIMS/cloud/AI\", \"what should we react to\", or a weekly news check. Every signal is checked against three questions: does it change a decision, cost, risk or deadline for our audience; can we attach an honest product truth; and what job does a post about it do. Nothing it finds is published — it produces a brief with Draft and Skip buttons.",
		inputSchema: deps.z.object({
			action: deps.z
				.enum(["scan", "list", "watch", "candidates"])
				.optional()
				.describe(
					"scan (the default) runs the news research and posts a brief to the DM. watch checks the alert feeds — advisories, outages, regulator notices — and raises only what is new. candidates is a dry run: it reports what the feeds returned, what the filter dropped and what the classifier chose, and raises nothing. list shows the latest briefs and their signals.",
				),
			focus: deps.z
				.string()
				.optional()
				.describe(
					"What to look for this time, in the operator's words (\"only compliance\", \"cloud pricing changes\"). Optional.",
				),
		}),
		execute: async ({ action, focus }) => {
			if (action === "candidates") {
				const report = await describeAlertCandidates({
					env: args.env,
					traceId: args.traceId,
				})
				const lines = [
					`Feeds returned ${report.found} item(s); ${report.afterFilter} survived the tier filter; the classifier would raise ${report.classified.length}.`,
				]
				if (report.classified.length) {
					lines.push(
						`Would raise:\n${report.classified.map((item) => `  - ${item}`).join("\n")}`,
					)
				}
				if (report.dropped.length) {
					lines.push(
						`Dropped (first ${report.dropped.length}):\n${report.dropped
							.map((item) => `  - [${item.source}] ${item.title}`)
							.join("\n")}`,
					)
				}
				return { ok: true, detail: lines.join("\n") }
			}
			if (action === "watch") {
				const slack = args.slackLookup
				if (!slack?.botToken || !slack.teamId) {
					return {
						ok: false,
						error:
							"The alert watch needs a Slack context — ask for it from Slack rather than from a background task.",
					}
				}
				const dmChannelId =
					slack.memoryScope?.kind === "dm"
						? slack.channel
						: await openSlackConversation(
								slack.botToken,
								args.askerSlackUserId ?? args.userId,
							)
				if (!dmChannelId) {
					return {
						ok: false,
						error: "I couldn't open a DM for the alert.",
					}
				}
				const traceId = generateId()
				args.agent.waitUntil(
					runAlertWatch({
						agent: args.agent,
						env: args.env,
						org: args.org,
						teamId: slack.teamId,
						botToken: slack.botToken,
						dmChannelId,
						ownerUserId: args.userId,
						ownerSlackUserId: args.askerSlackUserId,
						traceId,
					}).catch((err) => {
						console.error(
							`[company-brain] content_alert watch failed: ${err instanceof Error ? err.message : String(err)}`,
						)
					}),
				)
				return {
					ok: true,
					detail:
						"Checking the alert feeds now — advisories, outages and regulator notices. Anything new lands in your DM.",
				}
			}
			if (action === "list") {
				const briefs = listNewsBriefs(args.agent, args.userId, 3)
				if (!briefs.length) {
					return {
						ok: true,
						detail:
							"No news brief yet. Ask for a news scan and one will land in your DM.",
					}
				}
				const lines = briefs.map(
					(brief) =>
						`- ${new Date(brief.createdAt).toISOString().slice(0, 16)} · ${brief.signals.length} signal(s): ${brief.signals
							.map((signal) => signal.headline)
							.join(" | ")}`,
				)
				return { ok: true, detail: `News briefs:\n${lines.join("\n")}` }
			}
			const slack = args.slackLookup
			if (!slack?.botToken || !slack.teamId) {
				return {
					ok: false,
					error:
						"The News Desk needs a Slack context — ask for it from Slack rather than from a background task.",
				}
			}
			const dmChannelId = slack.memoryScope?.kind === "dm"
				? slack.channel
				: await openSlackConversation(slack.botToken, args.askerSlackUserId ?? args.userId)
			if (!dmChannelId) {
				return {
					ok: false,
					error:
						"I couldn't open a DM for the news brief. Ask again from a DM or mention me in the channel.",
				}
			}
			const traceId = generateId()
			args.agent.waitUntil(
				runNewsScan({
					agent: args.agent,
					env: args.env,
					org: args.org,
					teamId: slack.teamId,
					botToken: slack.botToken,
					dmChannelId,
					ownerUserId: args.userId,
					ownerSlackUserId: args.askerSlackUserId,
					focus: focus ?? null,
					traceId,
				}).catch((err) => {
					console.error(
						`[company-brain] content_news scan failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				}),
			)
			return {
				ok: true,
				detail:
					"Scanning for stories worth posting about. The brief lands in your DM in a few minutes with a decision per signal.",
			}
		},
	})
}

export type ContentPerformanceToolArgs = {
	deps: TurnDeps
	agent: CompanyBrainAgent
	env: Env
	orgId: string
	userId: string
	traceId: string
}

export function createContentPerformanceTool(args: ContentPerformanceToolArgs) {
	const { deps } = args
	return deps.tool({
		description:
			"Read how the posts we actually sent through Buffer performed: impressions, reactions, comments, shares, clicks, engagement rate, and which Content Studio draft each post came from. Use it for questions about post performance, what worked, or whether a format is getting traction. Buffer metrics refresh daily and may lag about 24 hours. This is a live read, not a guess.",
		inputSchema: deps.z.object({
			days: deps.z
				.number()
				.int()
				.min(1)
				.max(30)
				.optional()
				.describe("How many days back to read (default 14, max 30)."),
		}),
		execute: async ({ days }) => {
			const window = clampDays(days)
			const result = await fetchBufferPerformance(
				args.env,
				args.orgId,
				args.userId,
				{ days: window },
			)
			if (!result.ok) {
				console.log(
					`[company-brain][${args.traceId}] content_performance error="${result.error}"`,
				)
				return { ok: false, error: result.error }
			}
			let persisted = 0
			try {
				persisted = recordBufferMetrics(args.agent, result.posts)
			} catch (err) {
				console.warn(
					`[company-brain][${args.traceId}] content_performance metric store failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
			const posts = attachDrafts(args.agent, result.posts)
			const summary = formatPerformance(window, result.totals, posts)
			console.log(
				`[company-brain][${args.traceId}] content_performance posts=${posts.length} persisted=${persisted} impressions=${result.totals.impressions}`,
			)
			return {
				ok: true,
				days: window,
				summary,
				totals: result.totals,
				posts: posts.map((post) => ({
					id: post.id,
					text: postSnippet(post.text),
					channel: post.channelService,
					dueAt: post.dueAt,
					sentAt: post.sentAt,
					metrics: post.metrics,
					draft: post.draft,
				})),
			}
		},
	})
}

export type ContentMarketToolArgs = {
	deps: TurnDeps
	agent: CompanyBrainAgent
	env: Env
	orgId: string
	userId: string
	traceId: string
}

export function createContentMarketTool(args: ContentMarketToolArgs) {
	const { deps } = args
	return deps.tool({
		description:
			"Scan the live market for the founder's content system: what the audience is talking about, competitor moves, new data, and shifts in the conversation. Use it for questions like 'what is the market talking about?', 'find a trend for this week', or before planning a batch around a timely topic. It uses the Founder Brain for positioning and ICP, and Context.dev for sourced research. Returns links and quotes, not generic advice.",
		inputSchema: deps.z.object({
			focus: deps.z
				.string()
				.optional()
				.describe(
					"Optional angle or topic to focus the scan on, in the operator's own words.",
				),
		}),
		execute: async ({ focus }) => {
			const brain = getFounderBrain(args.agent, args.userId)
			const positioning = founderSectionText(brain, "positioning", 3)
			const icp = founderSectionText(brain, "icp", 3)
			if (!focus?.trim() && !positioning && !icp) {
				return {
					ok: false,
					error:
						"The Founder Brain has no positioning or ICP yet. Tell me those first, or give me a focus for this scan.",
				}
			}
			const result = await scanMarket(args.env, args.orgId, args.userId, {
				positioning,
				icp,
				focus,
			})
			if (!result.ok) {
				console.log(
					`[company-brain][${args.traceId}] content_market_scan error="${result.error}"`,
				)
				return { ok: false, error: result.error }
			}
			const summary = result.signals.length
				? formatMarketSignals(result.signals)
				: result.raw
					? `Context.dev returned a prose answer instead of the requested shape:\n\n${result.raw}`
					: "No sourced signals came back for that focus. Try a broader angle."
			console.log(
				`[company-brain][${args.traceId}] content_market_scan signals=${result.signals.length} focus="${focus ?? "-"}"`,
			)
			return {
				ok: true,
				asOf: result.asOf,
				summary,
				signals: result.signals,
				...(result.raw ? { raw: result.raw.slice(0, 3000) } : {}),
			}
		},
	})
}
