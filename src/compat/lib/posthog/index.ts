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
		...(args.input !== undefined ? { $ai_input: args.input } : {}),
		...(args.inputState !== undefined ? { $ai_input_state: args.inputState } : {}),
		...(args.outputChoices !== undefined ? { $ai_output_choices: args.outputChoices } : {}),
		...(args.outputState !== undefined ? { $ai_output_state: args.outputState } : {}),
		...(args.latencySeconds !== undefined ? { $ai_latency: args.latencySeconds } : {}),
		...(args.isError !== undefined ? { $ai_is_error: args.isError } : {}),
		...(args.error !== undefined ? { $ai_error: args.error } : {}),
		...(args.tools !== undefined ? { $ai_tools: args.tools } : {}),
		...(args.traceName !== undefined ? { $ai_trace_name: args.traceName } : {}),
		...(args.prompt !== undefined ? { $ai_prompt: args.prompt } : {}),
		...(args.completion !== undefined ? { $ai_completion: args.completion } : {}),
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
		...(args.input !== undefined ? { $ai_input: args.input } : {}),
		...(args.output !== undefined ? { $ai_output: args.output } : {}),
		...(args.latencySeconds !== undefined ? { $ai_latency: args.latencySeconds } : {}),
		...(args.isError !== undefined ? { $ai_is_error: args.isError } : {}),
		...(args.error !== undefined ? { $ai_error: args.error } : {}),
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

export async function flushTelemetry(): Promise<void> {
	const cfg = posthogConfig()
	if (!cfg || queue.length === 0) {
		queue = []
		return
	}
	const batch = queue
	queue = []
	try {
		const res = await fetch(`${cfg.host}/batch/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: cfg.key, batch }),
		})
		if (!res.ok) {
			const text = await res.text()
			console.warn(`[company-brain][posthog] flush failed: ${res.status} ${text}`)
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
