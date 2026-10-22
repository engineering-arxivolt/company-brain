/**
 * Content Studio button handling.
 *
 * Push: claim the draft, create the post on the operator's Buffer connection
 * (draft-first, schema-adaptive — see buffer.ts), settle, rebuild the card.
 * Remix: claim, write one fresh take on the same recipe (re-resolving a
 * Buffer channel when the draft never got one), settle, rebuild the card.
 * Dismiss: settle it out of the way.
 *
 * Every response replaces the original message with blocks rebuilt from the
 * stored rows, so the card can never drift from the real draft state.
 */
import { generateId } from "@repo/lib/generate-id"
import { decryptToken } from "@/lib/crypto"
import { captureContentEvent } from "@/lib/posthog"
import { getAutomation, listAutomations } from "../tools/automations"
import {
	lookupSlackUserInfo,
	updateSlackInteractionResponse,
} from "../slack/client"
import {
	getOrgActorBySlackIdentity,
	getWorkspaceByTeamId,
	type SlackOrg,
} from "../slack/workspace"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import {
	findBufferConnection,
	listBufferChannels,
	pushDraftToBuffer,
} from "./buffer"
import { buildContentRoundBlocks } from "./cards"
import { writeContentDraftTurn } from "./generate"
import { pushContentDraftToBuffer } from "./push"
import {
	respondNews,
	runContentNewsInteraction as runNewsInteraction,
	type ContentNewsInteraction,
} from "./news"
import {
	claimContentDraft,
	dismissContentDraft,
	draftFacts,
	draftLink,
	failContentRemix,
	finishContentPush,
	finishContentRemix,
	getContentDraft,
	listDraftsForRound,
	listRecentDrafts,
} from "./store"
import { channelLabelFor, type ContentChannelRef } from "./voice"

export type SlackContentDraftInteraction = {
	teamId: string
	slackUserId: string
	draftId: string
	action: "push" | "remix" | "dismiss"
	responseUrl?: string
	cardChannel?: string
	cardTs?: string
}

type VerifiedSlackActor = {
	org: SlackOrg
	botToken: string
	actor: { userId: string; isAdmin: boolean }
}

async function respond(
	responseUrl: string | undefined,
	text: string,
	options?: { blocks?: unknown[]; replaceOriginal?: boolean },
): Promise<void> {
	if (!responseUrl) return
	await updateSlackInteractionResponse(responseUrl, {
		text,
		blocks: options?.blocks,
		replaceOriginal: options?.replaceOriginal,
		responseType: options?.replaceOriginal ? undefined : "ephemeral",
	})
}

async function verifiedActor(
	agent: CompanyBrainAgent,
	teamId: string,
	slackUserId: string,
): Promise<VerifiedSlackActor | null> {
	const env = brainAgent(agent).env
	const workspace = await getWorkspaceByTeamId(env, teamId)
	if (!workspace || workspace.orgId !== agent.name) return null
	const botToken = await decryptToken(
		workspace.botTokenEnc,
		env.ENCRYPTION_SECRET,
	)
	const profile = await lookupSlackUserInfo(botToken, slackUserId)
	if (!profile.ok) return null
	const resolution = await getOrgActorBySlackIdentity(env, {
		orgId: workspace.orgId,
		teamId,
		slackUserId,
		email: profile.user.email,
	})
	if (!resolution.actor) return null
	return {
		org: {
			id: workspace.orgId,
			name: workspace.orgName,
			slug: workspace.orgSlug,
			metadata: workspace.orgMetadata,
		},
		botToken,
		actor: resolution.actor,
	}
}

/**
 * A news signal was drafted, or skipped.
 *
 * The draft goes through the same Content Studio round the operator already
 * uses, so the post arrives as a review card with Push, Remix and Dismiss:
 * the news desk decides what is worth saying, the operator decides what ships.
 */
export async function runContentNewsInteraction(
	agent: CompanyBrainAgent,
	interaction: ContentNewsInteraction,
): Promise<void> {
	const verified = await verifiedActor(
		agent,
		interaction.teamId,
		interaction.slackUserId,
	)
	if (!verified) {
		await respondNews(interaction.responseUrl, "I couldn't verify who you are.")
		return
	}
	const env = brainAgent(agent).env
	const automations = listAutomations(agent, {
		userId: verified.actor.userId,
		isAdmin: verified.actor.isAdmin,
	})
	const content = automations.find((a) => a.mode === "content")
	const automationId = content?.id ?? `content-studio-${verified.org.id}`
	await runNewsInteraction({
		agent,
		env,
		interaction,
		org: verified.org,
		botToken: verified.botToken,
		automationId,
	})
}

export async function runContentDraftInteraction(
	agent: CompanyBrainAgent,
	interaction: SlackContentDraftInteraction,
): Promise<void> {	const draft = getContentDraft(agent, interaction.draftId)
	if (!draft || draft.teamId !== interaction.teamId) {
		await respond(interaction.responseUrl, "That content draft is unavailable.")
		return
	}
	const verified = await verifiedActor(
		agent,
		interaction.teamId,
		interaction.slackUserId,
	)
	if (
		!verified ||
		(draft.ownerSlackUserId !== null &&
			draft.ownerSlackUserId !== interaction.slackUserId) ||
		(draft.ownerUserId !== null &&
			draft.ownerUserId !== verified.actor.userId)
	) {
		await respond(
			interaction.responseUrl,
			"Only the owner of these drafts can push, remix, or dismiss them.",
		)
		return
	}
	const env = brainAgent(agent).env
	const ownerUserId = draft.ownerUserId ?? verified.actor.userId

	const rebuild = async (note?: string) => {
		const [round, connection] = await Promise.all([
			Promise.resolve(listDraftsForRound(agent, draft.roundId)),
			findBufferConnection(env, verified.org.id, ownerUserId).catch(
				() => null,
			),
		])
		return buildContentRoundBlocks(round, {
			bufferConnected: Boolean(connection),
			note,
		})
	}

	if (interaction.action === "dismiss") {
		const dismissed = dismissContentDraft(agent, draft.id)
		captureContentEvent({
			event: "content_draft_dismissed",
			orgId: verified.org.id,
			userId: ownerUserId,
			draftId: draft.id,
			kind: draft.kind,
			channel: draft.channelService,
		})
		const { blocks } = await rebuild()
		await respond(
			interaction.responseUrl,
			dismissed ? "Dismissed." : "That draft was already handled.",
			{ blocks, replaceOriginal: true },
		)
		return
	}

	if (interaction.action === "push") {
		// The click is the approval: this is the one intentional Buffer write.
		const outcome = await pushContentDraftToBuffer({
			env,
			agent,
			org: verified.org,
			ownerUserId,
			draft,
		})
		const { blocks } = await rebuild()
		await respond(interaction.responseUrl, outcome.message, {
			blocks,
			replaceOriginal: true,
		})
		return
	}

	if (interaction.action !== "remix") {
		await respond(interaction.responseUrl, "Unsupported action.")
		return
	}

	// Remix: one fresh take on the same recipe, same channel.
	const claimed = claimContentDraft(agent, draft.id, "remixing")
	if (!claimed) {
		const { blocks } = await rebuild()
		await respond(
			interaction.responseUrl,
			"That draft is already being handled.",
			{ blocks, replaceOriginal: true },
		)
		return
	}
	let channel: ContentChannelRef | null = draft.channelId
		? {
				id: draft.channelId,
				service: draft.channelService ?? "social",
				name: draft.channelLabel ?? "",
			}
		: null
	let channelOverride: {
		channelId: string
		channelService: string
		channelLabel: string
	} | null = null
	if (!channel) {
		// The draft never got a channel (Buffer was unreachable when it was
		// written); try again now and pin the target so Push works after.
		const connection = await findBufferConnection(
			env,
			verified.org.id,
			ownerUserId,
		).catch(() => null)
		if (connection) {
			const channels = await listBufferChannels(env, connection)
			if (channels.length) {
				const round = listDraftsForRound(agent, draft.roundId)
				const index = Math.max(
					0,
					round.findIndex((d) => d.id === draft.id),
				)
				const picked = channels[index % channels.length] ?? channels[0]
				if (picked) {
					channel = {
						id: picked.id,
						service: picked.service,
						name: picked.name,
					}
					channelOverride = {
						channelId: picked.id,
						channelService: picked.service,
						channelLabel: channelLabelFor(picked) ?? picked.service,
					}
				}
			}
		}
	}
	const recentBodies = listRecentDrafts(agent, draft.automationId, {
		limit: 24,
	})
		.filter((d) => d.id !== draft.id)
		.map((d) => d.body)
	const automation = getAutomation(agent, draft.automationId)
	const remixTraceId = generateId()
	// A remix is a different take on the same post, so it runs against the
	// same facts: the evidence was what made the first version checkable, and
	// a fresh investigation would move the ground under it.
	const storedFacts = draftFacts(draft)
	const evidence = storedFacts.length
		? {
				kind: draft.kind,
				why: "the same facts, a genuinely different take",
				facts: storedFacts.map((fact, index) => ({
					id: fact.id ?? `F${index + 1}`,
					claim: fact.claim ?? "",
					source: fact.source ?? "",
					...(fact.quote ? { quote: fact.quote } : {}),
				})),
			}
		: null
	const result = await writeContentDraftTurn({
		agent,
		org: verified.org,
		teamId: interaction.teamId,
		botToken: verified.botToken,
		dmChannelId:
			draft.dmChannelId ?? interaction.cardChannel ?? verified.org.id,
		ownerUserId,
		ownerSlackUserId: draft.ownerSlackUserId ?? interaction.slackUserId,
		kind: draft.kind,
		funnel: draft.funnel,
		vehicle: draft.vehicle,
		channel,
		focus: automation?.prompt ?? null,
		recentBodies,
		previousAttempt: draft.body,
		evidence,
		traceId: remixTraceId,
		runTrigger: "run_now",
		env,
	})
	if (result.ok) {
		finishContentRemix(agent, draft.id, {
			body: result.body,
			sourcesJson: result.sourcesJson,
			flagsJson: result.flagsJson,
			traceId: remixTraceId,
			channelId: channelOverride?.channelId ?? null,
			channelService: channelOverride?.channelService ?? null,
			channelLabel: channelOverride?.channelLabel ?? null,
		})
	} else {
		failContentRemix(agent, draft.id, `remix failed (${result.reason})`)
	}
	const { blocks } = await rebuild()
	await respond(
		interaction.responseUrl,
		result.ok
			? "Remixed — fresh take above."
			: "I couldn't rewrite it just now — try again in a minute.",
		{ blocks, replaceOriginal: true },
	)
}
