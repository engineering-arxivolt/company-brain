/**
 * The one place that decides what a paused turn looks like in Slack.
 *
 * A pause with budget left becomes a background status card and arms the next
 * chunk; a pause without budget keeps the original Continue card. Keeping this
 * in one helper means the three Slack pause paths (fresh turn, approval
 * resume, lease follow-up) cannot drift apart.
 */
import {
	longJobStatusText,
	markLongJobCardFinished,
	postLongJobCard,
	postPausedTurnCard,
	updateLongJobCard,
} from "../slack/client"
import type { CompanyBrainAgent } from "./agent"
import {
	armLongJob,
	findLatestLongJob,
	markLongJobStatus,
	setLongJobStatusTs,
	type LongJob,
} from "./long-job"
import { markPausedTurnTerminal, type PausedTurn } from "./pause"

export type PostPauseStatusArgs = {
	agent: CompanyBrainAgent
	botToken: string
	paused: PausedTurn
	channel: string
	threadTs: string
	askerUser: string
}

/** What the status card says once a pause can no longer auto-continue. */
const MANUAL_CARD_TEXT: Record<string, string> = {
	exhausted:
		"Background task paused — I've used this hour's background budget. Use Continue below if you want me to keep going.",
	expired:
		"Background task paused — it ran past the one-hour background limit. Use Continue below to pick it up.",
	schedule_failed:
		"Background task paused — I couldn't schedule the next step. Use Continue below to pick it up.",
	cancelled: "Background task stopped. Anything already finished is in the thread.",
}

function closedCardText(status: string): string {
	if (status === "completed") return "Background task finished — the answer is above."
	if (status === "error") return "Background task stopped with an error."
	return (
		MANUAL_CARD_TEXT[status] ??
		MANUAL_CARD_TEXT.schedule_failed ??
		"Background task paused."
	)
}

async function closeStatusCard(args: {
	botToken: string
	channel: string
	job: LongJob
	text: string
}): Promise<void> {
	if (!args.job.statusTs) return
	await markLongJobCardFinished(
		args.botToken,
		args.channel,
		args.job.statusTs,
		args.text,
	).catch(() => false)
}

export async function postPauseStatus(
	args: PostPauseStatusArgs,
): Promise<{ auto: boolean; jobId?: string }> {
	let armed: Awaited<ReturnType<typeof armLongJob>>
	try {
		armed = await armLongJob({ agent: args.agent, paused: args.paused })
	} catch (error) {
		// A pause that cannot arm still has to leave the person a way forward.
		console.error("[company-brain] could not arm long job:", error)
		armed = { mode: "manual", job: null, reason: "schedule_failed" }
	}
	if (armed.mode !== "auto") {
		// A stopped job must not wake back up as a fresh Continue prompt, even
		// when the chunk it was running pauses after the Stop.
		if (armed.reason === "cancelled") {
			markPausedTurnTerminal(args.agent, args.paused.pauseId, "cancelled")
		}
		if (armed.job) {
			await closeStatusCard({
				botToken: args.botToken,
				channel: args.channel,
				job: armed.job,
				text: closedCardText(armed.reason),
			})
		}
		if (armed.reason === "cancelled") return { auto: false }
		await postPausedTurnCard(
			args.botToken,
			args.channel,
			args.threadTs,
			args.askerUser,
			args.paused.pauseId,
		)
		return { auto: false }
	}

	const job = armed.job
	const text = longJobStatusText(
		args.askerUser,
		job.autoContinues,
		job.maxAutoContinues,
	)
	if (job.statusTs) {
		const updated = await updateLongJobCard(
			args.botToken,
			args.channel,
			job.statusTs,
			text,
			job.jobId,
		)
		if (updated) return { auto: true, jobId: job.jobId }
	}
	const messageTs = await postLongJobCard(
		args.botToken,
		args.channel,
		args.threadTs,
		text,
		job.jobId,
	)
	if (!messageTs) return { auto: true, jobId: job.jobId }
	setLongJobStatusTs(args.agent, job.jobId, messageTs)

	// The next chunk runs three seconds after arm; if it beat this post to
	// Slack, the job is already terminal and the card must not stay live.
	const latest = findLatestLongJob(args.agent, args.paused.threadKey)
	if (
		latest?.jobId === job.jobId &&
		latest.status !== "running" &&
		latest.status !== "waiting_approval"
	) {
		await closeStatusCard({
			botToken: args.botToken,
			channel: args.channel,
			job: { ...latest, statusTs: messageTs },
			text: closedCardText(latest.status),
		})
	}
	return { auto: true, jobId: job.jobId }
}

/**
 * Close the status card when the turn it belongs to actually answers. A turn
 * that paused again never reaches this; its status card is updated in place by
 * the next `postPauseStatus`.
 */
export async function finishLongJobCard(args: {
	agent: CompanyBrainAgent
	threadKey: string
	botToken: string
	channel: string
	failed?: boolean
}): Promise<void> {
	const job = findLatestLongJob(args.agent, args.threadKey)
	if (!job || (job.status !== "running" && job.status !== "waiting_approval")) {
		return
	}
	const status = args.failed ? "error" : "completed"
	markLongJobStatus(args.agent, job.jobId, status)
	// A failed status-card post must not leave a live job behind: the row is
	// closed even when there is no message to update.
	if (!job.statusTs) return
	await markLongJobCardFinished(
		args.botToken,
		args.channel,
		job.statusTs,
		args.failed
			? "Background task stopped with an error."
			: "Background task finished — the answer is above.",
	).catch(() => false)
}
