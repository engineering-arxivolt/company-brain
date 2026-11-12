import type { ModelMessage } from "ai"
import {
	BrainCostLedger,
	recordFinishEvent,
	scheduleChargeBrainLlmCost,
} from "../billing/cost"
import { getCompanyContext } from "../memory/company-context"
import {
	ensureCareerProfileMemory,
	readCareerProfileSource,
	renderBaseCvContext,
} from "../memory/career-profile"
import { isCareerDocumentAsk } from "../career/document-ask"
import {
	loadInteractionStyleProfile,
	renderInteractionStyle,
} from "../memory/interaction-style"
import { buildAmbientBrainProfileContext } from "../memory/profile-recall"
import { getWorkspacePrompt } from "../memory/workspace-prompt"
import {
	type MemoryWriteback,
	memoryDocsFromWriteback,
} from "../memory/writeback"
import {
	captureBrainTurnUpdateApplied,
	createBrainTurnTelemetry,
	degradedAsError,
} from "../observability"
import {
	type BrainToolCallEvent,
	getToolFinishOutput,
	logPreview,
	logToolInput,
	redactedPreview,
} from "../observability/log-utils"
import {
	buildCurrentRequestPrompt,
	buildRuntimeContextPrompt,
	mapToolDetail,
	mapToolLabel,
	slackChannelRefFromToolCall,
	slackChannelRefsFromToolCall,
} from "../prompt/build"
import { buildAvailableSkillsContext } from "../skills/context"
import { resolveSkillsWithJev } from "../skills/resolver"
import { listVisibleRuntimeSkills } from "../skills/store"
import { DOCUMENT_DELIVERY_SKILL } from "../skills/system/document-delivery"
import { buildTurnUserContent } from "../slack/attachments"
import { resolveChannel } from "../slack/channel-directory"
import {
	parseBrainPersonality,
	personalityPromptBlock,
	resolveTurnExpressiveDelivery,
} from "../slack/personality"
import { claimThreadTurnApprovalIfInboxEmpty } from "../slack/turn-control"
import {
	consumePendingTurnUpdates,
	formatTurnUpdates,
	waitForTurnUpdateClassification,
} from "../slack/turn-inbox"
import { brainAgent } from "./agent"
import {
	batchApproval,
	enrichApprovalRequestFromMessages,
	findApprovalRequests,
} from "./approval-requests"
import { reportLegacyStructuredReply, type TurnCapture } from "./capture-tools"
import { cardOutputPayload } from "./card-content"
import {
	applySystemCacheBreakpoints,
	appendKeepingApprovalLast,
	buildTurnMessageLayout,
	compactMessagesAtBoundary,
} from "./context"
import { getTurnDeps } from "./deps"
import { recordDecision } from "./decision-log"
import {
	selectTurnReply,
	settleTurn,
	type TurnFinalizationAdapter,
} from "./finalization"
import {
	applyProgressPacingPolicy,
	applyTimeBudgetPolicy,
	runModelLoop,
	TURN_PAUSE_BUDGET_MS,
	type TimeBudgetPolicyDecision,
	type TurnAttempt,
} from "./loop"
import { toolFamiliesForSkill } from "./lazy-tools"
import { createDocumentDeliveryGuard } from "./document-delivery"
import { classifyTurn, matchesTurnRoute } from "./route"
import {
	channelRefFromMessage,
	deliverCareerDocuments,
	renderCareerDeliveryContext,
	selectCareerDocuments,
} from "../career/deliver"
import {
	requestTailoringPlanChecked,
	withTimeout,
} from "../career/tailor"
import { contextSearch, hasContextWeb } from "@/lib/context-dev"
import { parseCareerProfile } from "../career/profile"
import {
	parseReportSpec,
	requestReportPlan,
	requestReportSpec,
	validateReportSpec,
} from "../documents/report"
import { deliverReport, renderReportDeliveryContext } from "../documents/deliver-report"
import { renderSandboxedCover } from "../documents/render-cover"
import {
	buildCampaignFiles,
	CAMPAIGN_BUILD_SCRIPT,
	CAMPAIGN_VERIFY_SCRIPT,
	requestCampaignPack,
} from "../content/campaign"
import { insertContentDraft } from "../content/store"
import { cleanSceneRequest } from "../content/flow-prompt"
import {
	buildStillPlanPrompt,
	parseStillPlan,
	renderStillPrompts,
	requestStillPlan,
} from "../content/stills"
import { tregKeywords } from "../content/treg"
import { fetchPageDirect, searchDirect, type DirectHit } from "../tools/web/direct"
import { firecrawlSearch, firecrawlScrape } from "../tools/web/firecrawl"
import { createSandboxClient, sandboxToolsConfigured } from "../tools/sandbox/client"
import { acquireSandboxLease } from "../tools/sandbox/lease"
import { isImageGenerationInProgress, waitForImageLease } from "../tools/sandbox/lease"
import { postSlackMessage, uploadSlackFile } from "../slack/client"

/**
 * Gather research notes for a report: search (Firecrawl keyless first — the
 * keyless DuckDuckGo path is routinely blocked from datacenter IPs), then read
 * the top pages. Bounded on purpose — two queries, three pages, ~18k chars — so
 * the spec call stays inside one model context and the pipeline inside one turn.
 */
export async function gatherResearchNotes(
	env: Env,
	topic: string,
	extraQueries: string[] = [],
): Promise<string> {
	const cleaned = topic
		.replace(
			/\b(please|can you|could you|for me|make|build|produce|create|write|give me)\b/gi,
			" ",
		)
		.replace(/\s+/g, " ")
		.trim()
	const queries = [
		cleaned.slice(0, 180),
		`${cleaned.slice(0, 150)} statistics 2025 2026`,
		...extraQueries.slice(0, 4),
	]
	const hits: Array<{ title: string; url: string; description: string }> = []
	const seen = new Set<string>()
	for (const queryText of queries) {
		const searches: Array<{ name: string; run: () => Promise<DirectHit[]> }> = [
			// context.dev first when its key is set: the operator's instruction
			// ("For search use context.dev") made this the preferred provider,
			// and the keyed tier does not share a rate limit with every other
			// Worker on the internet the way the keyless path does.
			...(hasContextWeb(env)
				? [
						{
							name: "context.dev",
							run: async () => {
								const response = await contextSearch(env, {
									query: queryText,
									timeoutMS: 15_000,
								})
								return response.results.map((result) => ({
									title: result.title,
									url: result.url,
									description: result.description,
								}))
							},
						},
					]
				: []),
			{
				name: "firecrawl",
				run: () =>
					firecrawlSearch(env, {
						query: queryText,
						limit: 5,
						timeoutMs: 15_000,
					}),
			},
			{
				name: "keyless",
				run: () =>
					searchDirect({
						query: queryText,
						limit: 5,
						timeoutMs: 12_000,
					}),
			},
		]
		for (const provider of searches) {
			try {
				const found = await provider.run()
				for (const hit of found) {
					if (seen.has(hit.url)) continue
					seen.add(hit.url)
					hits.push(hit)
				}
				break
			} catch (error) {
				console.log(
					`[company-brain] report research search ${provider.name} failed q="${queryText.slice(0, 60)}":`,
					error instanceof Error ? error.message : String(error),
				)
			}
		}
		if (hits.length >= 6) break
	}
	if (!hits.length) {
		return "No research notes could be gathered; rely only on what you know, and mark uncertain numbers instead of inventing them."
	}
	const pages: string[] = []
	for (const hit of hits.slice(0, 3)) {
		let text: string | null = null
		try {
			text = (await firecrawlScrape(env, hit.url, 20_000)).markdown
		} catch {
			try {
				text = (await fetchPageDirect(hit.url, 15_000)).markdown
			} catch (error) {
				console.log(
					`[company-brain] report research fetch failed url=${hit.url}:`,
					error instanceof Error ? error.message : String(error),
				)
			}
		}
		if (text) {
			pages.push(
				`## ${hit.title}\n(source: ${hit.url})\n\n${text.slice(0, 6_000)}`,
			)
		}
	}
	return [
		`Searched: ${queries.join(" | ")}`,
		...pages,
		hits.length > 3
			? `Further sources (titles and snippets only):\n${hits
					.slice(3)
					.map((hit) => `- ${hit.title} — ${hit.url}\n  ${hit.description}`)
					.join("\n")}`
			: "",
	]
		.filter(Boolean)
		.join("\n\n")
		.slice(0, 24_000)
}
import { resolveBrainMainProfile } from "./model-profile"
import { primeOpenRouterTiers } from "./model-router"
import {
	buildPassiveInvocationContext,
	isPassiveNoReply,
	PASSIVE_NO_REPLY,
} from "./passive"
import { shouldShowToolProgressCard } from "./progress"
import {
	createTurnState,
	recordConnectedAppTrajectory,
	restoreTurnState,
	addTurnWarning,
	touchTurnState,
} from "./state"
import {
	createTurnTerminalCapture,
	FINISH_TURN_TOOL_NAME,
	type TurnTerminalCapture,
} from "./terminal"
import {
	buildThreadInvestigationCheckpoint,
	investigationPrincipalKey,
	loadThreadInvestigation,
	saveInterruptedTurnCheckpoint,
	saveThreadInvestigation,
} from "./thread-investigation"
import { assembleTurnTools, snapshotTurnToolAssembly } from "./tools"
import type {
	ComputeTurnInput,
	ComputeTurnResult,
	TurnProgress,
	TurnToolTraceEntry,
} from "./types"
import {
	raceWithAbortSignal,
	safeStringify,
	throwIfAborted,
	turnFailureCode,
	turnFailureTerminal,
} from "./util"

export const EMPTY_REPLY =
	"Sorry — I couldn't put together an answer for that one. Mind rephrasing or trying again in a moment?"

type TurnFailurePhase =
	| "tool_assembly"
	| "context_loading"
	| "model_generation"
	| "approval_handshake"
	| "output_read"
	| "turn_finalization"
	| "completion"

type ComputeTurnAttempt = Extract<TurnAttempt, "initial" | "live_update">

function turnThreadKey(input: ComputeTurnInput, traceId: string): string {
	if (input.options?.turnControl?.threadKey) {
		return input.options.turnControl.threadKey
	}
	const slackKey = [
		input.slackLookup?.teamId,
		input.slackLookup?.channel,
		input.slackLookup?.threadTs,
	]
		.filter(Boolean)
		.join(":")
	return slackKey || `${input.org.id}:${traceId}`
}

export async function computeTurn(
	input: ComputeTurnInput,
): Promise<ComputeTurnResult> {
	const {
		agent,
		org,
		userId,
		actor,
		question,
		threadText,
		conversationMessages,
		threadHistory,
		threadParticipants,
		workspaceGroups,
		attachmentParts = [],
		loc,
		asker,
		botIdentity,
		directory,
		progress,
		interaction,
		slackLookup,
		mentionedSlackUserIds,
		scheduledRun,
		skipBilling,
		ephemeral,
		agentMainEffort,
		effortOverride,
		stepLimit,
		obs,
		env: envOverride,
		options,
	} = input
	const deps = await getTurnDeps()
	const env = envOverride ?? brainAgent(agent).env
	const profile = resolveBrainMainProfile(
		org.metadata,
		agentMainEffort,
		effortOverride,
	)
	const abortSignal = options?.abortSignal
	throwIfAborted(abortSignal)
	const capture: TurnCapture = { memory: null, connect: null }
	// Settle the model catalog before anything builds the answering chain.
	// brainChainModelNames is synchronous, so the catalog has to be loaded here
	// rather than read from a cache that may or may not be warm -- otherwise the
	// same turn would pick different models depending on cold start. Failures
	// are swallowed: the hardcoded tiers remain the floor.
	await primeOpenRouterTiers(env).catch((error) => {
		console.warn(
			`[company-brain] OpenRouter catalog unavailable, using pinned models: ${error instanceof Error ? error.message : String(error)}`,
		)
	})
	const telemetry = createBrainTurnTelemetry(org.id, userId, obs, profile.name)
	const traceId = telemetry.traceId
	recordDecision(agent, {
		traceId,
		orgId: org.id,
		kind: "model_selection",
		subject: "main_turn",
		choice: profile.name,
		reason: `Main turn resolved at effort ${profile.effort}.`,
		source: "resolve_brain_main_profile",
		actor: userId,
	})
	const costLedger = new BrainCostLedger()
	// Pacing clock: when the person last saw a message, and whether they've heard
	// anything at all. Reset when the model posts, so silence during long tool
	// work can be measured/nudged (and a missing opener prompted).
	let lastUserVisibleAt = 0
	let updatesSent = 0
	let pacingInitialized = false
	// Wrapped so a post_update (progress.narrate) resets the pacing clock.
	const pacingProgress: TurnProgress | undefined = progress
		? {
				card: progress.card,
				...(progress.narrate
					? {
							narrate: async (text: string) => {
								// Pace on delivery only: an undelivered update (deduped, capped, stream
								// closed, or a failed Slack post) means the person heard nothing, so the
								// clock must keep running.
								const delivered = (await progress.narrate?.(text)) ?? false
								if (delivered) {
									lastUserVisibleAt = Date.now()
									updatesSent += 1
								}
								return delivered
							},
						}
					: {}),
			}
		: undefined
	console.log(
		`[company-brain][${traceId}] computeTurn start org=${org.id} user=${userId} model=${profile.name} effort=${profile.effort} question="${logPreview(question)}" threadChars=${threadText.length} attachments=${attachmentParts.length} directoryCount=${directory?.length ?? 0}`,
	)
	// Shared by the sandbox tools (which mark a delivered file) and finish_turn
	// (which refuses to end a document turn before one exists).
	const documentDelivery = createDocumentDeliveryGuard()
	const state = createTurnState({
		request: {
			text: question,
			askerSlackId: asker?.slackUserId,
			threadKey: turnThreadKey(input, traceId),
		},
		stepLimit,
	})
	let totalInputTokens = 0
	let totalOutputTokens = 0
	let lastProviderOutputChoices: unknown[] = []
	let failurePhase: TurnFailurePhase = "tool_assembly"
	// A turn in a real thread gets a stable key that the next turn looks up. A
	// turn with no thread surface falls back to the trace id, so anything written
	// under it could never be read back -- a strictly wasted write.
	const hasStableThreadKey = Boolean(
		input.options?.turnControl?.threadKey || input.slackLookup?.channel,
	)
	// Soft pause. When the time budget is spent the loop stops at the next step
	// boundary and hands back a full resume envelope, the way an approval
	// suspension does, instead of the caller yanking the deadline out from under
	// an in-flight tool call. Only turns with a stable thread surface pause: the
	// envelope is keyed to the thread, so anywhere else could never be resumed.
	const softPauseEnabled = !ephemeral && hasStableThreadKey
	const attemptStartedAt = Date.now()
	let pauseRequested = false
	// A failed or abandoned turn has still gathered evidence, and the completion
	// path that would normally keep it never runs. Save what it found so the next
	// turn in this thread continues instead of re-discovering everything. Never
	// throws: this runs on failure paths, where masking the real error would be
	// worse than losing the rescue.
	const rescueInterruptedWork = (): void => {
		if (ephemeral || !hasStableThreadKey) return
		try {
			const rescued = saveInterruptedTurnCheckpoint({
				agent,
				threadKey: state.request.threadKey,
				principalKey: investigationPrincipalKey({ userId, actor }),
				state,
			})
			if (rescued) {
				console.log(
					`[company-brain][${traceId}] rescued interrupted turn work methods=${rescued.discoveredMethods.length} trajectory=${rescued.trajectory.length} evidence=${rescued.verifiedEvidence.length}`,
				)
			}
		} catch (error) {
			console.warn(
				`[company-brain][${traceId}] interrupted turn rescue failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	const finishFailedTurn = (error: unknown): void => {
		const terminal = turnFailureTerminal(abortSignal)
		telemetry.finishTurn({
			outputChoices: lastProviderOutputChoices,
			turnStatus: terminal.turnStatus,
			inputTokens: totalInputTokens || undefined,
			outputTokens: totalOutputTokens || undefined,
			isError: true,
			error: terminal.error,
			failurePhase,
			failureCode: turnFailureCode(error, abortSignal),
			turnState: state,
		})
		rescueInterruptedWork()
	}
	const investigationPrincipal = investigationPrincipalKey({ userId, actor })
	try {
		state.checkpoint = ephemeral
			? undefined
			: loadThreadInvestigation({
					agent,
					threadKey: state.request.threadKey,
					principalKey: investigationPrincipal,
				})
		if (state.checkpoint) {
			console.log(
				`[company-brain][${traceId}] restored thread investigation methods=${state.checkpoint.discoveredMethods.length} evidence=${state.checkpoint.verifiedEvidence.length}`,
			)
		}
	} catch (error) {
		console.warn(
			`[company-brain][${traceId}] thread investigation restore unavailable: ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const assemblyArgs = {
		deps,
		env,
		agent,
		org,
		userId,
		actor,
		directory,
		threadHistory,
		slackLookup,
		askerSlackUserId: asker?.slackUserId,
		mentionedSlackUserIds,
		askerIsRestricted: asker?.isRestricted,
		scheduledRun,
		options,
		progress: pacingProgress,
		traceId,
		capture,
		turnState: state,
		onPhaseLatency: telemetry.recordPhaseLatency,
		costLedger,
		documentDelivery,
	} satisfies Parameters<typeof assembleTurnTools>[0]
	const assembly = assembleTurnTools(assemblyArgs)
	const assembled = await raceWithAbortSignal(assembly, abortSignal).catch(
		(error) => {
			// Abandoned, not cancelled: it still opens MCP transports.
			assembly
				.then((late) => (late.ready ? late.mcpClose?.() : undefined))
				.catch(() => {})
			finishFailedTurn(error)
			throw error
		},
	)
	if (!assembled.ready) return assembled.result
	const {
		tools,
		hasApps,
		toolDiscovery,
		connectedApps,
		connectedAppRuntime,
		connectedAppRouting,
		gifCandidates,
	} = assembled

	const runTurn = async (): Promise<ComputeTurnResult> => {
		failurePhase = "context_loading"
		const toolTrace: TurnToolTraceEntry[] = []
		let salvaged = false
		const toolLabelContext = {
			slackChannelId: slackLookup?.channel,
			slackChannelNames: {} as Record<string, string>,
			slackVisibleChannelRefs: {} as Record<string, true>,
			slackPrivateChannelRefs: {} as Record<string, true>,
			genericNonVisibleSlackChannelLabels: true,
		}
		const markSlackChannelRef = (
			visibility: "visible" | "private",
			ref: string,
			channelId: string,
			channelName: string,
		): void => {
			const target =
				visibility === "visible"
					? toolLabelContext.slackVisibleChannelRefs
					: toolLabelContext.slackPrivateChannelRefs
			for (const value of [ref, channelId, channelName, `#${channelName}`]) {
				const normalized = value.trim().toLowerCase()
				if (normalized) target[normalized] = true
			}
		}
		const hydrateSlackChannelLabels = async (
			toolName: string,
			toolCall?: unknown,
		): Promise<void> => {
			if (!slackLookup) return
			const normalizedName = toolName.toUpperCase()
			const refs =
				normalizedName === "SEARCH_SLACK_CHANNEL"
					? [slackChannelRefFromToolCall(toolCall)].filter(
							(ref): ref is string => Boolean(ref),
						)
					: normalizedName === "SEARCH_SLACK_CHANNELS"
						? slackChannelRefsFromToolCall(toolCall)
						: []
			await Promise.all(
				refs.map(async (ref) => {
					const resolved = await resolveChannel(
						env,
						slackLookup.teamId,
						slackLookup.botToken,
						ref,
					).catch(() => undefined)
					if (resolved?.status !== "ok") return
					if (resolved.channel.isPrivate) {
						markSlackChannelRef(
							"private",
							ref,
							resolved.channel.id,
							resolved.channel.name,
						)
						return
					}
					if (resolved.channel.id !== slackLookup.channel) return
					toolLabelContext.slackChannelNames[resolved.channel.id] =
						resolved.channel.name
					markSlackChannelRef(
						"visible",
						ref,
						resolved.channel.id,
						resolved.channel.name,
					)
				}),
			)
		}
		const toolLabel = async (
			toolName: string,
			toolCall?: unknown,
		): Promise<string> => {
			await hydrateSlackChannelLabels(toolName, toolCall)
			return mapToolLabel(toolName, toolCall, toolLabelContext)
		}
		const showProgressCard = async (
			toolCallId: string,
			toolName: string,
			toolCall?: unknown,
		): Promise<void> => {
			if (!shouldShowToolProgressCard(toolName)) return
			await progress?.card(
				toolCallId,
				await toolLabel(toolName, toolCall),
				"in_progress",
				{ detail: mapToolDetail(toolName, toolCall) },
			)
		}

		const canRequestAccessLease = "request_access_lease" in tools
		const hasAppAccessTools = hasApps || canRequestAccessLease
		const detailedAppPolicy = hasAppAccessTools
		const personalityPreset = parseBrainPersonality(
			slackLookup?.brainPersonality?.preset,
		)
		const activeSystem = deps.buildSystemPrompt({
			toolMode: hasAppAccessTools ? "apps" : "memory_only",
			appPolicy: detailedAppPolicy ? "detailed" : "compact",
			hasSandbox: toolDiscovery.availableFamilies().includes("sandbox"),
			canRequestAccessLease,
			connectedAppRouting,
			allowMemoryWriteback: !options?.passiveInvestigation,
			explicitFinish: !options?.passiveInvestigation,
			// Passive investigations never express: no reactions/GIFs and no
			// playful tone, matching the delivery gates below.
			personality: options?.passiveInvestigation
				? undefined
				: personalityPromptBlock(personalityPreset, {
						gifSearch: "search_gifs" in tools,
					}),
		})
		const buildActiveSystem = () => activeSystem
		const buildCurrentSystemMessages = () =>
			applySystemCacheBreakpoints(
				deps.buildSystemPromptMessages(buildActiveSystem(), botIdentity),
				profile,
			)

		const [companyContext, brainMemoryContext, interactionStyleProfile] =
			await Promise.all([
				getCompanyContext(env, org.id, traceId),
				buildAmbientBrainProfileContext(agent, {
					orgId: org.id,
					senderSlackUserId: asker?.slackUserId,
					mentionedSlackUserIds,
					scope: slackLookup?.memoryScope,
					// Ambient recall reads memory before any tool runs, so an explicit
					// surface has to bind it too or the turn leaks in ahead of them.
					containerTags: slackLookup?.memoryContainerTags,
				}),
				loadInteractionStyleProfile(env, org.id, asker?.slackUserId).catch(
					() => null,
				),
			])
		const visibleSkills = listVisibleRuntimeSkills(agent, {
			userId: actor.userId,
		})
		const jevSkillSelection = await resolveSkillsWithJev({
			env,
			agent,
			orgId: org.id,
			userId: actor.userId,
			question: question ?? "",
			visibleSkills,
			traceId,
		})

		let availableSkillsContextText: string | undefined
		let preloadedSkillsContextText: string | undefined

		if (jevSkillSelection && jevSkillSelection.preloadedSkills.length > 0) {
			state.loadedSkills ??= []
			for (const ps of jevSkillSelection.preloadedSkills) {
				const existing = state.loadedSkills.findIndex((s) => s.id === ps.id)
				if (existing >= 0) state.loadedSkills.splice(existing, 1)
				state.loadedSkills.push({
					id: ps.id,
					name: ps.name,
					version: ps.version,
				})
			}
			state.availableSkillIds = jevSkillSelection.selectedSkillIds
			preloadedSkillsContextText = [
				"<loaded_skills>",
				"The following relevant playbooks were pre-selected for this task. Follow their guidance:",
				...jevSkillSelection.preloadedSkills.map(
					(s) => `### Skill: ${s.name}\n${s.body}`,
				),
				"</loaded_skills>",
			].join("\n\n")
			// A preloaded playbook is followed from the first step, so the tools
			// it names have to exist by then. Compiling a PDF is the case this
			// exists for: the playbook says sandbox_run/sandbox_get_artifact,
			// and without the sandbox family the turn answers in prose instead
			// of producing the file.
			const playbookFamilies = [
				...new Set(
					jevSkillSelection.preloadedSkills.flatMap((skill) =>
						toolFamiliesForSkill(skill.body),
					),
				),
			]
			if (playbookFamilies.length) {
				const enabledFamilies = toolDiscovery
					.unlock(playbookFamilies)
					.filter((result) => result.status !== "unavailable")
					.map((result) => result.family)
				if (enabledFamilies.length) {
					console.log(
						`[company-brain][${traceId}] preloaded skill enabled families=${enabledFamilies.join(",")}`,
					)
					preloadedSkillsContextText = [
						preloadedSkillsContextText,
						`The ${enabledFamilies.join(" and ")} tools this playbook names are enabled for this turn. Do the work with them — the workspace, the build, the artifact — instead of describing it.`,
					].join("\n\n")
				}
			}
			// A turn that can load a second playbook needs to know the others
			// exist. The index is names and one line each — cheap, and it is
			// the difference between "the pre-selected playbook is the only
			// one that exists" and the writer knowing what else is on the shelf.
			if (options?.toolPolicy === "none") {
				const index = buildAvailableSkillsContext({
					agent,
					userId: actor.userId,
				})
				availableSkillsContextText = index?.text
				state.availableSkillIds = index?.skillIds ?? []
			}
		} else {
			const availableSkills = buildAvailableSkillsContext({
				agent,
				userId: actor.userId,
			})
			state.availableSkillIds = availableSkills?.skillIds ?? []
			availableSkillsContextText = availableSkills?.text
		}

		// A CV or cover letter is a cut of one base document, and that document
		// lives in memory. Seed it here, before the model's first step, so the
		// playbook's "tailor from the base CV" is never answered with "paste me
		// your CV" — the system already holds it.
		// A follow-up ("check again", "yes, do it") belongs to the same
		// job-application thread and still needs the base CV, so the trigger
		// reads the recent thread as well as this message. Only the tail counts:
		// a thread that mentioned a CV an hour ago is not this request.
		const careerContext = `${question ?? ""}\n${(threadText ?? "").slice(-2_000)}`
		const asksForCareerDocument =
			isCareerDocumentAsk(careerContext) ||
			(jevSkillSelection?.preloadedSkills ?? []).some(
				(skill) => skill.id === DOCUMENT_DELIVERY_SKILL.id,
			)
		// Read the base CV straight from where it is published and hand it to
		// the model. Semantic search does not reliably surface one long document
		// (measured: a seeded 6.5KB CV never scored above 0.67, so turns spent
		// their whole budget searching for it), and the company-context path
		// already shows the right shape: deterministic read, not a search.
		const baseCv =
			asksForCareerDocument && actor.userId
				? await readCareerProfileSource(env, actor.userId)
				: null
		if (baseCv) {
			console.log(
				`[company-brain][${traceId}] base_cv attached chars=${baseCv.length}`,
			)
		}
		// A document ask must end with a delivered file, not a written answer.
		// finish_turn is refused until sandbox_get_artifact reports one.
		if (asksForCareerDocument) documentDelivery.require()
		// Build the documents here, deterministically, before the model runs.
		// Ten attempts at "have the model write LaTeX and compile it" produced
		// one broken file; rendering is a solved problem, so it happens in code
		// and the model's only job is the message that carries the result.
		let careerDelivery: { documents: Array<{ fileName: string; pages: number }> } | null =
			null
		// Build on a fresh ask or an explicit retry, not on every follow-up in
		// the same thread — otherwise "ok" and "thanks" each post another copy
		// of the same two PDFs.
		const wantsCareerBuild =
			isCareerDocumentAsk(question ?? "") ||
			/\b(rebuild|retry|regenerate|again|fix (?:it|the pdf))\b/i.test(question ?? "")
		if (
			wantsCareerBuild &&
			baseCv &&
			slackLookup &&
			!scheduledRun &&
			sandboxToolsConfigured(env)
		) {
			// Where the files land. A PDF that renders in a channel can still
			// refuse to open in the bot's DM — different viewers — so a named
			// channel wins over the current conversation.
			let deliveryChannel = slackLookup.channel
			let deliveryThreadTs = slackLookup.threadTs
			const namedChannel = channelRefFromMessage(question ?? "")
			if (namedChannel) {
				const resolved = await resolveChannel(
					env,
					slackLookup.teamId,
					slackLookup.botToken,
					namedChannel,
				).catch(() => null)
				if (resolved?.status === "ok") {
					deliveryChannel = resolved.channel.id
					// A thread timestamp is only valid in its own channel.
					deliveryThreadTs = undefined
					console.log(
						`[company-brain][${traceId}] career documents will be delivered to #${resolved.channel.name}`,
					)
				} else {
					console.warn(
						`[company-brain][${traceId}] named channel ${namedChannel} is not usable (${resolved?.status ?? "lookup failed"}); using this conversation`,
					)
				}
			}
			const jobText = `${question ?? ""}\n${(threadText ?? "").slice(-4_000)}`
			// Per-job tailoring: one small model call turns the base CV plus the
			// posting into a plan (summary, emphasis, letter prose). It is the
			// judgement the model is good at; the renderer keeps the LaTeX. The
			// plan is then checked against the posting's own keywords — a plan
			// that under-represents them gets one redo with the misses named,
			// because an ATS and a recruiter both scan for that vocabulary. Any
			// failure here falls back to the un-tailored build.
			const tailoringRound = await withTimeout(
				requestTailoringPlanChecked(env.AI, baseCv, jobText, traceId),
				55_000,
				() => null,
			)
			const tailoring = tailoringRound?.plan ?? null
			const coverage = tailoringRound?.coverage
			console.log(
				`[company-brain][${traceId}] career tailoring ${
					tailoring
						? `applied entries=${tailoring.entryDetails ? Object.keys(tailoring.entryDetails).length : 0} letter=${tailoring.coverLetterParagraphs?.length ?? 0}p${
								coverage
									? ` coverage=${coverage.covered}/${coverage.total}`
									: ""
							}`
						: "unavailable, rendering base CV"
				}`,
			)
			// Heavy builds take turns per workspace (see acquireSandboxLease):
			// the compile chain here and a campaign render cannot run at once
			// without the platform killing one of their sessions.
			const careerLease = await acquireSandboxLease(env, `builds:${org.id}`)
			// Which documents the asker named: "just the CV" should not cost a
			// cover-letter compile, and "both" must not collapse to one.
			const questionedDocs = selectCareerDocuments(question ?? "")
			const built = await deliverCareerDocuments({
				client: createSandboxClient(env),
				profileMarkdown: baseCv,
				jobText,
				traceId,
				tailoring,
				documents: questionedDocs,
				upload: async (file) => {
					const upload = await uploadSlackFile(slackLookup.botToken, {
						channel: deliveryChannel,
						threadTs: deliveryThreadTs,
						filename: file.fileName,
						sizeBytes: file.sizeBytes,
						content: file.content,
						altText: `Generated document: ${file.fileName}`,
						signal: abortSignal,
					})
					return upload.ok
						? { ok: true, fileId: upload.fileId }
						: { ok: false, error: `${upload.stage}: ${upload.error}` }
				},
			})
				.catch((error) => ({
					ok: false as const,
					error: error instanceof Error ? error.message : String(error),
				}))
				.finally(() => careerLease.release())
			if (built.ok) {
				careerDelivery = { documents: built.documents }
				documentDelivery.markDelivered(built.documents[0]?.fileName ?? "cv.pdf")
				// Hand the container back now that the bytes are delivered: the
				// sandbox is billed per instance and nothing here needs the
				// workspace again. Best-effort — a failed cleanup must not turn a
				// delivered document into an error.
				const cleanup = createSandboxClient(env).destroySandbox?.({
					sandboxId: built.sandboxId,
				})
				void cleanup?.catch(() => undefined)
				// The documents exist, so the sandbox has nothing left to do. It
				// was not a hypothetical: a live turn rebuilt its own .tex after
				// the real files were already delivered, and those extra uploads
				// are what the person kept opening.
				for (const name of Object.keys(tools)) {
					if (name.startsWith("sandbox_")) delete tools[name]
				}
				console.log(
					`[company-brain][${traceId}] career documents delivered; sandbox tools withdrawn for this turn`,
				)
			} else {
				console.warn(
					`[company-brain][${traceId}] deterministic career build failed, falling back to the model: ${built.error}`,
				)
			}
		}
		if (baseCv && actor.userId) {
			// Keep memory in step for later recall, but never block the document
			// itself on the write: the text above is already the source of truth.
			await ensureCareerProfileMemory({
				env,
				org,
				userId: actor.userId,
				traceId,
			}).catch(() => ({ seeded: false }))
		}

		// ── Campaign pack: one story → posts, SEO, script, card, brief ────────
		// The content engine already collects signals, writes drafts and pushes
		// to Buffer; this ties the visual and the strategy layers to it. One
		// ask produces the social card, the one-page brief, and a pending
		// content draft the operator can push through the existing flow.
		const questionText = question ?? ""
		// One line per turn that says which deterministic route claimed it.
		// `primary` runs first (TURN_ROUTES order); `matched` is everything that
		// claims the message, and more than one is how a turn does two jobs. This
		// replaces the per-gate "pipeline engaged" archaeology: a wrong route is
		// now a log query instead of an incident review.
		const turnRoutes = classifyTurn(questionText)
		console.log(
			`[company-brain][${traceId}] route primary=${turnRoutes.primary ?? "model"} matched=${turnRoutes.matched.join(",") || "none"} flow=${turnRoutes.flow.reason}`,
		)
		// Durable copy of the same line, so the turn inspector (and anyone reading
		// /decisions later) sees what this turn believed rather than what today's
		// routing code would say about it.
		recordDecision(agent, {
			traceId,
			orgId: org.id,
			kind: "turn_route",
			subject: "route",
			choice: turnRoutes.primary ?? "model",
			reason: `flow=${turnRoutes.flow.reason}`,
			alternatives: Object.fromEntries(
				turnRoutes.matched.map((route) => [route, 1]),
			),
			source: "rules",
			actor: actor.userId,
		})
		// "Run a content campaign" belongs to the content studio — it drafts,
		// reviews and pushes through Buffer. The deterministic pack is for the
		// explicit ask: "campaign pack on X".
		const wantsCampaign = matchesTurnRoute("campaign", questionText)
		let campaignDraft: { id: string; hook: string } | null = null
		if (wantsCampaign && slackLookup && !scheduledRun && env.AI && actor.userId) {
			if (!documentDelivery.required) documentDelivery.require()
			console.log(
				`[company-brain][${traceId}] campaign pipeline engaged topic="${questionText.slice(0, 110)}"`,
			)
			// A campaign takes a minute or two (research, pack, compile, upload).
			// Say so in the conversation — silence reads as a dead turn, and a
			// failure gets named instead of vanishing.
			await postSlackMessage(
				slackLookup.botToken,
				slackLookup.channel,
				":zap: Building the campaign pack — research, strategy, then the card, the brief and the Flow kit.",
				slackLookup.threadTs,
			).catch(() => undefined)
			try {
				const notes = await gatherResearchNotes(env, questionText)
				// Real search data beats guesses: treg's Google data grounds the
				// pack's keywords before the model writes a word.
				const keywords = await tregKeywords(
					env,
					org.id,
					actor.userId,
					questionText,
					traceId,
				)
				// The pack is one JSON document; 24KB of research notes makes the
				// call slow enough to trip the timeout and lose the whole pack.
				// The top results carry the substance, so the prompt gets the
				// head of the notes and a trimmed retry if the first pass still
				// runs long.
				const askPack = (noteText: string) =>
					withTimeout(
						requestCampaignPack(
							env.AI,
							{
								story: questionText,
								notes: noteText,
								topic: questionText,
								keywords,
							},
							traceId,
						),
						60_000,
						() => null,
					)
				let pack = await askPack(notes.slice(0, 8_000))
				if (!pack && notes.length > 4_000) {
					console.log(
						`[company-brain][${traceId}] campaign pack slow on full notes, retrying with a trimmed brief`,
					)
					pack = await askPack(notes.slice(0, 4_000))
				}
				if (!pack) {
					console.warn(
						`[company-brain][${traceId}] campaign pack unavailable, answering without one`,
					)
				} else {
					const primary =
						pack.posts.find((post) => post.platform === "LinkedIn") ??
						pack.posts[0]
					if (!primary) {
						throw new Error("the campaign pack has no posts")
					}
					// A still already rendered in Flow for this workspace becomes
					// the pack's hero: the card composites it and the brief embeds
					// it, so the PDF and the social image share one piece of art.
					const heroBase64 = await env.BRAIN_KV.get(`render:hero:${org.id}`)
					const files = buildCampaignFiles(
						pack,
						heroBase64 ? { base64: heroBase64 } : undefined,
					)
					// The text deliverables (Flow kit + paste-ready prompts) are pure
					// strings: they go straight to Slack, so the image workflow is never
					// hostage to a sandbox compile.
					const encoder = new TextEncoder()
					for (const textFile of files.filter((file) =>
						/^flow-.*\.(md|txt)$/.test(file.path),
					)) {
						const bytes = encoder.encode(textFile.content)
						const upload = await uploadSlackFile(slackLookup.botToken, {
							channel: slackLookup.channel,
							threadTs: slackLookup.threadTs,
							filename: textFile.path,
							sizeBytes: bytes.byteLength,
							content: bytes.buffer as ArrayBuffer,
							signal: abortSignal,
						})
						if (!upload.ok) {
							console.warn(
								`[company-brain][${traceId}] campaign ${textFile.path} upload failed: ${upload.error}`,
							)
						}
					}
					// From here on the pipeline is a bonus: a failed card or brief must
					// not look like a failed pack.
					let sandboxNote: string | null = null
					// The compile runs in a sandbox whose session can die under load (the
					// platform terminates idle or strained containers, and a content round
					// can be running at the same time). A terminated session is
					// infrastructure noise, not a bad pack, so the build retries once on a
					// fresh sandbox before the turn gives up.
					const buildCampaignArtifacts = async () => {
						const sandbox = await createSandboxClient(env).createSandbox({
							goal: "campaign visuals",
						})
						for (const file of files) {
							await createSandboxClient(env).writeFile({
								sandboxId: sandbox.sandboxId,
								path: `${sandbox.defaultCwd}/${file.path}`,
								content: file.content,
							})
						}
						const build = await createSandboxClient(env).runCommand({
							sandboxId: sandbox.sandboxId,
							cwd: sandbox.defaultCwd,
							command: CAMPAIGN_BUILD_SCRIPT,
							timeoutSec: 180,
						})
						if (build.exitCode !== 0) {
							throw new Error(
								`campaign build failed exit=${build.exitCode}: ${build.output.slice(-300)}`,
							)
						}
						const verified = await createSandboxClient(env).runCommand({
							sandboxId: sandbox.sandboxId,
							cwd: sandbox.defaultCwd,
							command: CAMPAIGN_VERIFY_SCRIPT,
							timeoutSec: 60,
						})
						if (verified.exitCode !== 0) {
							throw new Error(
								`campaign verification failed: ${verified.output.slice(-300)}`,
							)
						}
						// The card is what the feeds will carry; the brief is what the
						// operator reads before pressing push; the Flow kit is what turns
						// the script into an actual video on their machine.
						const cardArtifact = await createSandboxClient(env).getArtifact({
							sandboxId: sandbox.sandboxId,
							path: `${sandbox.defaultCwd}/social-card.png`,
						})
						const briefArtifact = await createSandboxClient(env).getArtifact({
							sandboxId: sandbox.sandboxId,
							path: `${sandbox.defaultCwd}/brief.pdf`,
						})
						const flowKitArtifact = await createSandboxClient(env).getArtifact({
							sandboxId: sandbox.sandboxId,
							path: `${sandbox.defaultCwd}/flow-kit.md`,
						})
						return { cardArtifact, briefArtifact, flowKitArtifact }
					}
					// One heavy build per workspace at a time: a content round rendering
					// alongside this one is what kills sandbox sessions mid-command.
					const lease = await acquireSandboxLease(env, `builds:${org.id}`)
					let builtArtifacts:
						| Awaited<ReturnType<typeof buildCampaignArtifacts>>
						| null = null
					try {
						try {
							builtArtifacts = await buildCampaignArtifacts()
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error)
							if (!/terminat/i.test(message)) throw error
							console.warn(
								`[company-brain][${traceId}] campaign sandbox session died (${message.slice(0, 120)}), retrying on a fresh sandbox`,
							)
							builtArtifacts = await buildCampaignArtifacts()
						}
					} catch (error) {
						// The kit and prompts are already delivered; the card and brief are
						// the bonus, so this becomes a note rather than a failure.
						sandboxNote = error instanceof Error ? error.message : String(error)
						console.warn(
							`[company-brain][${traceId}] campaign visuals failed, kit already delivered: ${sandboxNote.slice(0, 200)}`,
						)
					} finally {
						await lease.release()
					}
					const cardArtifact = builtArtifacts?.cardArtifact ?? null
					const briefArtifact = builtArtifacts?.briefArtifact ?? null
						const uploadFailures: string[] = []
					// Only the sandbox files remain here: the kit and prompts already went.
					const sandboxArtifacts = [
						{ name: "social-card.png", artifact: cardArtifact },
						{ name: "campaign-brief.pdf", artifact: briefArtifact },
					].filter(
						(
							entry,
						): entry is { name: string; artifact: NonNullable<typeof entry.artifact> } =>
							Boolean(entry.artifact),
					)
					for (const artifact of sandboxArtifacts) {
						const upload = await uploadSlackFile(slackLookup.botToken, {
							channel: slackLookup.channel,
							threadTs: slackLookup.threadTs,
							filename: artifact.name,
							sizeBytes: artifact.artifact.sizeBytes,
							content: artifact.artifact.content,
							signal: abortSignal,
						})
						if (!upload.ok) {
							uploadFailures.push(
								`${artifact.name}: ${upload.error ?? "unknown"}`,
							)
							console.warn(
								`[company-brain][${traceId}] campaign ${artifact.name} upload failed: ${upload.error}`,
							)
						}
					}
					// Files that Slack refuses must never look like a delivered
					// pack: fail the pipeline so the conversation says what went
					// wrong instead of going quiet.
					if (sandboxArtifacts.length && uploadFailures.length === sandboxArtifacts.length) {
						throw new Error(
							`Slack rejected every campaign file (${uploadFailures[0]})`,
						)
					}
					// Land the primary post as a pending draft: the existing studio
					// flow reviews it and pushes it to Buffer through its own gate.
					const sources = [
						{ hook: pack.hook, angle: pack.angle, seo: pack.seo },
						...pack.posts.map((post) => ({
							platform: post.platform,
							body: post.body,
							effect: post.effect,
						})),
						{ script: pack.script },
					]
					const draft = insertContentDraft(agent, {
						automationId: `campaign-${traceId}`,
						roundId: `campaign-${Date.now()}`,
						teamId: slackLookup.teamId,
						ownerUserId: actor.userId,
						ownerSlackUserId: asker?.slackUserId ?? actor.userId,
						dmChannelId: slackLookup.channel,
						kind: "spotlight",
						body: primary.body,
						sourcesJson: JSON.stringify(sources),
						flagsJson: JSON.stringify([
							"campaign pack",
							`hook: ${pack.hook}`,
							`seo: ${pack.seo.keywords.join(", ")}`,
						]),
						traceId,
					})
					campaignDraft = { id: draft.id, hook: pack.hook }
					documentDelivery.markDelivered("social-card.png")
					for (const name of Object.keys(tools)) {
						if (name.startsWith("sandbox_")) delete tools[name]
					}
					console.log(
						`[company-brain][${traceId}] campaign pack delivered draft=${draft.id} posts=${pack.posts.length} script=${pack.script.length}`,
					)
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				console.warn(
					`[company-brain][${traceId}] campaign pipeline failed:`,
					reason,
				)
				// Name the failure in the conversation instead of leaving a dead turn.
				await postSlackMessage(
					slackLookup.botToken,
					slackLookup.channel,
					`:warning: The campaign pack could not be built: ${reason.slice(0, 180)}. I can retry, or do a plain content round instead.`,
					slackLookup.threadTs,
				).catch(() => undefined)
			}
		}

		// ── Flow: Google Flow through flow-mcp, queued to the VPS agent ────────
		// The account's own credits live in Flow, reachable only through a
		// signed-in browser on the VPS — so this queues a job the same way a
		// doodle is queued. Stills are free; a clip spends credits and the job
		// carries its own ceiling.
		//
		// Flow is the workspace's picture maker, so this is the default road for
		// "make me a picture" rather than one option among several: the fal and
		// runway tools on other servers are withheld from the model for exactly
		// this reason.
		//
		// *Whether* a message gets here is decided in flow-routing.ts, not
		// inline. A queued job ends the turn — the job is the answer — so a
		// document ask that slipped through was answered with art while its
		// PDFs were never built: "make me a CV and a cover letter" did exactly
		// that, because "cover" reads as a picture noun. The gate keeps
		// documents with the document pipeline, and being a function makes the
		// decision testable instead of a regex nobody dares touch.
		const threadImages = attachmentParts
			.filter((part): part is Extract<typeof part, { type: "image" }> => part.type === "image")
			.slice(0, 3)
		const characterTalk =
			/\b(same|the|that|this|my|our)\s+(character|person|face|girl|boy|man|woman|guy|lady|model|mascot)\b|\b(her|him|she|he|them|they)\b/i
		// The gate: a document ask is never a picture ask, and "cover" stops
		// meaning artwork the moment it is followed by "letter".
		const flowRouting = turnRoutes.flow
		if (flowRouting.queue && slackLookup && !scheduledRun) {
			const wantsClip = flowRouting.clip
			// Strip the command, keep the sentence. The trailing fallback matters: a
			// request that is nothing but scaffolding still gets sent as written
			// rather than as an empty prompt.
			const subject = cleanSceneRequest(questionText)
			const scenePrompt = (subject || questionText).slice(0, 300)
			// The images are already decoded in this turn, so the job carries
			// their bytes; the agent turns them into files Flow can read. A
			// reference too large to sit in a KV value is dropped rather than
			// failing the whole job.
			const REFERENCES_MAX_BYTES = 8 * 1024 * 1024
			const references: Array<{ name: string; mime: string; base64: string }> = []
			let droppedReferences = 0
			for (const [index, part] of threadImages.entries()) {
				const data =
					part.image instanceof Uint8Array
						? part.image
						: part.image instanceof URL
							? null
							: null
				if (!data || data.byteLength > REFERENCES_MAX_BYTES) {
					droppedReferences += 1
					continue
				}
				let binary = ""
				for (let offset = 0; offset < data.length; offset += 8192) {
					binary += String.fromCharCode(...data.subarray(offset, offset + 8192))
				}
				references.push({
					name: `ref-${index + 1}`,
					mime: part.mediaType || "image/jpeg",
					base64: btoa(binary),
				})
			}
			// Continuity: once a picture has established a character, a later
			// request that refers to "her", "him" or "the same character" keeps
			// that character and treats the new pictures as props — the crisp
			// packet in her hand is not a new person.
			const knownCharacter = await env.BRAIN_KV.get(`flow:character:${org.id}`)
			const reuseCharacter =
				Boolean(knownCharacter) && characterTalk.test(questionText)
			const job = {
				id: crypto.randomUUID(),
				kind: "flow" as const,
				title: scenePrompt,
				format: "1x1",
				flow: {
					type: wantsClip ? ("video" as const) : ("image" as const),
					aspect: /\b(9:16|vertical|story|reel|short)\b/i.test(questionText)
						? "9:16"
						: wantsClip
							? "16:9"
							: "1:1",
					...(wantsClip ? { duration: 4, maxCredits: 12 } : {}),
				},
				...(references.length ? { references } : {}),
				...(reuseCharacter && knownCharacter ? { character: knownCharacter } : {}),
				channel: slackLookup.channel,
				threadTs: slackLookup.threadTs,
				orgId: org.id,
				requestedBy: actor.userId,
				status: "pending" as const,
				createdAt: Date.now(),
				attempts: 0,
			}
			await env.BRAIN_KV.put(`render:job:${job.id}`, JSON.stringify(job), {
				expirationTtl: 60 * 60 * 24,
			})
			console.log(
				`[company-brain][${traceId}] flow job queued id=${job.id} type=${job.flow.type} refs=${references.length} dropped=${droppedReferences}`,
			)
			// Say plainly when a picture was left behind: silently making a
			// "reference" image with no reference is how consistency breaks.
			const refsNote = references.length
				? ` from ${references.length} reference image${references.length === 1 ? "" : "s"}`
				: ""
			const characterNote =
				"character" in job && job.character
					? ` keeping character ${job.character}`
					: ""
			const droppedNote = droppedReferences
				? ` ${droppedReferences} attached image${droppedReferences === 1 ? " was" : "s were"} too large (over 8 MB) and could not be used as a reference.`
				: ""
			await postSlackMessage(
				slackLookup.botToken,
				slackLookup.channel,
				(wantsClip
					? `:movie_camera: Rendering a 4s clip in Flow${refsNote}${characterNote} (~7 credits, capped at 12) — it lands here in a couple of minutes.`
					: `:art: Rendering a still in Flow${refsNote}${characterNote} (stills are free) — it lands here in about a minute.`) +
					droppedNote,
				slackLookup.threadTs,
			).catch(() => undefined)
			// The job is the answer: the agent renders and the Worker posts the
			// art. Letting the model carry on here would spend a second image
			// call on the same request and answer it twice.
			telemetry.finishTurn({
				outputChoices: [{ role: "assistant", content: "" }],
				turnStatus: "completed",
				turnState: state,
			})
			return {
				status: "completed",
				reply: "",
				memory: null,
				connect: null,
				toolTrace,
				salvaged: false,
				silentConclusion: true,
			}
		}

		// ── Doodle: an anidoodle render, queued to the VPS agent ───────────────
		// "doodle X" / "anidoodle X" writes a job and answers at once; the agent
		// on the VPS renders it and the Worker posts the picture into this
		// thread. No document is required from the model's own turn.
		const wantsDoodle =
			matchesTurnRoute("doodle", questionText) &&
			!matchesTurnRoute("campaign", questionText) &&
			!matchesTurnRoute("image-prompts", questionText)
		if (wantsDoodle && slackLookup && !scheduledRun) {
			const subject = questionText
				.replace(/\b(please|can you|could you|for me)\b/gi, " ")
				.replace(/\b(draw|make|create|render|generate)\b/gi, " ")
				.replace(/\b(a|an|the)\b\s+(doodle|anidoodle)\b/gi, " ")
				.replace(/\b(doodle|anidoodle)\b\s*(of|for|about|on)?\s*/gi, " ")
				.replace(/\s+/g, " ")
				.trim()
			const title = (subject || questionText).slice(0, 120)
			const job = {
				id: crypto.randomUUID(),
				kind: "title" as const,
				title,
				format: /\b(9:16|vertical|story|reel)\b/i.test(questionText) ? "9x16" : "1x1",
				channel: slackLookup.channel,
				threadTs: slackLookup.threadTs,
				orgId: org.id,
				requestedBy: actor.userId,
				status: "pending" as const,
				createdAt: Date.now(),
				attempts: 0,
			}
			await env.BRAIN_KV.put(
				`render:job:${job.id}`,
				JSON.stringify(job),
				{ expirationTtl: 60 * 60 * 24 },
			)
			console.log(
				`[company-brain][${traceId}] doodle queued id=${job.id} format=${job.format}`,
			)
			await postSlackMessage(
				slackLookup.botToken,
				slackLookup.channel,
				`:art: drawing “${title}” now — it lands here in about a minute.`,
				slackLookup.threadTs,
			).catch(() => undefined)
		}

		// ── Image prompts: the short road from Slack to flow-mcp ──────────────
		// "image prompts for X" skips the card and the brief. The operator only
		// needs paste-ready still prompts to draw in Flow with their own credits,
		// so this asks the pack model for a scene plan and ships the prompt file
		// — no sandbox, no PDF, nothing that can stall it.
		const wantsImagePrompts =
			matchesTurnRoute("image-prompts", questionText) &&
			!matchesTurnRoute("campaign", questionText)
		if (
			wantsImagePrompts &&
			slackLookup &&
			!scheduledRun &&
			env.AI &&
			actor.userId
		) {
			if (!documentDelivery.required) documentDelivery.require()
			// Stills need scenes, not a full campaign: the pack parser refuses a plan
			// without posts and chart data, so this asks for stills alone and parses
			// them leniently. A failed call still yields one usable prompt.
			const planPrompt = buildStillPlanPrompt(questionText)
			const planned = await withTimeout(
				requestStillPlan(env.AI, planPrompt, traceId),
				45_000,
				() => null,
			)
			const plan = parseStillPlan(planned, questionText)
			if (!planned) {
				console.warn(
					`[company-brain][${traceId}] still plan unavailable, shipping one prompt from the request`,
				)
			}
			{
				const promptText = renderStillPrompts(plan)
				const bytes = new TextEncoder().encode(promptText)
				const upload = await uploadSlackFile(slackLookup.botToken, {
					channel: slackLookup.channel,
					threadTs: slackLookup.threadTs,
					filename: "flow-prompts.txt",
					sizeBytes: bytes.byteLength,
					content: bytes.buffer as ArrayBuffer,
					signal: abortSignal,
				})
				if (!upload.ok) {
					console.warn(
						`[company-brain][${traceId}] image prompts upload failed: ${upload.error}`,
					)
				}
				documentDelivery.markDelivered("flow-prompts.txt")
				const preview = promptText.split("\n").slice(0, 3).join("\n")
				await postSlackMessage(
					slackLookup.botToken,
					slackLookup.channel,
					`:art: ${plan.scenes.length} still prompts ready in flow-prompts.txt.
\`\`\`${preview}\`\`\`
Paste the file into the assistant connected to flow-mcp and ask it to draw them — stills are free. Use still 1 as the look reference for the rest, then chain the clips with chain_previous.`,
					slackLookup.threadTs,
				).catch(() => undefined)
			}
		}

		// ── Research report: topic → web research → PDF with charts ──────────
		// Same philosophy as the career documents: the model judges, the code
		// renders. The research notes come from the keyless search path, so a
		// report works even with no search provider key set.
		const wantsResearchReport = matchesTurnRoute("research-report", questionText)
		let reportDelivery: {
			title: string
			fileName: string
			pages: number
			charts: number
		} | null = null
		if (wantsResearchReport && slackLookup && !scheduledRun && env.AI) {
			if (!documentDelivery.required) documentDelivery.require()
			console.log(
				`[company-brain][${traceId}] research report pipeline engaged topic="${questionText.slice(0, 120)}"`,
			)
			// The gate must hold even when the pipeline fails: the sandbox family
			// is locked for the rest of the turn (a playbook naming sandbox_*
			// tools can no longer unlock it), so the model cannot hand-build an
			// unvalidated report.pdf and deliver the exact document this
			// pipeline exists to prevent.
			toolDiscovery.lock(["sandbox"])
			for (const name of Object.keys(tools)) {
				if (name.startsWith("sandbox_")) delete tools[name]
			}
			try {
				// Phase 1 — plan: what must the document contain? Code validates the
				// plan, so the draft later has a concrete contract to fail against.
				const plan = await withTimeout(
					requestReportPlan(env.AI, { topic: questionText, instruction: questionText }, traceId),
					45_000,
					() => null,
				)
				if (plan) {
					console.log(
						`[company-brain][${traceId}] report plan: sections=${plan.sections.length} tables=${plan.tables.length} facts=${plan.facts.length} queries=${plan.searchQueries.length}`,
					)
				}
				// Phase 2 — research, pointed at the plan's data needs.
				const notes = await gatherResearchNotes(
					env,
					questionText,
					plan ? plan.searchQueries : [],
				)
				// Phase 3+4 — draft, validate against the plan by code, repair once.
				let spec: ReturnType<typeof parseReportSpec> = null
				let failures: string[] = []
				for (let attempt = 1; attempt <= 2; attempt += 1) {
					const planText = await withTimeout(
						requestReportSpec(
							env.AI,
							{
								topic: questionText,
								instruction: questionText,
								notes,
								plan,
								failures: attempt > 1 ? failures : undefined,
							},
							traceId,
						),
						60_000,
						() => null,
					)
					const draft = parseReportSpec(planText)
					if (!draft) {
						failures = ["the reply was not a valid document spec"]
						continue
					}
					const verdict = validateReportSpec(draft, plan, questionText)
					if (verdict.ok) {
						spec = draft
						break
					}
					failures = verdict.failures
					console.warn(
						`[company-brain][${traceId}] report validation failed (attempt ${attempt}): ${failures.join(" | ")}`,
					)
				}
				if (!spec) {
					console.warn(
						`[company-brain][${traceId}] report failed validation after repair, leaving the report to the model`,
					)
				} else {
				// Phase 5 -- art direction resolved: do NOT use flow-mcp or any external
				// image model for PDF covers. The cover must be deterministic and sandboxed.
				// Priority: (1) reuse the workspace hero if it exists; (2) render a
				// deterministic LaTeX/TikZ cover from the art prompt in-sandbox; (3) build
				// without imagery.
				let coverBase64: string | undefined
				if (plan?.art?.coverPrompt) {
					if (plan.art.reuseExistingHero) {
						coverBase64 = (await env.BRAIN_KV.get(`render:hero:${org.id}`)) ?? undefined
					} else {
						// Render a deterministic cover in-sandbox (no external image models).
					const coverResult = await renderSandboxedCover({
						client: createSandboxClient(env),
						orgId: org.id,
						coverPrompt: plan.art.coverPrompt,
						traceId,
					})
					coverBase64 = coverResult.ok ? coverResult.coverBase64 : undefined
					}
				}
				const upload = await deliverReport({
					client: createSandboxClient(env),
					spec,
					coverBase64,
					traceId,
					upload: async (file) => {
						const result = await uploadSlackFile(slackLookup.botToken, {
							channel: slackLookup.channel,
							threadTs: slackLookup.threadTs,
								filename: file.fileName,
								sizeBytes: file.sizeBytes,
								content: file.content,
								signal: abortSignal,
							})
							return result.ok
								? { ok: true, fileId: result.fileId }
								: { ok: false, error: `${result.stage}: ${result.error}` }
						},
					}).catch((error) => ({
						ok: false as const,
						error: error instanceof Error ? error.message : String(error),
					}))
					if (upload.ok) {
						reportDelivery = {
							title: spec.title,
							fileName: upload.fileName,
							pages: upload.pages,
							charts: upload.charts,
						}
						documentDelivery.markDelivered(upload.fileName)
						for (const name of Object.keys(tools)) {
							if (name.startsWith("sandbox_")) delete tools[name]
						}
						console.log(
							`[company-brain][${traceId}] research report delivered; sandbox tools withdrawn for this turn`,
						)
					} else {
						console.warn(
							`[company-brain][${traceId}] deterministic report build failed, falling back to the model: ${upload.error}`,
						)
					}
				}
			} catch (error) {
				console.warn(
					`[company-brain][${traceId}] research report pipeline failed:`,
					error instanceof Error ? error.message : String(error),
				)
			}
		}

		let workspacePrompt: string | null = null
		try {
			workspacePrompt = getWorkspacePrompt(agent)
		} catch {
			console.warn(
				`[company-brain][${traceId}] workspace_prompt lookup failed org=${org.id}`,
			)
		}
		console.log(
			`[company-brain][${traceId}] prompt context ready mode=lazy companyContext=${companyContext ? "yes" : "no"} ambientBrainProfile=${brainMemoryContext ? "yes" : "no"} interactionStyle=${interactionStyleProfile ? "yes" : "no"} workspacePrompt=${workspacePrompt ? "yes" : "no"} availableSkills=${availableSkillsContextText ? "yes" : "no"} preloadedSkills=${preloadedSkillsContextText ? "yes" : "no"} directoryAvailable=${directory?.length ?? 0} hasApps=${hasApps ? "yes" : "no"}`,
		)
		touchTurnState(state)
		const baseRuntimePrompt = buildRuntimeContextPrompt({
			asker,
			interaction,
			companyContext: companyContext ?? undefined,
			brainMemoryContext: brainMemoryContext ?? undefined,
			interactionStyle:
				renderInteractionStyle(interactionStyleProfile) ?? undefined,
			workspacePrompt: workspacePrompt ?? undefined,
			availableSkillsContext: availableSkillsContextText,
			preloadedSkillsContext: preloadedSkillsContextText,
			threadParticipants,
			workspaceGroups,
		})
		const runtimePrompt = [
			baseRuntimePrompt,
			baseCv ? renderBaseCvContext(baseCv) : "",
			careerDelivery ? renderCareerDeliveryContext(careerDelivery.documents) : "",
			reportDelivery
				? renderReportDeliveryContext(reportDelivery)
				: "",
			campaignDraft
				? `<campaign_pack>\nThe campaign pack was built and shared above: social card (PNG) and campaign brief (PDF). The primary post is saved as a pending content draft (${campaignDraft.id}) the operator can review and push to Buffer through the content studio. Summarise what was made, name the platforms, and remind them to push the draft when ready — do not repost the content in chat.\n</campaign_pack>`
				: "",
			options?.passiveInvestigation
				? buildPassiveInvocationContext(options.passiveInvestigation.reason)
				: "",
		]
			.filter(Boolean)
			.join("\n\n")
		const currentRequestPrompt = buildCurrentRequestPrompt({
			question,
			loc,
			asker,
			turnSteering: options?.turnSteering,
		})
		const currentUserContent = buildTurnUserContent(
			currentRequestPrompt,
			attachmentParts,
		)
		state.apps.connected = connectedApps.map((app) => ({ ...app }))
		touchTurnState(state)
		const layout = buildTurnMessageLayout({
			profile,
			systemMessages: deps.buildSystemPromptMessages(
				buildActiveSystem(),
				botIdentity,
			),
			runtimeContext: runtimePrompt,
			connectedApps,
			conversationMessages,
			threadText,
			requestText: question,
			requestContent: currentUserContent,
			state,
		})
		const initialMessages = layout.messages
		const threadPromptChars = conversationMessages?.length
			? conversationMessages.reduce(
					(total, message) => total + safeStringify(message.content).length,
					0,
				)
			: threadText.length
		const initialActiveToolNames = toolDiscovery.activeToolNames(
			Object.keys(tools),
		)
		telemetry.markGenerationStart({
			input: [...layout.system, ...initialMessages],
			toolNames: initialActiveToolNames,
			promptStats: {
				systemChars: layout.system.reduce(
					(total, message) => total + message.content.length,
					0,
				),
				runtimeChars: layout.runtimeContext.length,
				threadChars: threadPromptChars,
				threadMessages: conversationMessages?.length ?? 0,
				requestChars: currentRequestPrompt.length,
				contextMode: "lazy",
				hiddenToolCount:
					Object.keys(tools).length - initialActiveToolNames.length,
				lazyToolFamilies: toolDiscovery.availableFamilies(),
			},
		})
		console.log(
			`[company-brain][${traceId}] main model start activeToolCount=${initialActiveToolNames.length} hiddenToolCount=${Object.keys(tools).length - initialActiveToolNames.length} messages=${initialMessages.length} runtimeChars=${layout.runtimeContext.length} threadChars=${threadPromptChars} requestChars=${currentRequestPrompt.length}`,
		)

		let currentRunLiveUpdateMessages: ModelMessage[] = []
		const terminalCaptures = new WeakMap<object, TurnTerminalCapture>()
		const consumeLiveUpdateMessages = (): ModelMessage[] => {
			const control = options?.turnControl
			if (!control) return []
			const updates = consumePendingTurnUpdates(agent, control)
			if (!updates.length) return []
			for (const update of updates) {
				captureBrainTurnUpdateApplied({
					orgId: org.id,
					distinctId: obs?.distinctId ?? userId,
					traceId,
					sessionId: obs?.sessionId,
					messageTs: update.message_ts,
					authorUser: update.author_user,
					authorName: update.author_name,
					outcome: update.outcome,
					revision: update.revision,
				})
			}
			console.log(
				`[company-brain][${traceId}] applied live thread updates count=${updates.length} messages=${updates.map((update) => update.message_ts).join(",")}`,
			)
			return [{ role: "user", content: formatTurnUpdates(updates) }]
		}
		function runTurnModel(
			messages: ModelMessage[],
			attempt: ComputeTurnAttempt,
		) {
			options?.onTerminalProposal?.(null)
			failurePhase = "model_generation"
			const stepSnapshots = new Map<
				number,
				{ input: unknown; toolNames: string[]; startedAt: number }
			>()
			const terminalCapture = createTurnTerminalCapture({
				onProposal: options?.onTerminalProposal,
				refuse: () => documentDelivery.refusal(),
				onRefused: (_proposal, reason) => {
					addTurnWarning(state, `Document not delivered yet: ${reason}`)
					console.log(
						`[company-brain][${traceId}] finish_turn refused: document not delivered`,
					)
				},
			})
			const result = runModelLoop({
				deps,
				env,
				profile,
				system: buildCurrentSystemMessages,
				messages,
				tools,
				activeTools: () => toolDiscovery.activeToolNames(Object.keys(tools)),
				alwaysActiveTools: [FINISH_TURN_TOOL_NAME],
				state,
				attempt,
				// A career document is built, not recalled: give it the paid hops
				// first so the playbook's steps actually get executed.
				preferCapableModel: asksForCareerDocument,
				// A full resume plus a cover letter does not fit the default
				// 4096-token reply cap: the model was cut off mid-document and
				// then finished the turn with a summary of what it had written.
				maxOutputTokens: asksForCareerDocument ? 8192 : undefined,
				// Continuations keep their own smaller cap.
				stepLimit: attempt === "initial" ? stepLimit : undefined,
				terminalCapture,
				suspendRequested: () =>
					Boolean(
						connectedAppRuntime?.pendingApproval() ||
							terminalCapture.requested() ||
							pauseRequested,
					),
				abortSignal,
				onBeforeStep: () => {
					const timeBudget: TimeBudgetPolicyDecision = softPauseEnabled
						? applyTimeBudgetPolicy(
								state,
								Date.now() - attemptStartedAt,
								TURN_PAUSE_BUDGET_MS,
							)
						: { warned: false, wrapUp: false }
					if (timeBudget.wrapUp) pauseRequested = true
					// Only pace the main investigation, and only when a live sink exists.
					if (attempt !== "initial" || !pacingProgress?.narrate) {
						return timeBudget
					}
					if (!pacingInitialized) {
						// Start the clock when the model actually begins, not during setup.
						pacingInitialized = true
						lastUserVisibleAt = Date.now()
						return timeBudget
					}
					applyProgressPacingPolicy(
						state,
						Date.now() - lastUserVisibleAt,
						updatesSent > 0,
					)
					return timeBudget
				},
				prepareMessages: (stepMessages) => {
					currentRunLiveUpdateMessages.push(...consumeLiveUpdateMessages())
					// Defensive: the initial turn never ends on an approval
					// response, but a re-prompted step could, and the SDK only
					// executes an approved call when that response is last.
					return appendKeepingApprovalLast(
						stepMessages,
						currentRunLiveUpdateMessages,
					)
				},
				functionId:
					attempt === "initial"
						? "company-brain-turn"
						: "company-brain-live-update",
				onPreparedStep: (snapshot) => {
					stepSnapshots.set(snapshot.stepNumber, snapshot)
				},
				onStepFinish: async (event) => {
					const snapshot = stepSnapshots.get(event.stepNumber)
					const outputChoices =
						event.response?.messages
							?.filter((message) => message.role === "assistant")
							.map((message) => ({
								role: "assistant",
								content: message.content,
							})) ?? []
					telemetry.captureStepGeneration({
						attempt,
						stepNumber: event.stepNumber,
						input: event.request?.body ?? snapshot?.input ?? messages,
						outputChoices,
						inputTokens: event.usage?.inputTokens,
						outputTokens: event.usage?.outputTokens,
						cachedInputTokens: event.usage?.inputTokenDetails?.cacheReadTokens,
						servingModel: event.response?.modelId,
						toolNames:
							snapshot?.toolNames ??
							toolDiscovery.activeToolNames(Object.keys(tools)),
						latencyMs: snapshot ? Date.now() - snapshot.startedAt : undefined,
						...degradedAsError(event.providerMetadata),
					})
				},
				onFinish: async (event) => {
					const usage = event.totalUsage ?? event.usage
					telemetry.recordCacheHitTokens(
						usage?.inputTokenDetails?.cacheReadTokens,
					)
					totalInputTokens += usage?.inputTokens ?? 0
					totalOutputTokens += usage?.outputTokens ?? 0
					// Real USD from provider response (e.g. xAI cost_in_usd_ticks), not a price table.
					recordFinishEvent(costLedger, event, profile.name)
					lastProviderOutputChoices =
						event.response?.messages
							?.filter((message) => message.role === "assistant")
							.map((message) => ({
								role: "assistant",
								content: message.content,
							})) ?? []
				},
				onError: ({ error }) => {
					console.warn(
						`[company-brain][${traceId}] streamText ${attempt} error:`,
						error,
					)
					try {
						console.warn(
							`[company-brain][${traceId}] streamText ${attempt} error details: name=${(error as { name?: unknown })?.name} message=${(error as { message?: unknown })?.message} statusCode=${(error as { statusCode?: unknown })?.statusCode} responseBody=${JSON.stringify((error as { responseBody?: unknown })?.responseBody)} url=${(error as { url?: unknown })?.url} cause=${JSON.stringify((error as { cause?: unknown })?.cause)}`,
						)
					} catch (logErr) {
						console.warn(
							`[company-brain][${traceId}] streamText ${attempt} error detail log failed:`,
							logErr,
						)
					}
				},
				onToolCallStart: async (event: BrainToolCallEvent) => {
					const terminalProposal = terminalCapture.record(event.toolCall)
					if (terminalProposal) {
						telemetry.recordTerminalProposal(
							terminalProposal.outcome,
							terminalCapture.count() > 1,
						)
						console.log(
							`[company-brain][${traceId}] terminal proposal outcome=${terminalProposal.outcome} replyChars=${terminalProposal.reply.length}`,
						)
						return
					}
					telemetry.onToolCallStart(event.toolCall.toolCallId)
					console.log(
						`[company-brain][${traceId}] tool start id=${event.toolCall.toolCallId} name=${event.toolCall.toolName} input=${logToolInput(event.toolCall)}`,
					)
					await showProgressCard(
						event.toolCall.toolCallId,
						event.toolCall.toolName,
						event.toolCall,
					)
				},
				onToolCallFinish: async (event: BrainToolCallEvent) => {
					if (event.toolCall.toolName === FINISH_TURN_TOOL_NAME) return
					const output = getToolFinishOutput(event)
					recordConnectedAppTrajectory(state, {
						tool: event.toolCall.toolName,
						input: event.toolCall.input,
						output,
						status: event.success ? "ok" : "error",
					})
					telemetry.onToolCallFinish({
						toolCallId: event.toolCall.toolCallId,
						toolName: event.toolCall.toolName,
						success: event.success ?? false,
						input: event.toolCall.input,
						output,
					})
					console.log(
						`[company-brain][${traceId}] tool finish id=${event.toolCall.toolCallId} name=${event.toolCall.toolName} success=${event.success} output=${output === undefined ? "unavailable" : redactedPreview(output, event.success ? 4000 : 8000)}`,
					)
					if (event.success) {
						toolTrace.push({
							tool: event.toolCall.toolName,
							input: event.toolCall.input,
							output:
								typeof output === "string"
									? output.slice(0, 2000)
									: output === undefined
										? undefined
										: safeStringify(output).slice(0, 2000),
						})
					}
					if (shouldShowToolProgressCard(event.toolCall.toolName)) {
						await progress?.card(
							event.toolCall.toolCallId,
							await toolLabel(event.toolCall.toolName, event.toolCall),
							event.success ? "complete" : "error",
							event.success
								? cardOutputPayload(event.toolCall.toolName, output)
								: undefined,
						)
					}
				},
			})
			terminalCaptures.set(result, terminalCapture)
			return result
		}

		async function suspendedApprovalResult(
			result: ReturnType<typeof runTurnModel>,
			sourceMessages: ModelMessage[],
		): Promise<ComputeTurnResult | "retry_live_updates" | null> {
			const nativeApprovals = await findApprovalRequests(result)
			const connectedAppPause = connectedAppRuntime?.pendingApproval()
			let approvals = connectedAppPause
				? [connectedAppPause.request]
				: nativeApprovals
			throwIfAborted(abortSignal)
			let approval = batchApproval(approvals)
			if (!approval) return null
			failurePhase = "approval_handshake"
			if (
				options?.turnControl &&
				!claimThreadTurnApprovalIfInboxEmpty(agent, options.turnControl)
			) {
				await waitForTurnUpdateClassification(
					agent,
					options.turnControl,
					abortSignal,
				)
				if (!claimThreadTurnApprovalIfInboxEmpty(agent, options.turnControl)) {
					return "retry_live_updates"
				}
			}
			const { messages } = await result.response
			const conversation = [
				...sourceMessages,
				...currentRunLiveUpdateMessages,
				...messages,
			]
			if (!connectedAppPause) {
				approvals = approvals.map((item) =>
					enrichApprovalRequestFromMessages(item, conversation),
				)
			}
			approval = batchApproval(approvals) ?? approval
			if (options?.passiveInvestigation) {
				console.warn(
					`[company-brain][${traceId}] passive investigation suppressed approval request tool=${approval.toolName}`,
				)
				telemetry.finishTurn({
					outputChoices: [{ role: "assistant", content: PASSIVE_NO_REPLY }],
					turnStatus: "completed_silent",
					inputTokens: totalInputTokens || undefined,
					outputTokens: totalOutputTokens || undefined,
					turnState: state,
				})
				return {
					status: "completed",
					reply: "",
					memory: null,
					connect: null,
					silentConclusion: true,
				}
			}
			state.pendingApproval = {
				executionId: connectedAppPause?.ref.executionId ?? approval.approvalId,
				method: approval.slug ?? approval.toolName,
				summary: approval.summary,
			}
			touchTurnState(state)
			telemetry.recordApproval(approvals.length)
			console.log(
				`[company-brain][${traceId}] approval requested count=${approvals.length} id=${approval.approvalId} tool=${approval.toolName} slug=${approval.slug ?? "-"} input=${redactedPreview(approval.input, 2000)}`,
			)
			telemetry.finishTurn({
				outputChoices: lastProviderOutputChoices,
				turnStatus: "waiting_approval",
				inputTokens: totalInputTokens || undefined,
				outputTokens: totalOutputTokens || undefined,
				turnState: state,
			})
			return {
				status: "suspended",
				approval,
				state: {
					userId,
					actor,
					question,
					messages: compactMessagesAtBoundary(conversation, {
						activeDiscoveryApps: Object.keys(state.apps.discovered),
					}),
					approvalIds: approvals.map((item) => item.approvalId),
					connectedAppPause: connectedAppPause?.ref,
					turnState: restoreTurnState(state),
					assembly: snapshotTurnToolAssembly(
						assemblyArgs,
						toolDiscovery.enabledFamilies(),
					),
					botIdentity,
					detailedAppPolicy,
					memoryScope: slackLookup?.memoryScope,
					memoryTagSlackUserIds: input.memoryTagSlackUserIds,
					memory: capture.memory,
					turnControl: options?.turnControl,
					terminalProposal: terminalCaptures.get(result)?.selected(),
				},
			}
		}

		async function readTurnOutput(
			result: ReturnType<typeof runTurnModel>,
		): Promise<{
			reply: string
			memory: MemoryWriteback
			connect: string[] | null
			silentConclusion?: boolean
			reaction?: string
			extraBlocks?: unknown[]
		}> {
			failurePhase = "output_read"
			throwIfAborted(abortSignal)
			const terminalProposal = terminalCaptures.get(result)?.selected()
			const selected = await selectTurnReply({
				result,
				terminalProposal,
			})
			throwIfAborted(abortSignal)
			const { reply } = selected
			telemetry.recordReplySource(selected.source)
			reportLegacyStructuredReply(reply, traceId)
			if (selected.source === "response") {
				salvaged = true
				telemetry.recordSalvaged()
			}
			if (options?.passiveInvestigation && isPassiveNoReply(reply)) {
				return {
					reply: "",
					memory: null,
					connect: null,
					silentConclusion: true,
				}
			}
			// Personality expression rides the delivered reply. The model
			// proposes (reaction + GIF candidate id); the server validates the
			// preset, outcome gate, workspace-prompt opt-out, and the per-turn
			// GIF registry, dropping silently on any failure.
			const expressive = reply.trim()
				? resolveTurnExpressiveDelivery({
						preset: personalityPreset,
						workspacePrompt,
						outcome: terminalProposal?.outcome,
						scheduledRun,
						proposal: terminalProposal,
						resolveGifId: (id) => gifCandidates.get(id),
					})
				: {}
			return {
				reply,
				memory: capture.memory,
				connect: capture.connect,
				reaction: expressive.reaction,
				extraBlocks: expressive.extraBlocks,
			}
		}

		const compactContinuation = (messages: ModelMessage[]): ModelMessage[] =>
			compactMessagesAtBoundary(messages, {
				activeDiscoveryApps: Object.keys(state.apps.discovered),
			})

		// A clean step-boundary pause. Unlike a timeout this is cooperative: every
		// tool call in the last step has settled, so the envelope below is a coherent
		// conversation rather than a snapshot of work still in flight.
		const pausedTurnResult = (
			messages: ModelMessage[],
		): Extract<ComputeTurnResult, { status: "paused" }> => {
			failurePhase = "completion"
			telemetry.finishTurn({
				outputChoices: lastProviderOutputChoices,
				turnStatus: "paused",
				inputTokens: totalInputTokens || undefined,
				outputTokens: totalOutputTokens || undefined,
				turnState: state,
			})
			console.log(
				`[company-brain][${traceId}] turn paused at a step boundary messages=${messages.length}`,
			)
			try {
				const checkpoint = buildThreadInvestigationCheckpoint({
					state,
					// No answer exists, so none is invented: only the structured work
					// travels, and any prior answer carries forward untouched.
					answer: "",
				})
				if (checkpoint) {
					state.checkpoint = saveThreadInvestigation({
						agent,
						threadKey: state.request.threadKey,
						principalKey: investigationPrincipal,
						checkpoint,
					})
				}
			} catch (error) {
				console.warn(
					`[company-brain][${traceId}] checkpoint unavailable on pause: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			return {
				status: "paused",
				state: {
					userId,
					actor,
					question,
					messages: compactContinuation(messages),
					// Empty: a time pause carries no approval, so the resume must not
					// inject a tool-approval-response for anything.
					approvalIds: [],
					turnState: restoreTurnState(state),
					assembly: snapshotTurnToolAssembly(
						assemblyArgs,
						toolDiscovery.enabledFamilies(),
					),
					botIdentity,
					detailedAppPolicy,
					memoryScope: slackLookup?.memoryScope,
					memoryTagSlackUserIds: input.memoryTagSlackUserIds,
					memory: capture.memory,
					turnControl: options?.turnControl,
					terminalProposal: undefined,
				},
			}
		}
		let sourceMessages = initialMessages
		let attempt: ComputeTurnAttempt = "initial"
		let output: Awaited<ReturnType<typeof readTurnOutput>> | undefined
		const finalizationAdapter: TurnFinalizationAdapter<
			ReturnType<typeof runTurnModel>,
			Awaited<ReturnType<typeof readTurnOutput>>
		> = {
			reply: {
				read: readTurnOutput,
			},
			liveUpdates: {
				current: () => currentRunLiveUpdateMessages,
				consume: consumeLiveUpdateMessages,
			},
			observe: {
				finalClaim: () => {
					failurePhase = "turn_finalization"
				},
			},
		}
		while (!output) {
			throwIfAborted(abortSignal)
			currentRunLiveUpdateMessages = []
			const result = runTurnModel(sourceMessages, attempt)
			const approval = await suspendedApprovalResult(result, sourceMessages)
			if (approval && approval !== "retry_live_updates") return approval
			if (approval === "retry_live_updates") {
				const pendingMessages = consumeLiveUpdateMessages()
				if (!pendingMessages.length) {
					throwIfAborted(abortSignal)
					throw new Error("approval claim failed without a pending update")
				}
				const response = await result.response
				sourceMessages = compactContinuation([
					...sourceMessages,
					...currentRunLiveUpdateMessages,
					...response.messages,
					...pendingMessages,
				])
				attempt = "live_update"
				capture.memory = null
				capture.connect = null
				continue
			}

			const settlement = await settleTurn({
				run: { result, messages: sourceMessages },
				adapter: finalizationAdapter,
				activeDiscoveryApps: Object.keys(state.apps.discovered),
				coordination: options?.turnControl
					? {
							agent,
							control: options.turnControl,
							traceId,
							origin: "initial",
						}
					: undefined,
				abortSignal,
			})
			if (settlement.status === "publish") {
				output = settlement.candidate
				break
			}
			// The model did not settle an answer and the time budget is spent: stop at
			// this boundary with a full resume envelope rather than begin a step it
			// cannot finish. A publishable answer always wins over pausing.
			if (pauseRequested) {
				return pausedTurnResult(settlement.messages)
			}
			sourceMessages = settlement.messages
			attempt = "live_update"
			capture.memory = null
			capture.connect = null
		}

		let { reply, memory, connect, reaction, extraBlocks } = output
		throwIfAborted(abortSignal)
		if (output.silentConclusion) {
			console.log(
				`[company-brain][${traceId}] passive investigation concluded silently`,
			)
			telemetry.finishTurn({
				outputChoices: [{ role: "assistant", content: PASSIVE_NO_REPLY }],
				turnStatus: "completed_silent",
				inputTokens: totalInputTokens || undefined,
				outputTokens: totalOutputTokens || undefined,
				turnState: state,
			})
			return {
				status: "completed",
				reply: "",
				memory: null,
				connect: null,
				toolTrace,
				salvaged,
				silentConclusion: true,
			}
		}
		if (options?.passiveInvestigation) {
			memory = null
			connect = null
		}
		if (!reply.trim()) {
			telemetry.recordCannedAnswer()
			reply = EMPTY_REPLY
			// A canned reply never celebrates: drop any proposed flourish.
			reaction = undefined
			extraBlocks = undefined
		}
		if (!options?.passiveInvestigation && !ephemeral) {
			try {
				const checkpoint = buildThreadInvestigationCheckpoint({
					state,
					answer: reply,
				})
				if (checkpoint) {
					state.checkpoint = saveThreadInvestigation({
						agent,
						threadKey: state.request.threadKey,
						principalKey: investigationPrincipal,
						checkpoint,
					})
					touchTurnState(state)
				}
			} catch (error) {
				console.warn(
					`[company-brain][${traceId}] thread investigation checkpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
		console.log(
			`[company-brain][${traceId}] final output replyChars=${reply.length} memoryCount=${memoryDocsFromWriteback(memory).length} connect=${connect ?? "-"}`,
		)
		failurePhase = "completion"
		telemetry.finishTurn({
			outputChoices: [{ role: "assistant", content: reply }],
			turnStatus: salvaged ? "completed_salvaged" : "completed",
			inputTokens: totalInputTokens || undefined,
			outputTokens: totalOutputTokens || undefined,
			turnState: state,
		})
		return {
			status: "completed",
			reply,
			memory,
			connect,
			toolTrace,
			salvaged,
			narrated: state.surfacedUpdates.length > 0,
			nativeCallCount: state.nativeCalls.length,
			reaction,
			extraBlocks,
		}
	}

	const turn = runTurn()
	let turnSettled = false
	const settled = () => {
		turnSettled = true
	}
	turn.then(settled, settled)
	let abandoned = false
	try {
		return await raceWithAbortSignal(turn, abortSignal)
	} catch (error) {
		abandoned = !turnSettled
		finishFailedTurn(error)
		throw error
	} finally {
		let chargedOps = 0
		const charge = async (): Promise<void> => {
			chargedOps += await scheduleChargeBrainLlmCost({
				orgId: org.id,
				ledger: costLedger,
				source: skipBilling ? "compute_turn_internal" : "compute_turn",
				traceId,
				env,
				chargedOps,
				skipBilling,
			})
		}
		// Bill now: an abandoned turn may never settle, and usage must not be lost.
		brainAgent(agent).waitUntil(
			abandoned ? charge().then(() => turn.then(charge, charge)) : charge(),
		)
		await assembled.mcpClose?.()
	}
}
