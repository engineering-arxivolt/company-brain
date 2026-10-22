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
import { captureContentEvent } from "@/lib/posthog"
import { splitCitedSources, stripScaffolding } from "../auto-research/draft"
import { toolProducesEvidence } from "../observability"
import { postSlackMessage } from "../slack/client"
import { recordMessageTrace } from "../slack/message-trace"
import type { SlackOrg } from "../slack/workspace"
import { computeTurn, EMPTY_REPLY } from "../turn/compute"
import type { CompanyBrainAgent } from "../turn/agent"
import {
	angleForKind,
	buildBriefEvidence,
	collectContentEvidence,
	EMPTY_EVIDENCE,
	parseUsedFactIds,
	type ContentAngle,
} from "./evidence"
import { loadFounderBrief } from "./founder-brain"
import { mapWithConcurrency } from "./concurrency"
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
	startContentRound,
	supersedePendingDrafts,
	sweepStaleContentDrafts,
	updateContentRound,
} from "./store"
import {
	buildContentFrame,
	channelLabelFor,
	type ContentChannelRef,
	serviceProfile,
	socialStyle,
} from "./voice"
import type { ContentDraftKind } from "./store"
import type { ContentFunnel, ContentVehicle } from "./taxonomy"

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
	/** Scheduled rounds and on-demand rounds are told apart in telemetry. */
	runTrigger?: "scheduled" | "run_now"
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
	/** Optional overrides; the kind's defaults fill them in. */
	funnel?: ContentFunnel | null
	vehicle?: ContentVehicle | null
	channel: ContentChannelRef | null
	focus?: string | null
	recentBodies?: string[]
	previousAttempt?: string | null
	/** Preloaded by the round; falls back to a read when omitted. */
	founderBrief?: string | null
	/**
	 * The evidence for this draft: what happened, and where it came from.
	 * Without it the writing turn investigates on its own, which costs one
	 * lookup per draft and leaves the operator with nothing to check.
	 */
	evidence?: ContentAngle | null
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
	const founderBrief =
		args.founderBrief ?? loadFounderBrief(agent, args.ownerUserId)
	const frame = buildContentFrame({
		kind: args.kind,
		channel: args.channel,
		funnel: args.funnel,
		vehicle: args.vehicle,
		founderBrief,
		focus: args.focus,
		recentBodies: args.recentBodies,
		previousAttempt: args.previousAttempt,
		evidence: args.evidence ?? null,
	})
	const startedAt = Date.now()
	const grounded = Boolean(args.evidence?.facts.length)
	// A draft with a fact packet can write from it directly; one without has to
	// investigate, which is why it gets a larger step and time budget. Neither
	// is allowed to run indefinitely on a free model.
	//
	// The budget is sized from measured runs, not from hope: on the free
	// models a grounded turn takes 90-180s and an investigating turn longer
	// still. A 120s cap dropped three drafts in a row on a round where the
	// one survivor took 92s.
	const stepLimit = grounded ? 4 : 8
	const turnTimeoutMs = grounded ? 240_000 : 300_000
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
			stepLimit,
			options: {
				abortSignal: AbortSignal.timeout(turnTimeoutMs),
				// A draft with a fact packet writes from that packet. Handing
				// the model thirty tool schemas it does not need is what made
				// these turns take minutes and then time out.
				toolPolicy: grounded ? "none" : "full",
			},
			obs: {
				traceId: args.traceId,
				source: "content_studio",
				runTrigger: args.runTrigger,
			},
			env: args.env,
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.warn(
			`[company-brain] content-studio turn failed org=${org.id} kind=${args.kind}: ${message}`,
		)
		if (/abort|timed out|timeout/i.test(message)) {
			return { ok: false, reason: "turn_timed_out" }
		}
	}
	const elapsedMs = Date.now() - startedAt
	if (!out || out.status !== "completed")
		return { ok: false, reason: `turn_${out?.status ?? "error"}` }
	console.log(
		`[company-brain] content-studio turn done org=${org.id} kind=${args.kind} grounded=${grounded} status=ok ms=${elapsedMs}`,
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
	// The facts the post actually leaned on. A draft written from the
	// evidence packet must name the facts it used, so the card can show the
	// operator exactly what backs it instead of a vague "grounded in GitHub".
	const usedFactIds = parseUsedFactIds(out.reply)
	const angle = args.evidence ?? null
	const facts = angle
		? angle.facts.filter((fact) => usedFactIds.includes(fact.id))
		: []
	if (angle && angle.facts.length > 0 && facts.length === 0)
		flags.push("named no facts from the evidence packet")
	const sourcesJson = JSON.stringify({
		cited: cited.slice(0, 8),
		tools: [...new Set(trace.map((entry) => entry.tool))].slice(0, 10),
		...(facts.length
			? {
					facts: facts.map((fact) => ({
						id: fact.id,
						claim: fact.claim,
						source: fact.source,
						...(fact.quote ? { quote: fact.quote } : {}),
						...(fact.url ? { url: fact.url } : {}),
					})),
				}
			: {}),
	})
	return { ok: true, body, sourcesJson, flagsJson: JSON.stringify(flags.slice(0, 4)) }
}

/**
 * Run a round and make a failure visible.
 *
 * A round is a background task, so an exception that only reaches the worker
 * log is indistinguishable from "still working" to the person waiting for a
 * card. The wrapper posts the failure into the same DM the card would use,
 * then rethrows nothing: the round is already over.
 */
export async function runContentStudio(args: ContentStudioArgs): Promise<void> {
	try {
		await runContentStudioInner(args)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error(
			`[company-brain] content-studio round failed trace=${args.runTraceId} org=${args.org.id}: ${message}`,
		)
		try {
			updateContentRound(args.agent, args.runTraceId, {
				status: "failed",
				error: message,
			})
		} catch (storeErr) {
			console.error(
				`[company-brain] content-studio round status write failed: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`,
			)
		}
		try {
			await postSlackMessage(
				args.botToken,
				args.dmChannelId,
				`🧵 Content round failed: ${message}. Nothing was published.`,
			)
		} catch (postErr) {
			console.error(
				`[company-brain] content-studio failure notice failed: ${postErr instanceof Error ? postErr.message : String(postErr)}`,
			)
		}
	}
}

async function runContentStudioInner(args: ContentStudioArgs): Promise<void> {
	const { agent, org } = args
	const runTrigger = args.runTrigger ?? "scheduled"
	console.log(
		`[company-brain] content-studio round start trace=${args.runTraceId} org=${org.id} trigger=${runTrigger} drafts=${MAX_CONTENT_DRAFTS_PER_RUN} brief="${args.instruction.replace(/\s+/g, " ").trim().slice(0, 200)}"`,
	)
	startContentRound(agent, {
		id: args.runTraceId,
		automationId: args.automationId,
		teamId: args.teamId,
		ownerUserId: args.ownerUserId,
		trigger: runTrigger,
		brief: args.instruction,
	})
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
	// Read once per round: the evidence turn and every writing turn share the
	// same snapshot, so a founder edit mid-round cannot split the voice.
	const founderBrief = loadFounderBrief(agent, args.ownerUserId)

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

	// The evidence stage: one read-only turn per round that works out what
	// actually happened and hands every draft the same packet. One lookup per
	// round instead of one per draft, and every claim in a post traceable to
	// something the operator can check.
	//
	// A substantial brief replaces the research. The operator has already
	// written the story down — dates, names, numbers — and a research turn
	// over it spent four minutes and returned nothing, every time. The brief
	// is labelled as the source on the card, so nothing pretends to be
	// verified that is not.
	const briefIsSpecific = args.instruction.trim().length >= 200
	const packet = briefIsSpecific
		? EMPTY_EVIDENCE
		: await collectContentEvidence({
				agent,
				org,
				teamId: args.teamId,
				botToken: args.botToken,
				dmChannelId: args.dmChannelId,
				ownerUserId: args.ownerUserId,
				ownerSlackUserId: args.ownerSlackUserId,
				instruction: args.instruction,
				recentKinds,
				channels,
				founderBrief,
				traceId: args.runTraceId,
				env: args.env,
			})

	const plan = planDailyDrafts({
		dayOfWeek: new Date().getUTCDay(),
		recentKinds,
		channels,
		count: MAX_CONTENT_DRAFTS_PER_RUN,
		angles: packet.angles,
	})

	// A timed-out evidence turn is not the same as a quiet day. The operator's
	// brief is still a real source, and using it here prevents each writing
	// turn from starting its own multi-minute investigation.
	const evidence =
		packet.facts.length > 0
			? packet
			: buildBriefEvidence(
					args.instruction,
					plan.map((planned) => planned.kind),
				)
	const usingBrief = evidence !== packet && evidence.facts.length > 0
	if (usingBrief)
		console.log(
			`[company-brain] content-studio using operator brief as evidence trace=${args.runTraceId} org=${org.id} drafts=${plan.length} briefSpecific=${briefIsSpecific}`,
		)
	updateContentRound(agent, args.runTraceId, { status: "writing" })
	if (plan.length) {
		const progress = usingBrief
			? briefIsSpecific
				? `🧵 Writing ${plan.length} draft(s) from your brief and the Founder Brain. Each card marks the brief as the source.`
				: `🧵 The evidence lookup ran long, so I'm writing ${plan.length} draft(s) from your brief and the Founder Brain. Each card marks the brief as the source.`
			: evidence.facts.length > 0
				? `🧵 Evidence in: ${evidence.angles.length} angle(s), ${evidence.facts.length} fact(s). Writing ${plan.length} draft(s) now — usually a few minutes on the current models.`
				: `🧵 Nothing concrete came back from the evidence lookup. Writing ${plan.length} draft(s) from the weekday plan now.`
		await postSlackMessage(args.botToken, args.dmChannelId, progress).catch(
			(err) => {
				console.warn(
					`[company-brain] content-studio progress notice failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			},
		)
	}

	const drafts: NewContentDraft[] = []
	let dropped = 0
	const dropReasons: string[] = []
	// Two drafts at a time. One at a time made a four-draft round take as long
	// as the slowest turn times four; four at a time risks the free model
	// rate limit, which is how a round loses every draft at once.
	const results = await mapWithConcurrency(plan, 2, async (planned) => {
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
			funnel: planned.funnel,
			vehicle: planned.vehicle,
			channel: planned.channel,
			focus: args.instruction,
			recentBodies,
			founderBrief,
			evidence: angleForKind(evidence, planned.kind),
			traceId: draftTraceId,
			runTrigger,
			env: args.env,
		})
		return { planned, draftTraceId, result }
	})
	for (const { planned, draftTraceId, result } of results) {
		if (!result.ok) {
			dropped++
			dropReasons.push(result.reason)
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
			funnel: planned.funnel,
			vehicle: planned.vehicle,
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
				evidenceFacts: evidence.facts.length,
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
			updateContentRound(agent, args.runTraceId, {
				status: "posted",
				drafts: drafts.length,
			})
			captureContentEvent({
				event: "content_round",
				orgId: org.id,
				userId: args.ownerUserId,
				roundId: args.runTraceId,
				drafts: drafts.length,
				dropped,
				angles: evidence.angles.length,
				facts: evidence.facts.length,
				bufferConnected: Boolean(connection),
				funnelMix: drafts.reduce<Record<string, number>>((mix, draft) => {
					mix[draft.funnel ?? "MOF"] = (mix[draft.funnel ?? "MOF"] ?? 0) + 1
					return mix
				}, {}),
				vehicleMix: drafts.reduce<Record<string, number>>((mix, draft) => {
					mix[draft.vehicle ?? "story"] =
						(mix[draft.vehicle ?? "story"] ?? 0) + 1
					return mix
				}, {}),
			})
			return
		}

		// A quiet day is said out loud rather than going silent — this DM is
		// expected daily, and a missing one reads as a bug. A round that lost
		// its drafts to a timeout says so: that is a fault of the models, not
		// of the day, and it needs a different answer from the operator.
		const timedOut = dropReasons.filter((r) => r === "turn_timed_out").length
		const reason =
			timedOut > 0
				? `${timedOut} of ${dropped} writing turn(s) ran out of time on the current models — nothing was published. Ask for another round, or send a shorter brief.`
				: dropped > 0
					? "today's passes didn't clear the bar"
					: evidence.facts.length > 0
						? "the evidence didn't support a post worth publishing"
						: "nothing concrete turned up in the last 24 hours"
		const text = `🧵 Daily content — no drafts today: ${reason}. I'll take another pass tomorrow.`
		const ts = await postSlackMessage(args.botToken, args.dmChannelId, text)
		if (ts) recordMessageTrace(agent, args.dmChannelId, ts, args.runTraceId)
		console.log(
			`[company-brain] content-studio empty round org=${org.id} dropped=${dropped}`,
		)
		updateContentRound(agent, args.runTraceId, {
			status: "empty",
			drafts: 0,
			error: reason,
		})
	} catch (err) {
		console.error(
			`[company-brain] content-studio delivery failed org=${org.id}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
}
