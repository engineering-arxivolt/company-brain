/**
 * PostHog product analytics + LLM observability, dependency-free.
 *
 * Plain fetch to the PostHog HTTP API. No key configured -> silent no-op
 * (self-hosted sends nothing), so all existing call sites keep working.
 * Optional env: POSTHOG_API_KEY (or POSTHOG_KEY), POSTHOG_HOST.
 * Read lazily via globalThis.__POSTHOG_ENV (set by configurePostHog) or
 * process.env, so unit tests stay keyless. Zero new npm packages.
 *
 * Privacy: call sites pass IDs, model names, bounded metadata only.
 */

type PostHogEnv = {
	POSTHOG_API_KEY?: string
	POSTHOG_KEY?: string
	POSTHOG_HOST?: string
}

type GlobalWithEnv = typeof globalThis & { __POSTHOG_ENV?: PostHogEnv }

function readEnv(): PostHogEnv {
	const g = globalThis as GlobalWithEnv
	const fromGlobal = g.__POSTHOG_ENV ?? {}
	const pe = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
	return {
		POSTHOG_API_KEY: fromGlobal.POSTHOG_API_KEY ?? pe.POSTHOG_API_KEY ?? pe.POSTHOG_KEY,
		POSTHOG_KEY: fromGlobal.POSTHOG_KEY ?? pe.POSTHOG_KEY,
		POSTHOG_HOST: fromGlobal.POSTHOG_HOST ?? pe.POSTHOG_HOST,
	}
}

/** Point PostHog at explicit env (Durable Object hook + tests). */
export function configurePostHog(env: PostHogEnv): void {
	;(globalThis as GlobalWithEnv).__POSTHOG_ENV = env
}

function posthogConfig(): { key: string; host: string } | null {
	const env = readEnv()
	const key = env.POSTHOG_API_KEY ?? env.POSTHOG_KEY
	if (!key?.trim()) return null
	const host = (env.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/+$/, "")
	return { key: key.trim(), host }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false
	const proto = Object.getPrototypeOf(v)
	return proto === Object.prototype || proto === null
}

// PostHog's /batch/ takes the whole queue in one POST, and `$ai_*` events skip
// safeProps entirely (see enqueue), so nothing bounds their size. Measured on
// this project: `$ai_generation` averages 9KB but peaks at 464KB, and a
// connected-app tool result may be up to MCP_SANDBOX_VALUE_CHAR_LIMIT (750k).
// A handful of those in one batch can push the request past the endpoint's
// payload ceiling, and the flush is all-or-nothing — so one runaway event would
// silently drop every other event queued with it. Cap the free-text fields
// well under any plausible ceiling; enough to diagnose from, not enough to
// sink a batch.
const AI_TEXT_LIMIT = 4_000

// A turn prompt runs ~68k chars here: ~28k of system-prompt instructions,
// ~14k of thread history, and the user's actual question at the very end.
// Head-truncating therefore keeps boilerplate and discards the one part worth
// reading, so keep both ends and elide the middle. The tail is weighted larger
// because that is where the live question, the latest tool result, and the
// model's in-flight reasoning sit.
const AI_TEXT_TAIL_RATIO = 0.65

// Exported for tests: the tail-preservation invariant is the whole point of
// this helper, and it is exactly the kind of thing that regresses silently.
export function elideMiddle(value: string, limit: number): string {
	if (value.length <= limit) return value
	const marker = (hidden: number) =>
		`\n…[${hidden.toLocaleString("en-US")} chars elided]…\n`
	const tailLength = Math.floor(limit * AI_TEXT_TAIL_RATIO)
	const headLength = limit - tailLength
	// Reserve room for the marker so the result never exceeds the limit.
	const overhead = marker(value.length).length
	const head = Math.max(0, headLength - Math.ceil(overhead / 2))
	const tail = Math.max(0, tailLength - Math.floor(overhead / 2))
	return `${value.slice(0, head)}${marker(value.length - head - tail)}${value.slice(value.length - tail)}`
}

function boundedAiText(value: unknown): string {
	if (typeof value === "string") return elideMiddle(value, AI_TEXT_LIMIT)
	if (value === undefined) return ""
	try {
		return elideMiddle(JSON.stringify(value) ?? "", AI_TEXT_LIMIT)
	} catch {
		return "[unserializable]"
	}
}

function safeValue(v: unknown, depth = 0): unknown {
	if (v === null) return null
	const t = typeof v
	if (t === "string" || t === "number" || t === "boolean") return v
	if (depth >= 3) return undefined
	if (Array.isArray(v)) {
		const arr = v.slice(0, 20).map((item) => safeValue(item, depth + 1)).filter((x) => x !== undefined)
		return arr
	}
	if (isPlainObject(v)) return safeProps(v, depth + 1)
	return undefined
}

function safeProps(value: unknown, depth = 0): Record<string, unknown> {
	if (!isPlainObject(value)) return {}
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value)) {
		if (v === undefined) continue
		const sv = safeValue(v, depth)
		if (sv !== undefined) out[k] = sv
	}
	return out
}

let queue: Array<Record<string, unknown>> = []
const MAX_QUEUE = 100

function enqueue(event: string, distinctId: string, properties: unknown, groups: unknown): void {
	const cfg = posthogConfig()
	if (!cfg) return
	if (queue.length >= MAX_QUEUE) queue.shift()
	const props = event.startsWith("$ai_") && typeof properties === "object" && properties !== null
		? { ...(properties as Record<string, unknown>), $lib: "company-brain-worker" }
		: { ...safeProps(properties), $lib: "company-brain-worker" }
	queue.push({
		event,
		distinct_id: distinctId,
		properties: props,
		...(groups && typeof groups === "object" ? { groups } : {}),
	})
	if (queue.length >= 20) void flushTelemetry().catch(() => {})
}

function capture(event: string, args: unknown): void {
	const rec = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>
	const distinctId =
		typeof rec.distinctId === "string" && rec.distinctId
			? rec.distinctId
			: typeof rec.userId === "string" && rec.userId
				? rec.userId
				: typeof rec.orgId === "string" && rec.orgId
					? rec.orgId
					: "company-brain"
	// $ai_* calls arrive pre-enveloped; pass their properties through untouched.
	if (event.startsWith("$ai_")) {
		enqueue(event, distinctId, (rec.properties ?? {}) as Record<string, unknown>, rec.groups)
		return
	}
	const rest: Record<string, unknown> = { ...rec }
	delete rest.distinctId
	delete rest.groups
	delete rest.properties
	enqueue(event, distinctId, rest, rec.groups)
}

async function captureAwaitable(event: string, args: unknown): Promise<void> {
	capture(event, args)
	if (queue.length >= 5) await flushTelemetry().catch(() => {})
}
function aiEnvelope(args: Record<string, unknown>): Record<string, unknown> {
	return {
		$ai_trace_id: args.traceId,
		$ai_span_id: args.spanId,
		...(args.parentId !== undefined ? { $ai_parent_span_id: args.parentId } : {}),
		...(args.sessionId !== undefined ? { $ai_session_id: args.sessionId } : {}),
		...(args.spanName !== undefined ? { $ai_span_name: args.spanName } : {}),
		...(args.model !== undefined ? { $ai_model: args.model } : {}),
		...(args.provider !== undefined ? { $ai_provider: args.provider } : {}),
		// These four are the model's raw message arrays and the turn envelope.
		// They are the largest payloads this worker ever emits, and `enqueue`
		// deliberately skips `safeProps` for `$ai_*` events, so nothing else
		// would bound them. Left raw they produced a single 2.16MB
		// `$ai_generation` event against PostHog's 983KB per-event ceiling --
		// which is dropped on arrival, so the turn's most valuable telemetry
		// (the transcript of the step that asked for approval) silently
		// vanished. Bound them exactly like prompt/completion.
		...(args.input !== undefined ? { $ai_input: boundedAiText(args.input) } : {}),
		...(args.inputState !== undefined
			? { $ai_input_state: boundedAiText(args.inputState) }
			: {}),
		...(args.outputChoices !== undefined
			? { $ai_output_choices: boundedAiText(args.outputChoices) }
			: {}),
		...(args.outputState !== undefined
			? { $ai_output_state: boundedAiText(args.outputState) }
			: {}),
		...(args.latencySeconds !== undefined ? { $ai_latency: args.latencySeconds } : {}),
		...(args.isError !== undefined ? { $ai_is_error: args.isError } : {}),
		...(args.error !== undefined ? { $ai_error: boundedAiText(args.error) } : {}),
		// Token usage. Every call site already passed these, but the envelope
		// never mapped them, so 0 of 380 generations carried a token count and
		// no cost or cache-hit analysis was possible. Names follow PostHog's LLM
		// schema, from which it derives total_input_tokens / total_output_tokens.
		...(args.inputTokens !== undefined ? { input_tokens: args.inputTokens } : {}),
		...(args.outputTokens !== undefined
			? { output_tokens: args.outputTokens }
			: {}),
		...(args.totalTokens !== undefined ? { total_tokens: args.totalTokens } : {}),
		...(args.cachedInputTokens !== undefined
			? { cached_input_tokens: args.cachedInputTokens }
			: {}),
		...(args.tools !== undefined ? { $ai_tools: args.tools } : {}),
		...(args.traceName !== undefined ? { $ai_trace_name: args.traceName } : {}),
		...(args.prompt !== undefined ? { $ai_prompt: boundedAiText(args.prompt) } : {}),
		...(args.completion !== undefined
			? { $ai_completion: boundedAiText(args.completion) }
			: {}),
		...safeProps(args.properties),
	}
}

export function captureAiTrace(...args: unknown[]): void {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	capture("$ai_trace", { ...rec, properties: aiEnvelope(rec) })
}

export function captureAiSpan(...args: unknown[]): void {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	capture("$ai_span", { ...rec, properties: aiEnvelope(rec) })
}

export function captureAiGeneration(...args: unknown[]): void {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	capture("$ai_generation", { ...rec, properties: aiEnvelope(rec) })
}

export async function captureAiSpanAwaitable(...args: unknown[]): Promise<void> {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	await captureAwaitable("$ai_span", { ...rec, properties: aiEnvelope(rec) })
}

export async function captureAiGenerationAwaitable(...args: unknown[]): Promise<void> {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	await captureAwaitable("$ai_generation", { ...rec, properties: aiEnvelope(rec) })
}

export function captureAiToolCall(...args: unknown[]): void {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	capture("$ai_tool_call", { ...rec, properties: aiToolCallEnvelope(rec) })
}

export async function captureAiToolCallAwaitable(...args: unknown[]): Promise<void> {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	await captureAwaitable("$ai_tool_call", { ...rec, properties: aiToolCallEnvelope(rec) })
}

export function captureAiDecision(...args: unknown[]): void {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	capture("$ai_decision", { ...rec, properties: aiDecisionEnvelope(rec) })
}

export async function captureAiDecisionAwaitable(...args: unknown[]): Promise<void> {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	await captureAwaitable("$ai_decision", { ...rec, properties: aiDecisionEnvelope(rec) })
}

function aiToolCallEnvelope(args: Record<string, unknown>): Record<string, unknown> {
	return {
		$ai_trace_id: args.traceId,
		$ai_span_id: args.spanId,
		...(args.parentId !== undefined ? { $ai_parent_span_id: args.parentId } : {}),
		...(args.sessionId !== undefined ? { $ai_session_id: args.sessionId } : {}),
		...(args.toolName !== undefined ? { $ai_tool_name: args.toolName } : {}),
		...(args.input !== undefined ? { $ai_input: boundedAiText(args.input) } : {}),
		...(args.output !== undefined ? { $ai_output: boundedAiText(args.output) } : {}),
		...(args.latencySeconds !== undefined ? { $ai_latency: args.latencySeconds } : {}),
		...(args.isError !== undefined ? { $ai_is_error: args.isError } : {}),
		...(args.error !== undefined ? { $ai_error: boundedAiText(args.error) } : {}),
		...safeProps(args.properties),
	}
}

function aiDecisionEnvelope(args: Record<string, unknown>): Record<string, unknown> {
	return {
		$ai_trace_id: args.traceId,
		$ai_span_id: args.spanId,
		...(args.parentId !== undefined ? { $ai_parent_span_id: args.parentId } : {}),
		...(args.sessionId !== undefined ? { $ai_session_id: args.sessionId } : {}),
		...(args.kind !== undefined ? { $ai_decision_type: args.kind } : {}),
		...(args.source !== undefined ? { $ai_decision_source: args.source } : {}),
		...(args.choice !== undefined ? { $ai_decision_choice: args.choice } : {}),
		...(args.confidence !== undefined ? { $ai_decision_confidence: args.confidence } : {}),
		...(args.subject !== undefined ? { $ai_decision_subject: args.subject } : {}),
		...(args.alternatives !== undefined ? { $ai_decision_alternatives: args.alternatives } : {}),
		...(args.reason !== undefined ? { $ai_decision_reason: args.reason } : {}),
		...(args.actor !== undefined ? { $ai_decision_actor: args.actor } : {}),
		...safeProps(args.properties),
	}
}

// A single oversized event must not take the rest of the batch down with it:
// the flush is one request, and PostHog rejects the whole payload if it is
// over the endpoint's ceiling. Split on serialized size instead.
const MAX_BATCH_BYTES = 1_000_000

// Exported for tests: the batch-splitting invariant is the only thing standing
// between one runaway event and losing a whole batch of telemetry.
export function splitBatchBySize(
	batch: Array<Record<string, unknown>>,
	maxBytes: number,
): Array<Array<Record<string, unknown>>> {
	const chunks: Array<Array<Record<string, unknown>>> = []
	let current: Array<Record<string, unknown>> = []
	let currentBytes = 0
	for (const record of batch) {
		let size: number
		try {
			// Bytes, not characters. PostHog enforces a byte ceiling, so sizing
			// chunks by `.length` under-counts every non-ASCII payload (Slack
			// text is full of it) and lets a "small" chunk come back 413.
			size = new TextEncoder().encode(JSON.stringify(record)).byteLength
		} catch {
			size = maxBytes
		}
		if (size > maxBytes) {
			// Cannot be made to fit; send it alone so the rest still lands.
			if (current.length) chunks.push(current)
			chunks.push([record])
			current = []
			currentBytes = 0
			continue
		}
		if (currentBytes + size > maxBytes && current.length) {
			chunks.push(current)
			current = []
			currentBytes = 0
		}
		current.push(record)
		currentBytes += size
	}
	if (current.length) chunks.push(current)
	return chunks
}

function postBatch(
	cfg: { key: string; host: string },
	chunk: Array<Record<string, unknown>>,
): Promise<Response> {
	return fetch(`${cfg.host}/batch/`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ api_key: cfg.key, batch: chunk }),
	})
}

/**
 * Last-resort shrink for a single event PostHog refuses outright.
 *
 * Only the free-text leaves are touched — everything scalar (model id, span
 * name, latency, token counts) is what makes the event worth keeping, and
 * `boundedAiText` upstream should mean this is never reached in practice.
 * Returns null when there is nothing left to strip, so the caller can tell
 * "retry is pointless" from "retry is worth it".
 */
function shrinkOversizedEvent(
	record: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
	if (!record || typeof record !== "object") return null
	const properties =
		record.properties && typeof record.properties === "object"
			? (record.properties as Record<string, unknown>)
			: undefined
	if (!properties) return null
	const next: Record<string, unknown> = { ...record, properties: {} }
	let changed = false
	for (const [key, value] of Object.entries(properties)) {
		if (typeof value === "string" && value.length > AI_TEXT_LIMIT) {
			;(next.properties as Record<string, unknown>)[key] = elideMiddle(
				value,
				AI_TEXT_LIMIT,
			)
			changed = true
			continue
		}
		;(next.properties as Record<string, unknown>)[key] = value
	}
	return changed ? next : null
}

export async function flushTelemetry(): Promise<void> {
	const cfg = posthogConfig()
	if (!cfg || queue.length === 0) {
		queue = []
		return
	}
	const batch = queue
	queue = []
	try {
		for (const chunk of splitBatchBySize(batch, MAX_BATCH_BYTES)) {
			let res = await postBatch(cfg, chunk)
			// PostHog rejects a single event that exceeds its per-event ceiling
			// outright, and no amount of batching helps: the event is dropped and
			// the warning repeats on every flush forever. Retry once with the
			// oversized record's free-text fields collapsed, so a runaway
			// generation still reports its identity, latency, and token counts
			// instead of vanishing. Envelope scalars ($ai_model, $ai_latency,
			// token counts) survive; only the text is lost, and losing the text
			// is the point.
			if (!res.ok && res.status === 413 && chunk.length === 1) {
				const shrunk = shrinkOversizedEvent(chunk[0])
				if (shrunk) {
					console.warn(
						`[company-brain][posthog] event ${String(chunk[0]?.event)} exceeded the ` +
							`per-event size limit; retrying with its text fields elided`,
					)
					res = await postBatch(cfg, [shrunk])
				}
			}
			if (!res.ok) {
				const text = await res.text()
				console.warn(
					`[company-brain][posthog] flush failed: ${res.status} ${text} (chunk of ${chunk.length}/${batch.length})`,
				)
			}
		}
	} catch {
		// Telemetry never breaks the turn.
	}
}
export type LeaseRequestOutcome = string

function productEvent(event: string, args: unknown): void {
	const rec = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>
	const distinctId =
		typeof rec.distinctId === "string" && rec.distinctId
			? rec.distinctId
			: typeof rec.userId === "string" && rec.userId
				? rec.userId
				: "company-brain"
	const rest: Record<string, unknown> = { ...rec }
	delete rest.distinctId
	delete rest.groups
	enqueue(event, distinctId, rest, rec.groups ?? (rec.orgId ? { company: rec.orgId } : undefined))
}

export function captureActivationRung(...args: unknown[]): void {
	productEvent("brain_activation_rung", args[0])
}

export function captureLeaseRequest(...args: unknown[]): void {
	productEvent("brain_lease_request", args[0])
}

export function captureBrainSkillEvent(...args: unknown[]): void {
	productEvent("brain_skill_event", args[0])
}

export function captureBeatSent(...args: unknown[]): void {
	productEvent("brain_journey_beat_sent", args[0])
}

export function captureBeatSuppressed(...args: unknown[]): void {
	productEvent("brain_journey_beat_suppressed", args[0])
}

export function captureJourneyExited(...args: unknown[]): void {
	productEvent("brain_journey_exited", args[0])
}

export function identifyMemberProfile(...args: unknown[]): void {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	if (typeof rec.userId !== "string") return
	enqueue(
		"$identify",
		rec.userId,
		{
			...(typeof rec.name === "string" ? { name: rec.name } : {}),
			...(typeof rec.email === "string" ? { email: rec.email } : {}),
		},
		rec.orgId ? { company: rec.orgId } : undefined,
	)
}

export function identifyCompanyGroup(...args: unknown[]): void {
	const rec = (args[0] ?? {}) as Record<string, unknown>
	if (typeof rec.orgId !== "string") return
	enqueue(
		"$groupidentify",
		rec.orgId,
		{
			type: "company",
			...(typeof rec.name === "string" ? { name: rec.name } : {}),
			...safeProps(rec.domain ? { domain: rec.domain } : {}),
			...safeProps(rec.slackTeamName ? { slack_team: rec.slackTeamName } : {}),
		},
		undefined,
	)
}
