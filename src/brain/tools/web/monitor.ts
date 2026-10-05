import type { Tool } from "ai"
import { logPreview } from "../../observability/log-utils"
import { createParallelMonitor } from "../../webhooks/parallel"
import type { TurnDeps } from "../../turn/deps"

const WEBHOOK_PATH = "/brain/webhooks/parallel"

/**
 * Parallel web monitor creation, from inside a turn.
 *
 * The monitor's whole routing story is the `metadata` we stamp at creation:
 * Parallel echoes it back on every delivery, and `resolveParallelDelivery`
 * reads exactly these keys to decide which org, channel and thread the finding
 * belongs to. There is no server-side channel map, so a monitor created in one
 * thread can never post into another.
 *
 * Only `detected` is subscribed: a completion means Parallel checked and
 * found nothing material, and treating that as news is how a bot gets muted.
 */
export function createBrainWebMonitorTool(params: {
	deps: TurnDeps
	env: Env
	/** Stable org id, also the Durable Object name the delivery routes to. */
	orgId: string
	/** The Slack workspace the monitor must post into. */
	teamId: string
	/** Channel the request was made in; also where findings land. */
	channelId: string
	/** Set when asked from a thread, so replies stay in-thread. */
	threadTs?: string
	traceId: string
}): Tool | null {
	const { deps, env, orgId, teamId, channelId, threadTs, traceId } = params

	// Parallel is a paid external vendor and the webhook is our public route,
	// so neither can be implied. Absent either, the tool simply does not exist.
	const apiKey = env.PARALLEL_API_KEY?.trim()
	const publicUrl = env.PUBLIC_URL?.trim().replace(/\/$/, "")
	if (!apiKey || !publicUrl) return null

	return deps.tool({
		description:
			"Set up a background web monitor that watches the public web for a topic and reports back in this conversation when something material changes (e.g. 'watch for news about Acme Corp', 'keep an eye on competitor pricing', 'tell me when OpenAI ships a new model'). Use this when someone asks to be kept informed over time about something on the public web, not for a one-off question — answer that with search_web instead. The first check runs immediately, then repeats on the schedule, and each detection posts back to this same conversation as its own message. It only reports changes worth a message, not every run.",
		inputSchema: deps.z.object({
			query: deps.z
				.string()
				.min(1)
				.max(1000)
				.describe(
					"What to watch for, as a search-style query. Name the entity or topic and what would count as news ('Acme Corp funding acquisition product launch', 'OpenAI model release announcement'). Vague topics produce vague matches.",
				),
			frequency: deps.z
				.string()
				.optional()
				.describe(
					"How often to check, as an age like '6h', '1d' or '1w'. Defaults to '1d'. Anything outside 1 hour to 30 days is clamped to that range.",
				),
		}),
		// Creating a monitor spends a vendor credit on every run and posts into
		// Slack later on, unattended. Same bar as send_to: a human asked for it.
		needsApproval: true,
		execute: async ({ query, frequency }) => {
			const t = Date.now()
			console.log(
				`[company-brain][${traceId}] create_web_monitor start query="${logPreview(query)}" frequency=${frequency ?? "1d"} team=${teamId} channel=${channelId} thread=${threadTs ?? "-"}`,
			)
			try {
				const monitorId = await createParallelMonitor({
					apiKey,
					webhookUrl: `${publicUrl}${WEBHOOK_PATH}`,
					query,
					frequency: frequency ?? "1d",
					route: {
						orgId,
						teamId,
						channelId,
						...(threadTs ? { threadTs } : {}),
					},
				})
				console.log(
					`[company-brain][${traceId}] create_web_monitor finish ms=${Date.now() - t} monitor=${monitorId}`,
				)
				return {
					monitorId,
					frequency: frequency ?? "1d",
					summary:
						"Web monitor is set up and reporting back to this conversation.",
					next: "Tell the requester it is watching, how often it checks, and that the first check has already run. Do not paste the monitor id at them unless they ask — it is an internal handle.",
				}
			} catch (err) {
				console.error(
					`[company-brain][${traceId}] create_web_monitor failed:`,
					err instanceof Error ? err.message : err,
				)
				// createParallelMonitor throws with the upstream detail because it
				// runs inside a turn that reports the error back to the person
				// who asked to be watched. Nothing was created, so say so.
				return {
					error:
						"The monitor could not be created, so nothing is being watched. Parallel rejected the request or was unreachable.",
					detail: err instanceof Error ? err.message : String(err),
				}
			}
		},
	})
}