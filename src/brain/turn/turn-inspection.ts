import type { CompanyBrainAgent } from "./agent"
import { getDecisions, type DecisionView } from "./decision-log"

/**
 * One turn, explained.
 *
 * The data was already here — `decision-log.ts` records the route, the model,
 * the skill JEV picked and every MCP effect, and the DO keeps it in SQL — but
 * reading it meant composing SQL by hand. Answering "why did the bot draw a
 * picture instead of writing my CV" took reading a 2,400-line function; the
 * point of this module is that it takes one request.
 *
 * Assembly is a pure function over decision rows so it can be tested without a
 * Durable Object, and the read never throws: an inspector that fails the
 * request it was asked to explain is worse than an empty page.
 */

/** The deterministic route the turn took, as recorded at the top of it. */
export type TurnRouteTaken = {
	/** The route that claimed the message, or "model" when none did. */
	primary: string
	/** Every route that claimed it: more than one means the turn did two jobs. */
	matched: string[]
	/** Why Flow did or did not draw — `document-ask`, `no-picture-noun`, … */
	flow: string
}

export type TurnModelChoice = {
	choice: string
	reason: string | null
	alternatives: Record<string, number> | null
}

export type TurnSkillChoice = {
	choice: string
	reason: string | null
	confidence: number | null
	alternatives: Record<string, number> | null
	/** Who decided: `jev:<model>` for the classifier, otherwise the mechanism. */
	source: string
}

export type TurnToolEffect = {
	/** `serverSlug:method`. */
	subject: string
	/** The effect that was allowed or refused. */
	choice: string
	reason: string | null
}

export type TurnInspectionSummary = {
	route: TurnRouteTaken | null
	model: TurnModelChoice | null
	skill: TurnSkillChoice | null
	tools: TurnToolEffect[]
	decisionCount: number
	startedAt: number | null
	finishedAt: number | null
	/** Wall-clock span of the recorded decisions, when there are at least two. */
	durationMs: number | null
}

export type TurnInspection = {
	traceId: string
	summary: TurnInspectionSummary
	decisions: DecisionView[]
}

/** `flow=document-ask` → `document-ask`. Unknown shapes stay visible, not blank. */
export function flowReasonFrom(reason: string | null): string {
	if (!reason) return "unrecorded"
	const match = /\bflow=([a-z-]+)/i.exec(reason)
	return match?.[1] ?? reason.slice(0, 60)
}

/**
 * Fold one trace's decisions into the four questions anyone actually asks:
 * which route ran, which model answered, which playbook was preloaded, and what
 * was allowed to touch an external system.
 *
 * Last one wins per kind: a turn that re-resolved its model or re-routed kept
 * deciding, and the final decision is the one that shaped the answer.
 */
export function summarizeTurn(decisions: DecisionView[]): TurnInspectionSummary {
	let route: TurnRouteTaken | null = null
	let model: TurnModelChoice | null = null
	let skill: TurnSkillChoice | null = null
	const tools: TurnToolEffect[] = []

	for (const decision of decisions) {
		switch (decision.kind) {
			case "turn_route":
				route = {
					primary: decision.choice,
					matched: Object.keys(decision.alternatives ?? {}),
					flow: flowReasonFrom(decision.reason),
				}
				break
			case "model_selection":
				model = {
					choice: decision.choice,
					reason: decision.reason,
					alternatives: decision.alternatives,
				}
				break
			case "skill_selection":
				skill = {
					choice: decision.choice,
					reason: decision.reason,
					confidence: decision.confidence,
					alternatives: decision.alternatives,
					source: decision.source,
				}
				break
			case "mcp_effect":
				tools.push({
					subject: decision.subject,
					choice: decision.choice,
					reason: decision.reason,
				})
				break
		}
	}

	const timestamps = decisions
		.map((decision) => decision.createdAt)
		.filter((value) => Number.isFinite(value))
	const startedAt = timestamps.length ? Math.min(...timestamps) : null
	const finishedAt = timestamps.length ? Math.max(...timestamps) : null

	return {
		route,
		model,
		skill,
		tools,
		decisionCount: decisions.length,
		startedAt,
		finishedAt,
		durationMs:
			startedAt !== null && finishedAt !== null && decisions.length > 1
				? finishedAt - startedAt
				: null,
	}
}

/**
 * Read one trace out of the org's own Durable Object.
 *
 * `getDecisions` already swallows storage failures and returns an empty list,
 * so a trace with nothing recorded reads as an empty inspection rather than a
 * 500 — which is the honest answer: it may be older than the decision log.
 */
export function inspectTurn(
	agent: CompanyBrainAgent,
	args: { orgId: string; traceId: string },
): TurnInspection {
	const decisions = getDecisions(agent, {
		orgId: args.orgId,
		traceId: args.traceId,
	})
	return {
		traceId: args.traceId,
		summary: summarizeTurn(decisions),
		decisions,
	}
}
