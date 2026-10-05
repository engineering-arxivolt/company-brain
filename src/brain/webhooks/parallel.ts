import { z } from "zod"

// Parallel Monitor webhook payloads, per
// docs.parallel.ai/monitor-api/monitor-webhooks.
//
// `metadata` is the routing channel: whoever creates a monitor writes the origin
// Slack surface into it, and Parallel echoes it back on every delivery. That is
// what lets a monitor post into whichever channel it was asked for from, with
// no server-side channel mapping table.

export const PARALLEL_MONITOR_EVENT_TYPES = [
	"monitor.event.detected",
	"monitor.execution.completed",
	"monitor.execution.failed",
] as const

export type ParallelMonitorEventType =
	(typeof PARALLEL_MONITOR_EVENT_TYPES)[number]

/** Routing metadata stamped on monitor creation and echoed back on delivery. */
export const ParallelRouteMetadataSchema = z.object({
	orgId: z.string().min(1),
	teamId: z.string().min(1),
	channelId: z.string().min(1),
	/** Set when the request came from a thread so replies stay in-thread. */
	threadTs: z.string().min(1).optional(),
})

export type ParallelRouteMetadata = z.infer<
	typeof ParallelRouteMetadataSchema
>

export const ParallelMonitorWebhookSchema = z.object({
	type: z.enum(PARALLEL_MONITOR_EVENT_TYPES),
	timestamp: z.string().optional(),
	data: z
		.object({
			monitor_id: z.string().optional(),
			event: z
				.object({
					event_group_id: z.string().optional(),
					type: z.string().optional(),
					error: z.string().optional(),
				})
				.optional(),
			metadata: z.unknown().optional(),
		})
		.optional(),
})

export type ParallelMonitorWebhook = z.infer<
	typeof ParallelMonitorWebhookSchema
>

export type ParallelDelivery = {
	type: ParallelMonitorEventType
	monitorId?: string
	eventGroupId?: string
	route?: ParallelRouteMetadata
	/** Human-readable failure text, for the failed event only. */
	error?: string
}

/**
 * Narrow a verified delivery to a routing decision.
 *
 * A delivery we cannot route is not an error: Parallel retries for 48h, so a
 * payload we cannot place must still return 2xx, otherwise every retry storms
 * us for two days. `route: undefined` tells the caller to acknowledge silently.
 */
export function resolveParallelDelivery(
	payload: unknown,
): ParallelDelivery | null {
	const parsed = ParallelMonitorWebhookSchema.safeParse(payload)
	if (!parsed.success) return null

	const { type, data } = parsed.data
	const event = data?.event
	// Parse metadata independently: an unroutable delivery is still routable
	// *through* the 2xx path, it just cannot be posted anywhere.
	const route = (() => {
		const r = ParallelRouteMetadataSchema.safeParse(data?.metadata)
		return r.success ? r.data : undefined
	})()

	return {
		type,
		monitorId: data?.monitor_id,
		eventGroupId: event?.event_group_id,
		route,
		error: event?.error,
	}
}

/**
 * A delivery that carries both a `detected` event and a usable route.
 *
 * Modelled as a distinct type rather than left implicit at the call site because
 * `type` and `route` are what every downstream consumer reads: the route builds a
 * turn from them, so a widened `ParallelMonitorEventType` or an optional
 * `route?` would only be caught at runtime, after the delivery was acknowledged.
 */
export type PostableParallelDelivery = ParallelDelivery & {
	type: "monitor.event.detected"
	route: ParallelRouteMetadata
}

/**
 * Only a detected event should ever produce a message. A completed run means
 * Parallel checked and found nothing material, and a failed run is internal
 * noise; treating either as news is how a bot gets muted.
 *
 * A type predicate rather than a plain boolean: callers that pass this guard are
 * entitled to a narrowed `type` and a non-optional `route`, which is what makes
 * the guarantee checkable at build time instead of only at 3am.
 */
export function parallelDeliveryShouldPost(
	delivery: ParallelDelivery,
): delivery is PostableParallelDelivery {
	return delivery.type === "monitor.event.detected" && Boolean(delivery.route)
}

/** Guarded against a runaway monitor producing an unbounded prompt. */
const MAX_CONTENT_CHARS = 12_000
const MAX_CITATIONS = 5
const MAX_CITATION_EXCERPT_CHARS = 400
const FETCH_TIMEOUT_MS = 8_000

const PARALLEL_API_BASE = "https://api.parallel.ai/v1"

const CitationSchema = z.object({
	title: z.string().optional().nullable(),
	url: z.string().optional().nullable(),
	excerpts: z.array(z.string()).optional().nullable(),
})

const EventSchema = z.object({
	event_id: z.string().optional(),
	event_group_id: z.string().optional(),
	output: z
		.object({
			content: z.string().optional().nullable(),
			basis: z
				.array(
					z.object({
						field: z.string().optional(),
						reasoning: z.string().optional(),
						confidence: z.string().optional().nullable(),
						citations: z.array(CitationSchema).optional(),
					}),
				)
				.optional(),
		})
		.optional(),
})

const EventsResponseSchema = z.object({
	events: z.array(EventSchema),
})

const CreatedMonitorSchema = z.object({
	monitor_id: z.string().optional(),
	status: z.string().optional(),
})

export type ParallelEvent = z.infer<typeof EventSchema>

/**
 * Pull the finding behind a delivery.
 *
 * A webhook payload is only a pointer: it names the execution via
 * `event_group_id` and never carries the content. `event_group_id` narrows this
 * to the single run that fired, so an earlier or later run's events can never be
 * mixed in. Returns null on any failure: the webhook was already acknowledged,
 * so a fetch problem must degrade to saying less rather than surfacing an error
 * that would make Parallel retry for two days.
 */
export async function fetchParallelMonitorEvents(args: {
	apiKey: string
	monitorId: string
	eventGroupId?: string
}): Promise<ParallelEvent[] | null> {
	const url = new URL(
		`${PARALLEL_API_BASE}/monitors/${encodeURIComponent(args.monitorId)}/events`,
	)
	if (args.eventGroupId) {
		url.searchParams.set("event_group_id", args.eventGroupId)
	}
	// A detected run and its completion marker can share an event group;
	// completions carry no content, so fetch them and let the renderer skip them.
	url.searchParams.set("include_completions", "true")
	url.searchParams.set("limit", "20")

	try {
		const res = await fetch(url.toString(), {
			headers: { "x-api-key": args.apiKey },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		})
		if (!res.ok) {
			console.warn(
				`[company-brain] parallel events fetch failed: HTTP ${res.status}`,
			)
			return null
		}
		const parsed = EventsResponseSchema.safeParse(await res.json())
		if (!parsed.success) {
			console.warn("[company-brain] parallel events response malformed")
			return null
		}
		return parsed.data.events
	} catch (err) {
		console.warn(
			"[company-brain] parallel events fetch error:",
			err instanceof Error ? err.message : String(err),
		)
		return null
	}
}

/**
 * Render fetched events into the context a turn reasons over.
 *
 * Citations are the provenance for the claim, so they ride along with the
 * finding; a citation without a url is dropped because it cannot be verified or
 * linked by whoever reads the reply.
 */
export function formatParallelEventsForTurn(
	events: ParallelEvent[],
): string | null {
	const parts: string[] = []
	for (const event of events) {
		const content = event.output?.content?.trim()
		if (!content) continue
		let block = content.slice(0, MAX_CONTENT_CHARS)

		const citations = (event.output?.basis ?? [])
			.flatMap((b) => b.citations ?? [])
			.filter((c) => typeof c.url === "string" && c.url.length > 0)
			.slice(0, MAX_CITATIONS)
		if (citations.length > 0) {
			const lines = citations.map((c) => {
				const title = c.title?.trim()
				const cite = title ? `${title} — ${c.url}` : (c.url as string)
				const excerpt = c.excerpts?.filter(Boolean).join(" ").trim()
				return excerpt
					? `- ${cite}\n  ${excerpt.slice(0, MAX_CITATION_EXCERPT_CHARS)}`
					: `- ${cite}`
			})
			block += `\n\nSources:\n${lines.join("\n")}`
		}
		parts.push(block)
	}
	if (parts.length === 0) return null
	return parts.join("\n\n---\n\n")
}

/** Parallel accepts only `lite` or `base`; `lite` is the cheaper default. */
const DEFAULT_PROCESSOR = "lite"

/**
 * Parallel bounds `frequency` to 1h..30d, so a schedule outside that range can
 * never be honored. Clamping here turns a 422 into a monitor that still runs.
 */
function clampFrequency(frequency: string): string {
	const match = /^(\d+)([hdw])$/.exec(frequency.trim().toLowerCase())
	if (!match) return "1d"
	const value = Number(match[1])
	const unit = match[2]
	if (!Number.isFinite(value) || value < 1) return "1h"
	const hours = unit === "h" ? value : unit === "d" ? value * 24 : value * 24 * 7
	if (hours < 1) return "1h"
	if (hours > 24 * 30) return "30d"
	return `${value}${unit}`
}

/**
 * Metadata is the routing channel: Parallel echoes it back on every delivery,
 * and our resolver reads exactly these keys. Keys are capped at 16 chars and
 * values at 512 upstream, so both are enforced here rather than as a surprise
 * 422 at the point someone asks to be watched.
 */
export function assertRoutableMetadata(
	metadata: ParallelRouteMetadata,
): void {
	for (const [key, value] of Object.entries(metadata)) {
		if (key.length > 16) {
			throw new Error(
				`Parallel metadata key "${key}" is ${key.length} chars; the limit is 16.`,
			)
		}
		if (value.length > 512) {
			throw new Error(
				`Parallel metadata "${key}" is ${value.length} chars; the limit is 512.`,
			)
		}
	}
}

export type CreateMonitorArgs = {
	apiKey: string
	/** Absolute HTTPS URL of the webhook route, e.g. https://…/brain/webhooks/parallel. */
	webhookUrl: string
	query: string
	frequency: string
	route: ParallelRouteMetadata
	processor?: "lite" | "base"
}

/**
 * Create the monitor that produces the deliveries this package consumes.
 *
 * The run happens immediately on creation and then on the schedule, so the
 * `detected` filter upstream is doing real work: a completion with nothing
 * material must never become a Slack message.
 *
 * Throws on failure rather than returning null: this runs inside a brain turn
 * that will report the error back to the person who asked to be watched, so
 * swallowing it would strand them with a monitor that silently does not exist.
 */
export async function createParallelMonitor(
	args: CreateMonitorArgs,
): Promise<string> {
	assertRoutableMetadata(args.route)

	const res = await fetch(`${PARALLEL_API_BASE}/monitors`, {
		method: "POST",
		headers: {
			"x-api-key": args.apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			type: "event_stream",
			frequency: clampFrequency(args.frequency),
			processor: args.processor ?? DEFAULT_PROCESSOR,
			settings: { query: args.query },
			webhook: {
				url: args.webhookUrl,
				// Only `detected` can become a message. Subscribing to completed or
				// failed would mean paying for deliveries the receiver discards.
				event_types: ["monitor.event.detected"],
			},
			metadata: args.route,
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})

	if (!res.ok) {
		const text = await res.text().catch(() => "")
		throw new Error(
			`Parallel monitor create failed HTTP ${res.status}: ${text.slice(0, 500)}`,
		)
	}

	const created = CreatedMonitorSchema.safeParse(await res.json())
	if (!created.success || !created.data.monitor_id) {
		throw new Error("Parallel monitor create returned no monitor_id.")
	}
	return created.data.monitor_id
}