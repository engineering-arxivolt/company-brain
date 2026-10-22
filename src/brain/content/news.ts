/**
 * The News Desk.
 *
 * The founder does not want to read the news; he wants to be the person who
 * explains the three stories that change something for his customers. This
 * module finds those stories, filters them hard, and puts them in front of
 * him with a button per signal: draft it for reach, draft it for trust, or
 * skip it.
 *
 * Discovery is deliberately not a fixed feed. The market is scanned through
 * web search and the connected apps, so a story we did not know to watch for
 * still surfaces. The filter is what makes that safe: every signal has to
 * pass three questions, or it is dropped before the operator sees it.
 *
 *   1. Does it change a decision, cost, risk, or deadline for our audience?
 *   2. Can we attach an honest product truth?
 *   3. What job does a post about it do — reach, trust, or a conversation?
 */
import { generateId } from "@repo/lib/generate-id"
import { captureContentEvent } from "@/lib/posthog"
import type { CompanyBrainAgent } from "../turn/agent"
import type { SlackOrg } from "../slack/workspace"
import { postSlackMessage } from "../slack/client"
import { updateSlackInteractionResponse } from "../slack/client"
import { parseFirstJsonValue } from "./sources/mcp"
import { fetchAlertItems, fetchRawAlertItems, type AlertItem } from "./alerts"
import { loadFounderBrief } from "./founder-brain"

export const NEWS_DRAFT_TOF_ACTION = "brain_news_draft_tof"
export const NEWS_DRAFT_MOF_ACTION = "brain_news_draft_mof"
export const NEWS_SKIP_ACTION = "brain_news_skip"

export type NewsFunnel = "TOF" | "MOF" | "BOF"

export type NewsSignal = {
	id: string
	headline: string
	whatChanged: string
	whoCares: string
	productHook: string
	funnel: NewsFunnel
	sourceUrl: string | null
	sourceName: string | null
	date: string | null
	status: "new" | "drafting" | "skipped"
}

export type NewsBrief = {
	id: string
	userId: string
	orgId: string
	teamId: string | null
	dmChannelId: string | null
	signals: NewsSignal[]
	createdAt: number
	updatedAt: number
}

type NewsBriefRow = {
	id: string
	user_id: string
	org_id: string
	team_id: string | null
	dm_channel_id: string | null
	signals_json: string
	created_at: number
	updated_at: number
}

export const MAX_NEWS_SIGNALS = 5
export const NEWS_RESEARCH_TIMEOUT_MS = 420_000

const newsSchemaReady = new WeakSet<CompanyBrainAgent>()

export function ensureNewsTable(agent: CompanyBrainAgent): void {
	if (newsSchemaReady.has(agent)) return
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_content_news (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			team_id TEXT,
			dm_channel_id TEXT,
			signals_json TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	newsSchemaReady.add(agent)
}

export function saveNewsBrief(
	agent: CompanyBrainAgent,
	brief: NewsBrief,
): NewsBrief {
	ensureNewsTable(agent)
	agent.sql`
		INSERT INTO brain_content_news (
			id, user_id, org_id, team_id, dm_channel_id, signals_json,
			created_at, updated_at
		) VALUES (
			${brief.id}, ${brief.userId}, ${brief.orgId}, ${brief.teamId},
			${brief.dmChannelId}, ${JSON.stringify(brief.signals)},
			${brief.createdAt}, ${brief.updatedAt}
		)
		ON CONFLICT(id) DO UPDATE SET
			signals_json = excluded.signals_json,
			updated_at = excluded.updated_at
	`
	return brief
}

export function getNewsBrief(
	agent: CompanyBrainAgent,
	id: string,
): NewsBrief | null {
	ensureNewsTable(agent)
	const rows = agent.sql<NewsBriefRow>`
		SELECT * FROM brain_content_news WHERE id = ${id} LIMIT 1
	`
	const row = rows[0]
	if (!row) return null
	return {
		id: row.id,
		userId: row.user_id,
		orgId: row.org_id,
		teamId: row.team_id,
		dmChannelId: row.dm_channel_id,
		signals: parseSignals(row.signals_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function listNewsBriefs(
	agent: CompanyBrainAgent,
	userId: string,
	limit = 3,
): NewsBrief[] {
	ensureNewsTable(agent)
	const take = Math.max(1, Math.min(limit, 10))
	const rows = agent.sql<NewsBriefRow>`
		SELECT * FROM brain_content_news
		WHERE user_id = ${userId}
		ORDER BY created_at DESC
		LIMIT ${take}
	`
	return rows.map((row) => ({
		id: row.id,
		userId: row.user_id,
		orgId: row.org_id,
		teamId: row.team_id,
		dmChannelId: row.dm_channel_id,
		signals: parseSignals(row.signals_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}))
}

function parseSignals(raw: string): NewsSignal[] {
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? (parsed as NewsSignal[]) : []
	} catch {
		return []
	}
}

function cleanLine(value: unknown, max = 400): string {
	if (typeof value !== "string") return ""
	return value.replace(/\s+/g, " ").trim().slice(0, max)
}

function asFunnel(value: unknown): NewsFunnel {
	const text = typeof value === "string" ? value.toUpperCase() : ""
	if (text.includes("MOF")) return "MOF"
	if (text.includes("BOF")) return "BOF"
	return "TOF"
}

/** Read the packet the research turn returned, keeping only clean signals. */
export function normaliseNewsSignals(raw: unknown): NewsSignal[] {
	const record = raw as { signals?: unknown } | null
	const list = Array.isArray(record?.signals) ? record.signals : []
	const out: NewsSignal[] = []
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue
		const value = entry as Record<string, unknown>
		const headline = cleanLine(value.headline, 200)
		const whatChanged = cleanLine(value.what_changed ?? value.whatChanged, 400)
		if (!headline || !whatChanged) continue
		out.push({
			id: `S${out.length + 1}`,
			headline,
			whatChanged,
			whoCares: cleanLine(value.who_cares ?? value.whoCares, 300),
			productHook: cleanLine(value.product_hook ?? value.productHook, 300),
			funnel: asFunnel(value.funnel),
			sourceUrl: cleanLine(value.source_url ?? value.sourceUrl, 400) || null,
			sourceName: cleanLine(value.source_name ?? value.sourceName, 120) || null,
			date: cleanLine(value.date, 40) || null,
			status: "new",
		})
		if (out.length >= MAX_NEWS_SIGNALS) break
	}
	return out
}

/** The brief for the research turn. */
export function buildNewsFrame(args: {
	positioning?: string | null
	icp?: string | null
	founderBrief?: string | null
	focus?: string | null
	now?: Date
}): string {
	const now = args.now ?? new Date()
	const date = now.toISOString().slice(0, 10)
	const sections: string[] = []
	sections.push(
		`You are the news desk for a founder's content system. Today is ${date}. Find the stories worth posting about — not the news, the stories that change something for our customers.`,
	)
	if (args.founderBrief?.trim()) {
		sections.push(
			`${args.founderBrief.trim()}

This is context, not evidence. It tells you who we are and who we are talking to, so you know which stories matter.`,
		)
	}
	sections.push(
		`Where to look — these are the live paths to the internet here, and you should use both:
- Flovia web search (search_web) for headlines and links, then web_extract to read the pages that matter.
- Context.dev's web-answers tool for a live scan of a question ("what changed in ODPC or KRA eTIMS compliance in the last week", "any cloud pricing, outage or AI model change that affects Kenyan developers"). Ask it one focused question at a time.
Then narrow by domain: regulators and law (ODPC, KRA eTIMS, Kenya Law, CBK, CMA), cloud and AI providers (Cloudflare, AWS, Azure, Google Cloud, OpenAI, Anthropic, Google AI), and the local market (TechCabal, Business Daily, The EastAfrican, CIO East Africa). Look at the last 7 days; look at what actually changed, not what was published about.
Also check our own connected apps for what actually happened (releases, merged work, closed tickets) — that is story material too, and it is the kind we can be first about.
Budget: at most eight tool calls, then answer. One broad Context.dev scan, two or three web searches, and the pages worth reading — not a sweep. An answer with three well-sourced signals beats an exhaustive one that never arrives.`,
	)
	sections.push(
		`Only include a story if all three are true:
1. It changes a decision, a cost, a risk, or a deadline for our audience.
2. We can attach an honest product truth: Forge (deploys close to the user, local billing, data residency, no foreign-card friction) or Foundry (ODPC, DPA 2022, the 72-hour breach clock, KRA eTIMS).
3. It has a job: TOF (earn attention), MOF (show we understand the problem), BOF (start a conversation).
Leave out funding rounds, listicles, SEO pages, and anything you cannot source. Fewer signals is better than thin ones.`,
	)
	if (args.focus?.trim()) {
		sections.push(
			`The operator asked for this scan to focus on: ${args.focus.trim()}. Everything else still has to pass the three questions.`,
		)
	}
	sections.push(
		`For each signal, write what changed in one sentence and why our audience cares in one sentence. Quote the exact words when the source gave you any.`,
	)
	sections.push(
		`Reply with JSON only, no prose and no code fence:
{"signals":[{"headline":"","what_changed":"","who_cares":"","product_hook":"","funnel":"TOF|MOF|BOF","source_url":"","source_name":"","date":""}]}
If nothing clears the bar, reply with {"signals":[]}.`,
	)
	return sections.join("\n\n")
}

export type NewsResearchOutcome = {
	signals: NewsSignal[]
	/** "ok" found something, "empty" found nothing that cleared the bar,
	 * "failed" never finished. The third is a fault, not an answer. */
	status: "ok" | "empty" | "failed"
	ms: number
}

/**
 * Run the research turn and return the signals.
 *
 * Never throws: a quiet week is a legitimate answer, and it is said out loud
 * rather than looked like a failure. A sweep that ran out of time is not the
 * same as a quiet week, and the difference is reported.
 */
export async function collectNewsSignals(args: {
	agent: CompanyBrainAgent
	org: SlackOrg
	teamId: string
	botToken: string
	dmChannelId: string
	ownerUserId: string
	ownerSlackUserId?: string
	founderBrief?: string | null
	focus?: string | null
	traceId: string
	env: Env
}): Promise<NewsResearchOutcome> {
	const founderBrief =
		args.founderBrief ?? loadFounderBrief(args.agent, args.ownerUserId)
	const frame = buildNewsFrame({ founderBrief, focus: args.focus ?? null })
	const startedAt = Date.now()
	let reply = ""
	let failed = false
	try {
		const { computeTurn, EMPTY_REPLY } = await import("../turn/compute")
		const out = await computeTurn({
			agent: args.agent,
			org: args.org,
			userId: args.ownerUserId,
			actor: {
				orgId: args.org.id,
				userId: args.ownerUserId,
				personalConnectionsOnly: true,
				readOnly: true,
				memberLookup: "found",
			},
			question: frame,
			threadText: "",
			slackLookup: {
				botToken: args.botToken,
				channel: args.dmChannelId,
				teamId: args.teamId,
				memoryScope: {
					kind: "dm",
					channelId: args.dmChannelId,
					userId: args.ownerUserId,
					slackUserId: args.ownerSlackUserId,
				},
			},
			asker: args.ownerSlackUserId
				? { slackUserId: args.ownerSlackUserId }
				: undefined,
			scheduledRun: true,
			skipBilling: true,
			effortOverride: "medium",
			ephemeral: true,
			stepLimit: 10,
			options: {
				abortSignal: AbortSignal.timeout(NEWS_RESEARCH_TIMEOUT_MS),
				// A research turn needs the web and the connected apps, not the
				// thirty other schemas: on the free models those schemas are
				// what turned the sweep into a timeout.
				toolPolicy: "lean",
			},
			obs: { traceId: args.traceId, source: "content_news" },
			env: args.env,
		})
		if (out.status === "completed" && out.reply.trim() !== EMPTY_REPLY)
			reply = out.reply
		else
			failed = true
	} catch (err) {
		failed = true
		console.warn(
			`[company-brain] content-news research failed org=${args.org.id}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	const signals = reply.trim()
		? normaliseNewsSignals(parseFirstJsonValue(reply))
		: []
	const ms = Date.now() - startedAt
	const status: NewsResearchOutcome["status"] = failed
		? "failed"
		: signals.length > 0
			? "ok"
			: "empty"
	console.log(
		`[company-brain] content-news research org=${args.org.id} signals=${signals.length} status=${status} ms=${ms}`,
	)
	return { signals, status, ms }
}

function signalLine(signal: NewsSignal): string {
	return `• ${signal.headline}${signal.sourceName ? ` (${signal.sourceName}${signal.date ? `, ${signal.date}` : ""})` : ""}\n  What changed: ${signal.whatChanged}\n  Who cares: ${signal.whoCares || "—"}\n  Product hook: ${signal.productHook || "—"}`
}

/** The review card: the signals, and a decision per signal. */
export function buildNewsBriefBlocks(brief: NewsBrief): {
	text: string
	blocks: unknown[]
} {
	const blocks: Record<string, unknown>[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*📰 News Brief* — ${new Date(brief.createdAt)
					.toISOString()
					.slice(0, 10)}\n${brief.signals
					.map(signalLine)
					.join("\n")}`,
			},
		},
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "Each signal passed the filter: it changes something for our audience, it has a product hook, and it has a job. Draft it, or skip it — nothing publishes without your push.",
				},
			],
		},
	]
	for (const signal of brief.signals) {
		if (signal.status !== "new") continue
		blocks.push({
			type: "actions",
			block_id: `news_${brief.id}_${signal.id}`,
			elements: [
				{
					type: "button",
					action_id: NEWS_DRAFT_TOF_ACTION,
					text: { type: "plain_text", text: "Draft (reach)", emoji: true },
					value: `${brief.id}|${signal.id}`,
				},
				{
					type: "button",
					action_id: NEWS_DRAFT_MOF_ACTION,
					text: { type: "plain_text", text: "Draft (trust)", emoji: true },
					value: `${brief.id}|${signal.id}`,
				},
				{
					type: "button",
					action_id: NEWS_SKIP_ACTION,
					text: { type: "plain_text", text: "Skip", emoji: true },
					value: `${brief.id}|${signal.id}`,
				},
			],
		})
	}
	return {
		text: `📰 News Brief — ${brief.signals.length} signal(s) worth a post. Review them in your DM.`,
		blocks,
	}
}

/** The brief a news signal becomes when the operator asks for a draft. */
export function newsSignalBrief(
	signal: NewsSignal,
	funnel: "TOF" | "MOF",
): string {
	const job =
		funnel === "TOF"
			? "The job is reach: earn attention with the story itself. The product appears at most once, late."
			: "The job is trust: show that we understand what changed and what to do about it. The product appears once, as the answer."
	return [
		`Write one post about this story: ${signal.headline}`,
		`What changed: ${signal.whatChanged}`,
		`Who it affects: ${signal.whoCares || "our audience"}`,
		`Product truth to attach: ${signal.productHook || "only if it fits honestly"}`,
		signal.sourceUrl ? `Source: ${signal.sourceUrl}` : "",
		job,
		"Use the Founder Brain. Do not invent facts: every claim must come from the story above or the Founder Brain.",
	]
		.filter(Boolean)
		.join("\n")
}

/** Post the brief into the operator's DM. */
export async function postNewsBrief(
	botToken: string,
	dmChannelId: string,
	brief: NewsBrief,
): Promise<string | undefined> {
	const { text, blocks } = buildNewsBriefBlocks(brief)
	return postSlackMessage(botToken, dmChannelId, text, undefined, blocks)
}

/**
 * What the watch found, and what it dropped, without raising anything.
 *
 * The filter is the part that needs tuning — "the filters were too
 * restrictive" is a complaint you can only settle by seeing the candidates.
 * This reports every item the feeds returned, which tier it belongs to,
 * whether it survived, and what the classifier thought of it.
 */
export async function describeAlertCandidates(args: {
	env: Env
	lookbackHours?: number
	traceId?: string
}): Promise<{
	found: number
	afterFilter: number
	classified: string[]
	dropped: Array<{ source: string; title: string; reason: string }>
}> {
	const lookback = (args.lookbackHours ?? 72) * 60 * 60 * 1000
	const raw = await fetchRawAlertItems({
		env: args.env,
		sinceMs: Date.now() - lookback,
	})
	const items = await fetchAlertItems({
		env: args.env,
		sinceMs: Date.now() - lookback,
	})
	const kept = new Set(items.map((item) => item.id))
	const { classifyAlertsWithJev } = await import("./alerts-classify")
	const classification = await classifyAlertsWithJev({
		env: args.env,
		items,
		maxAlerts: 3,
		traceId: args.traceId,
	})
	return {
		found: raw.length,
		afterFilter: items.length,
		classified: classification.selected.map(
			(item) => `${item.source}: ${item.title.slice(0, 90)}`,
		),
		dropped: raw
			.filter((item) => !kept.has(item.id))
			.slice(0, 20)
			.map((item) => ({
				source: item.source,
				title: item.title.slice(0, 90),
				reason: "did not survive the tier filter",
			})),
	}
}

/**
 * Run the scan: research, filter, store, post.
 *
 * A quiet week is a legitimate answer and it is posted as such. The brief
 * always says what it did and did not find, so an empty brief never looks
 * like a broken one.
 */
export async function runNewsScan(args: {
	agent: CompanyBrainAgent
	env: Env
	org: SlackOrg
	teamId: string
	botToken: string
	dmChannelId: string
	ownerUserId: string
	ownerSlackUserId?: string
	focus?: string | null
	traceId: string
}): Promise<void> {
	const { agent, env, org, teamId, botToken, dmChannelId } = args
	const research = await collectNewsSignals({
		agent,
		org,
		teamId,
		botToken,
		dmChannelId,
		ownerUserId: args.ownerUserId,
		ownerSlackUserId: args.ownerSlackUserId,
		focus: args.focus ?? null,
		traceId: args.traceId,
		env,
	})
	const signals = research.signals
	const now = Date.now()
	const brief: NewsBrief = {
		id: generateId(),
		userId: args.ownerUserId,
		orgId: org.id,
		teamId,
		dmChannelId,
		signals,
		createdAt: now,
		updatedAt: now,
	}
	saveNewsBrief(agent, brief)
	captureContentEvent({
		event: "content_news_scan",
		orgId: org.id,
		userId: args.ownerUserId,
		briefId: brief.id,
		signals: signals.length,
	})
	if (!signals.length) {
		// A sweep that ran out of time is a fault, not an answer. Say so, and
		// fall back to the deterministic tier so the operator still gets
		// something real instead of a silence that looks like "no news".
		if (research.status === "failed") {
			const { runAlertWatch } = await import("./alerts")
			const watch = await runAlertWatch({
				agent,
				env,
				org,
				teamId,
				botToken,
				dmChannelId,
				ownerUserId: args.ownerUserId,
				ownerSlackUserId: args.ownerSlackUserId,
				traceId: args.traceId,
			})
			await postSlackMessage(
				botToken,
				dmChannelId,
				`📰 The news sweep didn't finish in time (${Math.round(research.ms / 1000)}s), so I checked the alert feeds instead: ${watch.new} item(s) worth a look. Any story I missed is a story you'll get tomorrow — say "run the news" again if you want the sweep retried.`,
			)
			return
		}
		await postSlackMessage(
			botToken,
			dmChannelId,
			"📰 News Brief — nothing this week cleared the filter. No story changed a decision, cost, risk or deadline for our audience, or none of them had an honest product hook. That is a useful answer: it means there is no news post to make this week.",
		)
		return
	}
	const ts = await postNewsBrief(botToken, dmChannelId, brief)
	console.log(
		`[company-brain] content-news posted org=${org.id} signals=${signals.length} ts=${ts ?? "-"}`,
	)
}

export type ContentNewsInteraction = {
	teamId: string
	slackUserId: string
	briefId: string
	signalId: string
	action: "tof" | "mof" | "skip"
	responseUrl?: string
	cardChannel?: string
	cardTs?: string
}

export async function respondNews(
	responseUrl: string | undefined,
	text: string,
	blocks?: unknown[],
): Promise<void> {
	if (!responseUrl) return
	await updateSlackInteractionResponse(responseUrl, {
		text,
		blocks,
		replaceOriginal: true,
	})
}

/**
 * A signal was turned into a post, or skipped.
 *
 * Drafting hands the signal to the same Content Studio round the operator
 * already uses, so the post still arrives as a review card with Push, Remix
 * and Dismiss. The news desk decides what is worth saying; it never
 * publishes.
 */
export async function runContentNewsInteraction(args: {
	agent: CompanyBrainAgent
	env: Env
	interaction: ContentNewsInteraction
	/** The workspace the operator is acting in. */
	org: SlackOrg
	botToken: string
	/** The automation the drafts belong to, so the queue stays one queue. */
	automationId: string
}): Promise<void> {
	const { agent, env, interaction, org, botToken, automationId } = args
	const brief = getNewsBrief(agent, interaction.briefId)
	if (!brief) {
		await respondNews(interaction.responseUrl, "That news brief is gone.")
		return
	}
	const signal = brief.signals.find((s) => s.id === interaction.signalId)
	if (!signal) {
		await respondNews(interaction.responseUrl, "That signal is gone.")
		return
	}
	if (interaction.action === "skip") {
		signal.status = "skipped"
		saveNewsBrief(agent, brief)
		captureContentEvent({
			event: "content_news_signal_skipped",
			orgId: brief.orgId,
			userId: brief.userId,
			briefId: brief.id,
			signalId: signal.id,
		})
		const { text, blocks } = buildNewsBriefBlocks(brief)
		await respondNews(interaction.responseUrl, text, blocks)
		return
	}
	const funnel = interaction.action === "tof" ? "TOF" : "MOF"
	signal.status = "drafting"
	saveNewsBrief(agent, brief)
	const { runContentStudio } = await import("./generate")
	const runTraceId = generateId()
	agent.waitUntil(
		runContentStudio({
			agent,
			org,
			teamId: interaction.teamId,
			botToken,
			dmChannelId: brief.dmChannelId ?? "",
			ownerUserId: brief.userId,
			ownerSlackUserId: interaction.slackUserId,
			automationId,
			instruction: newsSignalBrief(signal, funnel),
			runTraceId,
			runTrigger: "run_now",
			env,
		}).catch((err) => {
			console.error(
				`[company-brain] content-news draft failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		}),
	)
	await respondNews(
		interaction.responseUrl,
		`Drafting the ${funnel} post now — the review card will land in your DM.`,
	)
}
