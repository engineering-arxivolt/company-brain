import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// parallel-monitor.ts is the one module in the webhook path that touches the
// Durable Object, Slack, crypto, and the Parallel API at once. All four edges
// are mocked so that the delivery decision itself is what runs.
const {
	getWorkspaceByTeamId,
	postSlackMessage,
	runSlackTurn,
	decryptToken,
	fetchParallelMonitorEvents,
} = vi.hoisted(() => ({
	getWorkspaceByTeamId: vi.fn(),
	postSlackMessage: vi.fn<PostSlackMessage>(async () => "1700000000.000100"),
	runSlackTurn: vi.fn<RunSlackTurn>(async () => {}),
	decryptToken: vi.fn(async () => "xoxb-bot-token"),
	fetchParallelMonitorEvents: vi.fn(),
}))

vi.mock("../slack/workspace", () => ({ getWorkspaceByTeamId }))
vi.mock("../slack/client", () => ({ postSlackMessage }))
vi.mock("../slack/turn", () => ({ runSlackTurn }))
vi.mock("@/lib/crypto", () => ({ decryptToken }))

// `./agent` pulls in the Durable Object runtime, which the Node ESM loader
// cannot resolve ("Received protocol 'cloudflare:'"). Only `brainAgent` is
// used here, and it is a plain cast.
vi.mock("./agent", () => ({
	brainAgent: (agent: unknown) => agent,
}))

// Only the outbound fetch is replaced. `formatParallelEventsForTurn` stays real
// so the text the turn actually receives is covered end to end.
vi.mock("../webhooks/parallel", async (importOriginal) => ({
	...(await importOriginal<typeof import("../webhooks/parallel")>()),
	fetchParallelMonitorEvents,
}))

import type { SlackTurnMessage } from "../slack/events"
import type { RunSlackTurnOptions } from "../slack/turn"
import type { ParallelMonitorEvent } from "./parallel-monitor"
import { runParallelMonitorEvent } from "./parallel-monitor"
import type { CompanyBrainAgent } from "./agent"

// Signatures are spelled out rather than inferred from an empty arrow function.
// A `vi.fn(async () => ...)` infers a zero-argument function, so `mock.calls[0]`
// is an empty tuple that cannot be destructured or indexed -- which is exactly
// what these assertions do. Types only, so they erase before the `./agent`
// mock below ever matters.
type PostSlackMessage = (
	botToken: string,
	channel: string,
	text: string,
	threadTs?: string,
	blocks?: unknown[],
) => Promise<string | undefined>

type RunSlackTurn = (
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	opts?: RunSlackTurnOptions,
) => Promise<void>

/**
 * The arguments of the first (and expected only) call to a mocked Slack edge.
 *
 * Failing loudly when the call never happened keeps a broken assertion from
 * reporting as a confusing downstream mismatch: a function that was never
 * called is the regression, not a detail to paper over with `?? []`.
 */
function firstCall<T extends unknown[]>(calls: readonly T[]): T {
	const call = calls[0]
	if (!call) throw new Error("expected the mocked call to have happened once")
	return call
}

/** The text and thread the first `postSlackMessage` sent. */
function firstPost(): [text: string, threadTs: string | undefined] {
	const [, , text, threadTs] = firstCall(postSlackMessage.mock.calls)
	return [text, threadTs]
}

/** The message and options the first `runSlackTurn` was handed. */
function firstTurn(): [msg: SlackTurnMessage, opts: RunSlackTurnOptions] {
	const [, msg, opts] = firstCall(runSlackTurn.mock.calls)
	if (!opts) throw new Error("expected runSlackTurn to receive options")
	return [msg, opts]
}

const EVENT: ParallelMonitorEvent = {
	type: "monitor.event.detected",
	monitorId: "monitor_abc",
	eventGroupId: "mevtgrp_1",
	teamId: "T01",
	channelId: "C01",
	threadTs: "1699999999.000100",
}

type FakeAgentOptions = {
	orgId?: string
	/**
	 * `null` means the binding is unset. A default parameter would turn an
	 * explicit `undefined` back into "key", which is the exact case the
	 * missing-API-key path needs to express.
	 */
	parallelApiKey?: string | null
}

/** The agent only needs `name` (its org) and `env`; nothing else is touched. */
function fakeAgent(overrides?: FakeAgentOptions): CompanyBrainAgent {
	const apiKey =
		overrides?.parallelApiKey === undefined
			? "key"
			: (overrides.parallelApiKey ?? undefined)
	return {
		name: overrides?.orgId ?? "org_1",
		env: {
			PARALLEL_API_KEY: apiKey,
			ENCRYPTION_SECRET: "s",
		},
	} as unknown as CompanyBrainAgent
}

/** A Parallel run that found something, as the events fetch sees it. */
function foundEvents() {
	return [
		{
			event_id: "evt_1",
			output: {
				content: "Acme cut pricing by 20%.",
				basis: [
					{
						field: "pricing",
						reasoning: "compared to last month",
						citations: [
							{
								title: "Acme pricing",
								url: "https://acme.example/pricing",
								excerpts: ["Now 20% lower."],
							},
						],
					},
				],
			},
		},
	]
}

beforeEach(() => {
	getWorkspaceByTeamId.mockReset()
	getWorkspaceByTeamId.mockResolvedValue({
		orgId: "org_1",
		teamId: "T01",
		botTokenEnc: "enc",
	})
	postSlackMessage.mockClear()
	runSlackTurn.mockClear()
	decryptToken.mockClear()
	fetchParallelMonitorEvents.mockReset()
	// Default to a monitor that found something; individual tests override.
	fetchParallelMonitorEvents.mockResolvedValue(foundEvents())
	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("runParallelMonitorEvent — workspace ownership", () => {
	it("posts nothing when the team has no brain workspace", async () => {
		// Uninstalled or unknown team: there is no channel to post into.
		getWorkspaceByTeamId.mockResolvedValue(null)

		await runParallelMonitorEvent(fakeAgent(), EVENT)

		expect(postSlackMessage).not.toHaveBeenCalled()
		expect(runSlackTurn).not.toHaveBeenCalled()
	})

	it("refuses to post into an org the workspace was rebound away from", async () => {
		// The cross-tenant guard. A delivery addressed to org_1 must never land
		// in org_2 after the Slack workspace is rebound, which would leak one
		// company's monitor finding into another company's channel.
		getWorkspaceByTeamId.mockResolvedValue({
			orgId: "org_2",
			teamId: "T01",
			botTokenEnc: "enc",
		})

		await runParallelMonitorEvent(fakeAgent({ orgId: "org_1" }), EVENT)

		expect(postSlackMessage).not.toHaveBeenCalled()
		expect(runSlackTurn).not.toHaveBeenCalled()
		expect(fetchParallelMonitorEvents).not.toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("workspace rebound"),
		)
	})
})

describe("runParallelMonitorEvent — degraded paths still answer the team", () => {
	it("acknowledges the firing when the Parallel API key is missing", async () => {
		// Silence is the worse failure: a monitor the team is waiting on fired.
		await runParallelMonitorEvent(
			fakeAgent({ parallelApiKey: null }),
			EVENT,
		)

		expect(fetchParallelMonitorEvents).not.toHaveBeenCalled()
		expect(runSlackTurn).not.toHaveBeenCalled()
		expect(postSlackMessage).toHaveBeenCalledTimes(1)
		const [text, threadTs] = firstPost()
		expect(text).toMatch(/could not load the details/)
		expect(threadTs).toBe(EVENT.threadTs)
	})

	it("acknowledges the firing when Parallel returns no readable detail", async () => {
		// The webhook was acknowledged, so a fetch failure must degrade to
		// saying less rather than propagating.
		fetchParallelMonitorEvents.mockResolvedValue(null)

		await runParallelMonitorEvent(fakeAgent(), EVENT)

		expect(runSlackTurn).not.toHaveBeenCalled()
		expect(postSlackMessage).toHaveBeenCalledTimes(1)
		expect(firstPost()[0]).toMatch(/no readable detail/)
	})

	it("acknowledges the firing when the run carried only completion markers", async () => {
		fetchParallelMonitorEvents.mockResolvedValue([
			{ event_id: "c1", output: { content: null } },
		])

		await runParallelMonitorEvent(fakeAgent(), EVENT)

		expect(firstPost()[0]).toMatch(/no readable detail/)
	})

	it("acknowledges the firing when no monitor id was delivered", async () => {
		await runParallelMonitorEvent(fakeAgent(), {
			...EVENT,
			monitorId: undefined,
		})

		expect(fetchParallelMonitorEvents).not.toHaveBeenCalled()
		expect(postSlackMessage).toHaveBeenCalledTimes(1)
	})

	it("does not throw when the Slack post itself fails", async () => {
		postSlackMessage.mockRejectedValueOnce(new Error("channel_not_found"))

		await expect(
			runParallelMonitorEvent(fakeAgent(), EVENT),
		).resolves.toBeUndefined()
	})
})
describe("runParallelMonitorEvent — the threaded turn", () => {
	it("runs a forced turn anchored on the asking thread", async () => {
		await runParallelMonitorEvent(fakeAgent(), EVENT)

		expect(runSlackTurn).toHaveBeenCalledTimes(1)
		const [msg, opts] = firstTurn()
		expect(msg.teamId).toBe(EVENT.teamId)
		expect(msg.event.type).toBe("message")
		expect(msg.event.thread_ts).toBe(EVENT.threadTs)
		// Skipping the participation gate: nobody typed this message.
		expect(opts.forceFullTurn).toBe(true)
		expect(opts.forceThreadTs).toBe(EVENT.threadTs)
		expect(opts.obsSource).toBe("parallel_monitor")
		// There is no real Slack message to put an ack reaction on.
		expect(opts.skipReactions).toBe(true)
	})

	it("passes a finding with its citations into the turn prompt", async () => {
		await runParallelMonitorEvent(fakeAgent(), EVENT)

		const [msg] = firstTurn()
		expect(msg.event.text).toContain("Acme cut pricing by 20%.")
		expect(msg.event.text).toContain("https://acme.example/pricing")
		// The prompt must constrain the turn to read-only investigation.
		expect(msg.event.text).toMatch(/do NOT create, modify, post, send/)
	})

	it("anchors the turn on a synthetic ts, since no Slack message exists", async () => {
		await runParallelMonitorEvent(fakeAgent(), EVENT)

		const [msg] = firstTurn()
		// Slack ts shape: seconds.microseconds. If this ever collided with the
		// thread root, turn dedup by ts would drop the reply.
		expect(msg.event.ts).toMatch(/^\d+\.\d{6}$/)
		expect(msg.event.ts).not.toBe(EVENT.threadTs)
	})

	it("scopes the Parallel query to the delivered execution", async () => {
		await runParallelMonitorEvent(fakeAgent(), EVENT)

		expect(fetchParallelMonitorEvents).toHaveBeenCalledWith({
			apiKey: "key",
			monitorId: "monitor_abc",
			eventGroupId: "mevtgrp_1",
		})
	})

	it("never posts a fallback when the turn has already published", async () => {
		// A fallback post after a partially-successful turn would double-post.
		runSlackTurn.mockRejectedValueOnce(new Error("stream failed after posting"))

		await runParallelMonitorEvent(fakeAgent(), EVENT)

		expect(postSlackMessage).not.toHaveBeenCalled()
		expect(console.error).toHaveBeenCalledWith(
			"[company-brain] parallel monitor turn failed:",
			"stream failed after posting",
		)
	})
})

describe("runParallelMonitorEvent — channel, not thread", () => {
	it("posts the finding directly when there is no thread to reply into", async () => {
		// A forced turn needs a thread to anchor on; guessing a target would
		// post into the wrong place, so the finding goes to the channel.
		await runParallelMonitorEvent(fakeAgent(), {
			...EVENT,
			threadTs: undefined,
		})

		expect(runSlackTurn).not.toHaveBeenCalled()
		expect(postSlackMessage).toHaveBeenCalledTimes(1)
		const [token, channel] = firstCall(postSlackMessage.mock.calls)
		const [text, threadTs] = firstPost()
		expect(token).toBe("xoxb-bot-token")
		expect(channel).toBe(EVENT.channelId)
		expect(text).toContain("Acme cut pricing by 20%.")
		expect(threadTs).toBeUndefined()
	})

	it("does not decrypt a token it will never use", async () => {
		getWorkspaceByTeamId.mockResolvedValue(null)

		await runParallelMonitorEvent(fakeAgent(), EVENT)

		expect(decryptToken).not.toHaveBeenCalled()
	})
})