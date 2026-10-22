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
import {
	listRecentContentRounds,
	listRecentDrafts,
	sweepStaleContentRounds,
} from "../content/store"
import { pushContentDraftToBuffer } from "../content/push"
import { listVisibleRuntimeSkills } from "../skills/store"
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

/**
 * Push a draft from a chat instruction.
 *
 * The review card's button is the usual way in, but a button depends on the
 * Slack app's interactivity URL being right. This path is the same write
 * behind a plain message, so "push draft 2" always works — and it is still
 * one explicit approval by the owner for one Buffer write.
 */
async function pushDraftByReference(
	args: ContentStudioToolArgs,
	automationId: string,
	reference: string | undefined,
	channelHint?: string | undefined,
): Promise<{ ok: boolean; detail?: string; error?: string }> {
	const ref = (reference ?? "").trim()
	if (!ref) {
		return {
			ok: false,
			error:
				"Which draft should I push? Give the draft number from the review card (1 = the first) or the draft id.",
		}
	}
	const drafts = listRecentDrafts(args.agent, automationId, { limit: 20 })
	const byId = drafts.find((d) => d.id === ref)
	const index = Number.parseInt(ref, 10)
	const open = drafts.filter((d) => d.status === "pending")
	const byIndex = Number.isFinite(index)
		? (open[index - 1] ?? drafts[index - 1] ?? null)
		: null
	const draft = byId ?? byIndex
	if (!draft) {
		return {
			ok: false,
			error: `I couldn't find a draft called "${ref}". Open the review card in your DM and give me the number from it.`,
		}
	}
	if (draft.ownerUserId && draft.ownerUserId !== args.userId) {
		return {
			ok: false,
			error: "That draft belongs to someone else — only its owner can push it.",
		}
	}
	const outcome = await pushContentDraftToBuffer({
		env: args.env,
		agent: args.agent,
		org: args.org,
		ownerUserId: args.userId,
		draft,
		channelHint: channelHint ?? null,
	})
	return { ok: outcome.ok, detail: outcome.message }
}

export function createContentStudioTool(args: ContentStudioToolArgs) {
	const { deps } = args
	return deps.tool({
		description:
			"Draft social posts for review, through the Content Studio. Use this for ANY request to write, draft, generate or plan a social post — a launch post, today's posts, posts for a topic, a thread, a LinkedIn post. Do not write the posts yourself in your reply: this tool collects the evidence once, writes each draft from it, and DMs a review card with Push / Remix / Dismiss buttons, and only a draft the person pushes can reach Buffer. A post written straight into your reply is unreviewable and can never be scheduled. The request text is the brief and is passed to the data sources verbatim, so pass the asker's own words. When the person asks where a round stands, whether drafts are ready, or what happened to a run, call this tool with action \"status\" instead of starting a new round.",
		inputSchema: deps.z.object({
			action: deps.z
				.enum(["run", "status", "push"])
				.optional()
				.describe(
					"run (the default) starts a new round. status reports what the recent rounds are doing — use it when the person asks where a round stands, whether drafts are ready, or what happened to a run. push publishes one existing draft to Buffer — use it when the person explicitly asks to publish, send or push a specific draft (and give the draft in the \"draft\" field).",
				),
			draft: deps.z
				.string()
				.optional()
				.describe(
					"Which draft to push: a draft id, or the number of the draft on the review card (1 = the first). Required for action \"push\".",
				),
			channel: deps.z
				.string()
				.optional()
				.describe(
					"Where to publish it, when the person named a channel (\"push draft 2 to linkedin\"). A service name (linkedin, facebook, substack) or a channel name.",
				),
			instruction: deps.z
				.string()
				.optional()
				.describe(
					"The brief for this round, in the requester's own words: what the posts should be about. Passed to the data sources verbatim, so do not paraphrase or add instructions of your own. Required for a run; ignored for a status check.",
				),
		}),
		execute: async ({ instruction, action, draft: draftRef, channel }) => {
			const automation = resolveAutomationId(args)
			if (action === "push") {
				return pushDraftByReference(args, automation.id, draftRef, channel)
			}
			if (action === "status") {
				sweepStaleContentRounds(args.agent)
				const playbooks = listVisibleRuntimeSkills(args.agent, {
					userId: args.userId,
				}).map((skill) => skill.name)
				const rounds = listRecentContentRounds(args.agent, 5)
				const drafts = listRecentDrafts(args.agent, automation.id, {
					limit: 20,
				})
				if (!rounds.length) {
					return {
						ok: true,
						detail:
							"No Content Studio round has run yet. Ask for one and it will start immediately.",
					}
				}
				const lines = rounds.map((round) => {
					const when = new Date(round.startedAt).toISOString()
					const state =
						round.status === "running"
							? "running (still gathering evidence or writing)"
							: round.status === "writing"
								? "writing drafts"
								: round.status === "posted"
									? `finished, ${round.drafts} draft(s) in the DM`
									: round.status === "empty"
										? `finished with no drafts: ${round.error ?? "nothing concrete turned up"}`
										: `failed: ${round.error ?? "unknown error"}`
					return `- ${when} · ${round.trigger ?? "run"} · ${state} · brief: ${round.brief.slice(0, 120)}${round.brief.length > 120 ? "…" : ""}`
				})
				const byStatus = drafts.reduce<Record<string, number>>(
					(counts, draft) => {
						counts[draft.status] = (counts[draft.status] ?? 0) + 1
						return counts
					},
					{},
				)
				// The open drafts, numbered the way the review card numbers
				// them, so "push draft 2" refers to something unambiguous.
				const openDrafts = drafts.filter((d) => d.status === "pending")
				const draftLines = openDrafts.map(
					(draft, i) =>
						`  ${i + 1}. ${draft.kind} · ${draft.channelLabel ?? "no channel"} · ${draft.body.replace(/\s+/g, " ").trim().slice(0, 90)}…`,
				)
				return {
					ok: true,
					detail: `Content Studio rounds:\n${lines.join("\n")}\nDrafts on file (last 20): ${Object.entries(byStatus)
						.map(([status, count]) => `${status} ${count}`)
						.join(", ")}${
						draftLines.length
							? `\nWaiting for review:\n${draftLines.join("\n")}`
							: "\nNothing is waiting for review."
					}\nPlaybooks available (JEV pre-selects the best match for each turn): ${
						playbooks.length ? playbooks.join(", ") : "none visible"
					}`,
				}
			}
			const brief = (instruction ?? "").trim()
			if (!brief) {
				return {
					ok: false,
					error:
						"A content round needs a brief: what the posts should be about. Use action \"status\" instead if the person is asking where a round stands.",
				}
			}
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
					"Running a Content Studio round now. Evidence and drafts can take a few minutes on the current models. The drafts will land in your DM, each with the facts it was grounded in and Push / Remix / Dismiss buttons. Nothing publishes until you push one.",
			}
		},
	})
}
