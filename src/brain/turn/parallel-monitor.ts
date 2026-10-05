import { decryptToken } from "@/lib/crypto"
import {
	fetchParallelMonitorEvents,
	formatParallelEventsForTurn,
} from "../webhooks/parallel"
import { postSlackMessage } from "../slack/client"
import { getWorkspaceByTeamId } from "../slack/workspace"
import { runSlackTurn } from "../slack/turn"
import { brainAgent, type CompanyBrainAgent } from "./agent"

// A Parallel Monitor detected something material, and we are turning that
// delivery into a Slack reply.
//
// The webhook payload is only a pointer: it carries `event_group_id`, never the
// finding itself. `fetchParallelMonitorEvents` lives with the rest of the
// Parallel protocol code because it is a pure API call with no agent or Slack
// dependency; this module owns only the delivery decision.

export type ParallelMonitorEvent = {
	type: "monitor.event.detected"
	monitorId?: string
	eventGroupId?: string
	teamId: string
	channelId: string
	/** Set when the monitor was asked for from a thread. */
	threadTs?: string
}

/** Slack ts for a message that does not exist, so a forced turn can anchor on it. */
function syntheticSlackTs(): string {
	const now = Date.now()
	return `${Math.floor(now / 1000)}.${String((now % 1000) * 1000).padStart(6, "0")}`
}

const MONITOR_NOTICE =
	"A background web monitor you asked for has detected a material change. " +
	"Reply to the team now: say what changed, why it likely matters, and what " +
	"you recommend doing about it. Be concrete and cite the sources below. " +
	"This is read-only investigation: do NOT create, modify, post, send, or " +
	"connect anything. Your reply text is posted to the thread automatically.\n\n"

/**
 * Deliver a detected monitor event into the channel that asked for it.
 *
 * Runs a real turn rather than posting the finding verbatim, so the brain can
 * apply team context and give a recommendation instead of relaying a diff.
 * Falls back to a plain text post when the turn cannot run, because a monitor
 * firing is a promise the team is waiting on and silence is the worse failure.
 */
export async function runParallelMonitorEvent(
	agent: CompanyBrainAgent,
	event: ParallelMonitorEvent,
): Promise<void> {
	const env = brainAgent(agent).env
	const ws = await getWorkspaceByTeamId(env, event.teamId)
	if (!ws) {
		console.warn(
			`[company-brain] parallel monitor event dropped: no workspace team=${event.teamId}`,
		)
		return
	}
	// The team can be rebound to a different org; a delivery addressed to the
	// old org must never post into the new one.
	if (ws.orgId !== agent.name) {
		console.error(
			`[company-brain] parallel monitor event dropped: workspace rebound team=${event.teamId} eventOrg=${agent.name} currentOrg=${ws.orgId}`,
		)
		return
	}

	const botToken = await decryptToken(ws.botTokenEnc, env.ENCRYPTION_SECRET)

	// Without the API key we still owe the team something: acknowledge that the
	// monitor fired rather than dropping it silently.
	if (!env.PARALLEL_API_KEY || !event.monitorId) {
		await postSlackMessage(
			botToken,
			event.channelId,
			"A web monitor you asked for detected a change, but I could not load the details. Check the monitor's latest run.",
			event.threadTs,
		)
		return
	}

	const events = await fetchParallelMonitorEvents({
		apiKey: env.PARALLEL_API_KEY,
		monitorId: event.monitorId,
		eventGroupId: event.eventGroupId,
	})
	const detail = events ? formatParallelEventsForTurn(events) : null

	if (!detail) {
		await postSlackMessage(
			botToken,
			event.channelId,
			"A web monitor you asked for fired, but Parallel returned no readable detail for this run.",
			event.threadTs,
		)
		return
	}

	const question = `${MONITOR_NOTICE}Monitor finding:\n\n${detail}`

	// Without a thread to reply into there is no thread to anchor a forced turn
	// on, so deliver the finding directly rather than guessing at a target.
	if (!event.threadTs) {
		await postSlackMessage(botToken, event.channelId, question)
		return
	}

	try {
		await runSlackTurn(
			agent,
			{
				teamId: event.teamId,
				event: {
					type: "message",
					channel: event.channelId,
					text: question,
					ts: syntheticSlackTs(),
					thread_ts: event.threadTs,
				},
			},
			{
				forceFullTurn: true,
				forceThreadTs: event.threadTs,
				obsSource: "parallel_monitor",
				// No real Slack message exists to react to.
				skipReactions: true,
			},
		)
	} catch (err) {
		console.error(
			"[company-brain] parallel monitor turn failed:",
			err instanceof Error ? err.message : String(err),
		)
		// The turn owns publication, so a post here cannot duplicate it.
	}
}