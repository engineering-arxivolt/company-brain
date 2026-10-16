/**
 * Review cards for Content Studio rounds.
 *
 * One DM message carries the whole round: a section per draft with the
 * post-ready text, and Push / Remix / Dismiss buttons while a draft is open.
 * After any action the message is rebuilt from the stored rows, so the card
 * always reflects real state (never an optimistic one).
 */
import type { ContentDraft } from "./store"
import { contentKindLabel } from "./voice"

export const CONTENT_PUSH_ACTION = "brain_content_push"
export const CONTENT_REMIX_ACTION = "brain_content_remix"
export const CONTENT_DISMISS_ACTION = "brain_content_dismiss"

export type ContentRoundBlocks = {
	text: string
	blocks: unknown[]
}

type SlackBlock = Record<string, unknown>

function quoteBody(body: string): string {
	return body
		.split("\n")
		.map((line) => (line.trim() ? `> ${line}` : ">"))
		.join("\n")
}

function draftStatusLine(draft: ContentDraft): string | null {
	switch (draft.status) {
		case "pushing":
			return "⏳ Pushing to Buffer…"
		case "remixing":
			return "✍️ Rewriting with a fresh angle…"
		case "pushed": {
			const where =
				draft.bufferMode === "draft"
					? "In your Buffer drafts — schedule it there when ready."
					: draft.bufferMode === "queue"
						? "Queued in Buffer."
						: "Sent to Buffer."
			return `✅ ${where}`
		}
		case "dismissed":
			return "🗑 Dismissed."
		case "superseded":
			return "⏭ Skipped — superseded by a newer round."
		default:
			return draft.error ? `⚠️ Last attempt failed: ${draft.error}` : null
	}
}

function draftChannelText(draft: ContentDraft): string {
	if (!draft.channelLabel) return "no channel"
	return draft.channelLabel
}

function draftBlocks(
	index: number,
	draft: ContentDraft,
	opts: { bufferConnected: boolean },
): SlackBlock[] {
	const statusLine = draftStatusLine(draft)
	const heading = `*${index}. ${contentKindLabel(draft.kind)}* · ${draftChannelText(draft)}`
	const body = quoteBody(draft.body)
	const section: SlackBlock = {
		type: "section",
		text: {
			type: "mrkdwn",
			text: `${heading}\n${body}${statusLine ? `\n${statusLine}` : ""}`,
		},
	}
	const blocks: SlackBlock[] = [section]
	const open = draft.status === "pending"
	if (open) {
		const elements: SlackBlock[] = []
		if (opts.bufferConnected && draft.channelId) {
			elements.push({
				type: "button",
				action_id: CONTENT_PUSH_ACTION,
				text: { type: "plain_text", text: "Push to Buffer", emoji: true },
				style: "primary",
				value: draft.id,
			})
		}
		elements.push({
			type: "button",
			action_id: CONTENT_REMIX_ACTION,
			text: { type: "plain_text", text: "Remix", emoji: true },
			value: draft.id,
		})
		elements.push({
			type: "button",
			action_id: CONTENT_DISMISS_ACTION,
			text: { type: "plain_text", text: "Dismiss", emoji: true },
			style: "danger",
			value: draft.id,
		})
		blocks.push({ type: "actions", elements })
	}
	return blocks
}

export function buildContentRoundBlocks(
	drafts: ContentDraft[],
	opts: { bufferConnected: boolean; note?: string },
): ContentRoundBlocks {
	const open = drafts.filter((d) => d.status === "pending").length
	const label =
		open > 0
			? `${open} draft${open === 1 ? "" : "s"} ready for review`
			: "round complete"
	const blocks: SlackBlock[] = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*🧵 Daily content* — ${label}. Push it to Buffer, ask for a remix, or dismiss it.`,
			},
		},
	]
	drafts.forEach((draft, i) => {
		blocks.push(...draftBlocks(i + 1, draft, opts))
	})
	const footnotes: string[] = []
	if (opts.note) footnotes.push(opts.note)
	if (!opts.bufferConnected) {
		footnotes.push(
			"No Buffer connection found — connect Buffer under Settings → Connectors to push drafts straight to it.",
		)
	} else {
		footnotes.push(
			"Pushed posts land in Buffer as drafts or in your queue, so nothing goes live from here.",
		)
	}
	blocks.push({
		type: "context",
		elements: [{ type: "mrkdwn", text: footnotes.join(" ") }],
	})
	const text = `🧵 Daily content — ${label}.`
	return { text, blocks }
}
