/**
 * The `content_studio` tool: run a Content Studio round on demand.
 *
 * The scheduled round is the steady state, but a content run is also a thing
 * someone asks for in the moment ("post something about the pricing change",
 * "draft today's posts now"). Without a tool for that, the only way to get
 * drafts was to wait for the cron, and the request sat in the thread as a
 * promise with no draft behind it.
 *
 * The tool runs the same pipeline the automation runs: one evidence pass for
 * the round, then one writing turn per draft, then a review card in the
 * asker's DM. Nothing is published — the card carries Push / Remix / Dismiss
 * and only a Push writes to Buffer.
 *
 * The operator's own words are the brief. That is not politeness: Flovia
 * requires the request text verbatim, and a paraphrased brief produces a
 * lookup for something nobody asked for.
 */
import { generateId } from "@repo/lib/generate-id"
import { openSlackConversation } from "../slack/client"
import { listAutomations } from "../tools/automations"
import { runContentStudio } from "../content/generate"
import { logPreview } from "../observability/log-utils"
import type { SlackLookupContext } from "../slack/channel-lookup"
import type { TurnDeps } from "./deps"

export type ContentStudioToolArgs = {
	deps: TurnDeps
	agent: Parameters<typeof listAutomations>[0]
	org: Parameters<typeof runContentStudio>[0]["org"]
	env: Env
	/** The account the drafts belong to (the operator). */
	userId: string
	/** The Slack id of whoever asked, for the DM. */
	askerSlackUserId?: string
	/** Slack context: bot token, team, and the channel the request came from. */
	slackLookup?: SlackLookupContext
	/** Admins may run a round for someone else; members may run their own. */
	isAdmin?: boolean
	traceId: string
}

/**
 * The DM the review card goes to.
 *
 * A request made in a channel still gets its card in the asker's DM: the
 * card carries buttons, and a channel is the wrong place for one person's
 * review queue.
 */
async function resolveDmChannel(
	args: ContentStudioToolArgs,
): Promise<string | null> {
	const slack = args.slackLookup
	if (!slack?.botToken) return null
	const inDm = slack.memoryScope?.kind === "dm"
	if (inDm && slack.channel) return slack.channel
	if (!args.askerSlackUserId) return null
	return (await openSlackConversation(slack.botToken, args.askerSlackUserId)) ?? null
}

/**
 * The automation the drafts belong to.
 *
 * Drafts are stored against an automation so the daily round can supersede
 * yesterday's leftovers. A content automation is used when one exists, so a
 * manual round and the scheduled one do not leave two sets of buttons lying
 * around; otherwise a stable per-workspace id stands in for it.
 */
function resolveAutomationId(
	args: ContentStudioToolArgs,
): { id: string; title: string } {
	const automations = listAutomations(args.agent, {
		userId: args.userId,
		isAdmin: args.isAdmin ?? false,
	})
	const content = automations.find((a) => a.mode === "content")
	if (content) return { id: content.id, title: content.title }
	return { id: `content-studio-${args.org.id}`, title: "Content Studio" }
}

export function createContentStudioTool(args: ContentStudioToolArgs) {
	const { deps } = args
	return deps.tool({
		description:
			"Draft social posts for review, through the Content Studio. Use this for ANY request to write, draft, generate or plan a social post — a launch post, today's posts, posts for a topic, a thread, a LinkedIn post. Do not write the posts yourself in your reply: this tool collects the evidence once, writes each draft from it, and DMs a review card with Push / Remix / Dismiss buttons, and only a draft the person pushes can reach Buffer. A post written straight into your reply is unreviewable and can never be scheduled. The request text is the brief and is passed to the data sources verbatim, so pass the asker's own words.",
		inputSchema: deps.z.object({
			instruction: deps.z
				.string()
				.min(1)
				.describe(
					"The brief for this round, in the requester's own words: what the posts should be about. Passed to the data sources verbatim, so do not paraphrase or add instructions of your own.",
				),
		}),
		execute: async ({ instruction }) => {
			const brief = instruction.trim()
			const slack = args.slackLookup
			if (!slack?.botToken || !slack.teamId) {
				return {
					ok: false,
					error:
						"Content Studio needs a Slack context — run it from Slack rather than from a background task.",
				}
			}
			const dmChannelId = await resolveDmChannel(args)
			if (!dmChannelId) {
				return {
					ok: false,
					error:
						"I couldn't open a DM for the drafts. Ask again from a DM or mention me in the channel.",
				}
			}
			const automation = resolveAutomationId(args)
			const runTraceId = generateId()
			console.log(
				`[company-brain][${args.traceId}] content_studio run org=${args.org.id} automation=${automation.id} brief="${logPreview(brief, 200)}"`,
			)
			// The round runs in the background: it is several turns long, and the
			// person asking should get their answer now and the card when it is
			// ready, not wait for the drafts.
			args.agent.waitUntil(
				runContentStudio({
					agent: args.agent,
					org: args.org,
					teamId: slack.teamId,
					botToken: slack.botToken,
					dmChannelId,
					ownerUserId: args.userId,
					ownerSlackUserId: args.askerSlackUserId,
					automationId: automation.id,
					instruction: brief,
					runTraceId,
					runTrigger: "run_now",
					env: args.env,
				}).catch((err) => {
					console.error(
						`[company-brain][${args.traceId}] content_studio round failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				}),
			)
			return {
				ok: true,
				detail:
					"Running a Content Studio round now. The drafts will land in your DM in a minute or two, each with the facts it was grounded in and Push / Remix / Dismiss buttons. Nothing publishes until you push one.",
			}
		},
	})
}
