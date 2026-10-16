/**
 * The daily Content Studio run.
 *
 * Fires from a content-mode automation (see tools/automations.ts) and turns
 * the last day of company progress into a small set of post-ready drafts:
 *
 *   1. Ground + plan  — read recent drafts (anti-repetition), resolve the
 *      owner's Buffer connection and channels, pick today's mix.
 *   2. Write          — one ephemeral agent turn per draft (writeContentDraftTurn),
 *      so each post can investigate with the full tool set (memory, Slack,
 *      connected apps); the reply is then cleaned into post text.
 *   3. Deliver        — one review DM: per-draft Push to Buffer / Remix /
 *      Dismiss. Older pending drafts are superseded so the DM stays current.
 *
 * Nothing here publishes: pushes happen only from an explicit button click
 * (interactions.ts) and land in Buffer as drafts or queue entries.
 */
import { generateId } from "@repo/lib/generate-id"
import { splitCitedSources, stripScaffolding } from "../auto-research/draft"
import { toolProducesEvidence } from "../observability"
import { postSlackMessage } from "../slack/client"
import { recordMessageTrace } from "../slack/message-trace"
import type { SlackOrg } from "../slack/workspace"
import { computeTurn, EMPTY_REPLY } from "../turn/compute"
import type { CompanyBrainAgent } from "../turn/agent"
import type { ContentChannel } from "./plan"
import { planDailyDrafts } from "./plan"
import { buildContentRoundBlocks } from "./cards"
import { findBufferConnection, listBufferChannels } from "./buffer"
import {
	ensureContentDraftTable,
	insertContentDraft,
	listDraftsForRound,
	listRecentDrafts,
	type NewContentDraft,
	supersedePendingDrafts,
	sweepStaleContentDrafts,
} from "./store"
import {
	buildContentFrame,
	channelLabelFor,
	type ContentChannelRef,
	serviceProfile,
	socialStyle,
} from "./voice"
import type { ContentDraftKind } from "./store"

// A hard ceiling even if a future planner asks for more.
export const MAX_CONTENT_DRAFTS_PER_RUN = 4

const NOTHING_NEW = "NOTHING_NEW"

export type ContentStudioArgs = {
	agent: CompanyBrainAgent
	org: SlackOrg
	teamId: string
	botToken: string
	/** The operator's DM with the brain: where drafts are posted. */
	dmChannelId: string
	ownerUserId: string
	ownerSlackUserId?: string
	automationId: string
	/** The automation prompt: operator steering for the batch. */
	instruction: string
	/** One id shared by every draft of this round. */
	runTraceId: string
	env: Env
}

export type ContentDraftTurnArgs = {
	agent: CompanyBrainAgent
	org: SlackOrg
	teamId: string
	botToken: string
	dmChannelId: string
	ownerUserId: string
	ownerSlackUserId?: string
	kind: ContentDraftKind
	channel: ContentChannelRef | null
	focus?: string | null
	recentBodies?: string[]
	previousAttempt?: string | null
	traceId: string
	runTrigger: "scheduled" | "run_now"
	env: Env
}

export type ContentDraftTurnResult =
	| { ok: true; body: string; sourcesJson: string; flagsJson: string }
	| { ok: false; reason: string }

/**
 * One post = one full ephemeral turn. Read-only, nothing delivered; the reply
 * is split into post text + sources, tidied, and flagged for review.
 */
export async function writeContentDraftTurn(
	args: ContentDraftTurnArgs,
): Promise<ContentDraftTurnResult> {
	const { agent, org } = args
	const frame = buildContentFrame({
		kind: args.kind,
		channel: args.channel,
		focus: args.focus,
		recentBodies: args.recentBodies,
		previousAttempt: args.previousAttempt,
	})
	const startedAt = Date.now()
	let out: Awaited<ReturnType<typeof computeTurn>> | null = null
	try {
		out = await computeTurn({
			agent,
			org,
			userId: args.ownerUserId,
			actor: {
				orgId: org.id,
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
			// Same posture as every scheduled run: read-only, no leases.
			scheduledRun: true,
			skipBilling: true,
			// Nobody waits on these; a round is serial, so drop one notch of
			// reasoning effort rather than sit at main-turn latency.
			effortOverride: "medium",
			ephemeral: true,
			obs: {
				traceId: args.traceId,
				source: "content_studio",
				runTrigger: args.runTrigger,
			},
			env: args.env,
		})
	} catch (err) {
		console.warn(
			`[company-brain] content-studio turn failed org=${org.id} kind=${args.kind}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	const elapsedMs = Date.now() - startedAt
	if (!out || out.status !== "completed")
		return { ok: false, reason: `turn_${out?.status ?? "error"}` }
	console.log(
		`[company-brain] content-studio turn done org=${org.id} kind=${args.kind} status=ok ms=${elapsedMs}`,
	)
	if (out.reply.toUpperCase().includes(NOTHING_NEW))
		return { ok: false, reason: "nothing_to_say" }
	const { body: rawBody, cited } = splitCitedSources(out.reply)
	const body = socialStyle(stripScaffolding(rawBody))
	if (!body || rawBody.trim() === EMPTY_REPLY)
		return { ok: false, reason: "empty_body" }
	const flags: string[] = []
	const limit = args.channel ? serviceProfile(args.channel.service).limit : 2000
	if (body.length > limit)
		flags.push(
			`${body.length} characters — over the ${limit} limit for this platform`,
		)
	const trace = out.toolTrace ?? []
	if (!trace.some((entry) => toolProducesEvidence(entry.tool)))
		flags.push("no tool evidence behind this one, read it extra carefully")
	const sourcesJson = JSON.stringify({
		cited: cited.slice(0, 8),
		tools: [...new Set(trace.map((entry) => entry.tool))].slice(0, 10),
	})
	return { ok: true, body, sourcesJson, flagsJson: JSON.stringify(flags.slice(0, 4)) }
}

export async function runContentStudio(args: ContentStudioArgs): Promise<void> {
	const { agent, org } = args
	ensureContentDraftTable(agent)
	const swept = sweepStaleContentDrafts(agent)
	if (swept)
		console.log(
			`[company-brain] content-studio swept ${swept} stale claim(s) org=${org.id}`,
		)

	// Anti-repetition: the last week of drafts feeds every frame.
	const recent = listRecentDrafts(agent, args.automationId, { limit: 24 })
	const recentBodies = recent.map((d) => d.body)
	const recentKinds = recent.slice(0, 6).map((d) => d.kind)

	// Buffer, best effort: no connection is still a working mode (drafts are
	// written, just not channel-targeted or pushable).
	const connection = await findBufferConnection(
		args.env,
		org.id,
		args.ownerUserId,
	).catch((err) => {
		console.warn(
			`[company-brain] content-studio buffer lookup failed: ${err instanceof Error ? err.message : String(err)}`,
		)
		return null
	})
	let channels: ContentChannel[] = []
	let bufferNote: string | undefined
	if (connection) {
		channels = await listBufferChannels(args.env, connection)
		if (!channels.length)
			bufferNote =
				"Couldn't read your Buffer channels today, so these drafts aren't channel-targeted — Remix will re-target them once Buffer is reachable."
	}

	const plan = planDailyDrafts({
		dayOfWeek: new Date().getUTCDay(),
		recentKinds,
		channels,
		count: MAX_CONTENT_DRAFTS_PER_RUN,
	})

	const drafts: NewContentDraft[] = []
	let dropped = 0
	for (const planned of plan) {
		const draftTraceId = generateId()
		const result = await writeContentDraftTurn({
			agent,
			org,
			teamId: args.teamId,
			botToken: args.botToken,
			dmChannelId: args.dmChannelId,
			ownerUserId: args.ownerUserId,
			ownerSlackUserId: args.ownerSlackUserId,
			kind: planned.kind,
			channel: planned.channel,
			focus: args.instruction,
			recentBodies,
			traceId: draftTraceId,
			runTrigger: "scheduled",
			env: args.env,
		})
		if (!result.ok) {
			dropped++
			console.log(
				`[company-brain] content-studio draft dropped org=${org.id} kind=${planned.kind} reason=${result.reason}`,
			)
			continue
		}
		drafts.push({
			automationId: args.automationId,
			roundId: args.runTraceId,
			teamId: args.teamId,
			ownerUserId: args.ownerUserId,
			ownerSlackUserId: args.ownerSlackUserId ?? null,
			dmChannelId: args.dmChannelId,
			kind: planned.kind,
			channelId: planned.channel?.id ?? null,
			channelService: planned.channel?.service ?? null,
			channelLabel: channelLabelFor(planned.channel),
			body: result.body,
			sourcesJson: result.sourcesJson,
			flagsJson: result.flagsJson,
			traceId: draftTraceId,
		})
		console.log(
			`[company-brain] content-studio draft ready org=${org.id} kind=${planned.kind} chars=${result.body.length}`,
		)
	}

	try {
		if (drafts.length) {
			const saved = drafts.map((d) => insertContentDraft(agent, d))
			// A fresh round replaces leftovers: older pending drafts are skipped
			// so the DM never grows into a pile of stale buttons.
			const superseded = supersedePendingDrafts(
				agent,
				args.automationId,
				saved.map((d) => d.id),
			)
			if (superseded)
				console.log(
					`[company-brain] content-studio superseded ${superseded} older draft(s) org=${org.id}`,
				)
			const round = listDraftsForRound(agent, args.runTraceId)
			const { text, blocks } = buildContentRoundBlocks(round, {
				bufferConnected: Boolean(connection),
				note: bufferNote,
			})
			const ts = await postSlackMessage(
				args.botToken,
				args.dmChannelId,
				text,
				undefined,
				blocks,
			)
			if (ts) {
				recordMessageTrace(agent, args.dmChannelId, ts, args.runTraceId)
				console.log(
					`[company-brain] content-studio posted org=${org.id} drafts=${drafts.length} dropped=${dropped} ts=${ts}`,
				)
			}
			return
		}

		// A quiet day is said out loud rather than going silent — this DM is
		// expected daily, and a missing one reads as a bug.
		const reason =
			dropped > 0
				? "today's passes didn't clear the bar"
				: "nothing concrete turned up in the last 24 hours"
		const text = `🧵 Daily content — no drafts today: ${reason}. I'll take another pass tomorrow.`
		const ts = await postSlackMessage(args.botToken, args.dmChannelId, text)
		if (ts) recordMessageTrace(agent, args.dmChannelId, ts, args.runTraceId)
		console.log(
			`[company-brain] content-studio empty round org=${org.id} dropped=${dropped}`,
		)
	} catch (err) {
		console.error(
			`[company-brain] content-studio delivery failed org=${org.id}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}
