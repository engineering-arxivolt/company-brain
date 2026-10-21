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
import { getAutomation } from "../tools/automations"
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

export async function runContentDraftInteraction(
	agent: CompanyBrainAgent,
	interaction: SlackContentDraftInteraction,
): Promise<void> {
	const draft = getContentDraft(agent, interaction.draftId)
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
		if (!draft.channelId) {
			const { blocks } = await rebuild()
			await respond(
				interaction.responseUrl,
				"This draft isn't targeted at a Buffer channel yet — hit Remix first.",
				{ blocks, replaceOriginal: true },
			)
			return
		}
		const claimed = claimContentDraft(agent, draft.id, "pushing")
		if (!claimed) {
			const { blocks } = await rebuild()
			await respond(
				interaction.responseUrl,
				"That draft is already being handled.",
				{ blocks, replaceOriginal: true },
			)
			return
		}
		const connection = await findBufferConnection(
			env,
			verified.org.id,
			ownerUserId,
		).catch(() => null)
		if (!connection) {
			finishContentPush(agent, draft.id, {
				ok: false,
				error: "no Buffer connection found",
			})
			const { blocks } = await rebuild()
			await respond(
				interaction.responseUrl,
				"There's no Buffer connection I can use — connect Buffer under Settings → Connectors, then push again.",
				{ blocks, replaceOriginal: true },
			)
			return
		}
		// The click is the approval: this is the one intentional Buffer write.
		//
		// The channel's type decides how Buffer can publish it (a Facebook group
		// or an Instagram personal profile needs a human), and the draft's
		// source becomes the link preview card when it has one.
		const [channels, link] = await Promise.all([
			listBufferChannels(env, connection).catch(() => []),
			Promise.resolve(draftLink(draft)),
		])
		const channel = channels.find((c) => c.id === draft.channelId)
		const result = await pushDraftToBuffer(env, connection, {
			text: draft.body,
			channelId: draft.channelId,
			channelType: channel?.type ?? null,
			channelService: channel?.service ?? draft.channelService ?? null,
			linkUrl: link?.url ?? null,
			linkTitle: link?.title ?? null,
		})
		finishContentPush(
			agent,
			draft.id,
			result.ok
				? {
						ok: true,
						bufferPostId: result.postId,
						bufferMode: result.mode,
					}
				: { ok: false, error: result.error },
		)
		captureContentEvent({
			event: "content_draft_pushed",
			orgId: verified.org.id,
			userId: ownerUserId,
			draftId: draft.id,
			kind: draft.kind,
			channel: draft.channelService,
			ok: result.ok,
			mode: result.ok ? result.mode : undefined,
			error: result.ok ? undefined : result.error,
		})
		const { blocks } = await rebuild()
		const message = result.ok
			? result.mode === "draft"
				? "Pushed to your Buffer drafts ✓"
				: result.mode === "queue"
					? "Added to your Buffer queue ✓"
					: "Sent to Buffer ✓"
			: `Couldn't push it: ${result.error}`
		await respond(interaction.responseUrl, message, {
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
