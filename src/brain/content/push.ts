/**
 * Pushing one draft to Buffer, without the Slack button.
 *
 * The button on the review card is the approval, but a button is only as good
 * as the app's interactivity request URL: if that URL is misconfigured, the
 * click goes nowhere and the draft is stranded. This module holds the write
 * itself so the same push can run from a chat command ("push draft 2") and
 * from the button, and the approval rule stays in one place: one explicit
 * request from the owner, one Buffer write.
 */
import { captureContentEvent } from "@/lib/posthog"
import type { CompanyBrainAgent } from "../turn/agent"
import type { SlackOrg } from "../slack/workspace"
import {
	findBufferConnection,
	listBufferChannels,
	pushDraftToBuffer,
} from "./buffer"
import {
	claimContentDraft,
	draftLink,
	finishContentPush,
	type ContentDraft,
} from "./store"

export type ContentPushOutcome = {
	ok: boolean
	/** The sentence the operator sees. */
	message: string
	mode?: string
	postId?: string | null
}

/**
 * Push one draft to Buffer.
 *
 * The draft's channel decides where it lands. A draft written before the
 * channel list loaded has no target, so the first available channel is used
 * and written back onto the draft: a push is never a dead end, and the next
 * push for that draft is already targeted.
 */
export async function pushContentDraftToBuffer(args: {
	env: Env
	agent: CompanyBrainAgent
	org: SlackOrg
	ownerUserId: string
	draft: ContentDraft
	/** Optional channel name or service, for "push draft 2 to LinkedIn". */
	channelHint?: string | null
}): Promise<ContentPushOutcome> {
	const { env, agent, org, ownerUserId, draft } = args
	const connection = await findBufferConnection(env, org.id, ownerUserId).catch(
		() => null,
	)
	if (!connection) {
		finishContentPush(agent, draft.id, {
			ok: false,
			error: "no Buffer connection found",
		})
		return {
			ok: false,
			message:
				"There's no Buffer connection I can use — connect Buffer under Settings → Connectors, then push again.",
		}
	}
	const claimed = claimContentDraft(agent, draft.id, "pushing")
	if (!claimed) {
		return {
			ok: false,
			message: "That draft is already being handled.",
		}
	}

	const [channels, link] = await Promise.all([
		listBufferChannels(env, connection).catch(() => []),
		Promise.resolve(draftLink(draft)),
	])
	let channelId: string | null = draft.channelId
	let channel = channels.find((c) => c.id === channelId)
	const hint = (args.channelHint ?? "").trim().toLowerCase()
	if (!channelId && hint && channels.length) {
		const hinted = channels.find(
			(c) =>
				c.service.toLowerCase() === hint ||
				c.name.toLowerCase() === hint ||
				c.name.toLowerCase().includes(hint),
		)
		if (hinted) channel = hinted
	}
	if (!channelId && channel) {
		const firstId = channel?.id ?? null
		if (firstId) {
			channelId = firstId
			try {
				agent.sql`
					UPDATE brain_content_draft SET
						channel_id = ${firstId},
						channel_service = ${channel?.service ?? null},
						channel_label = ${channel?.name ?? null},
						updated_at = ${Date.now()}
					WHERE id = ${draft.id}
				`
			} catch (err) {
				console.warn(
					`[company-brain] channel backfill failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}
	}
	const result = await pushDraftToBuffer(env, connection, {
		text: draft.body,
		channelId,
		channelType: channel?.type ?? null,
		channelService: channel?.service ?? draft.channelService ?? null,
		linkUrl: link?.url ?? null,
		linkTitle: link?.title ?? null,
	})
	finishContentPush(
		agent,
		draft.id,
		result.ok
			? { ok: true, bufferPostId: result.postId, bufferMode: result.mode }
			: { ok: false, error: result.error },
	)
	captureContentEvent({
		event: "content_draft_pushed",
		orgId: org.id,
		userId: ownerUserId,
		draftId: draft.id,
		kind: draft.kind,
		channel: channel?.service ?? draft.channelService,
		ok: result.ok,
		mode: result.ok ? result.mode : undefined,
		error: result.ok ? undefined : result.error,
	})
	if (!result.ok) {
		return { ok: false, message: `Couldn't push it: ${result.error}` }
	}
	return {
		ok: true,
		mode: result.mode,
		postId: result.postId,
		message:
			result.mode === "draft"
				? "Pushed to your Buffer drafts ✓"
				: result.mode === "queue"
					? "Added to your Buffer queue ✓"
					: "Sent to Buffer ✓",
	}
}
