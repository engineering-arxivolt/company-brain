import { useQuery } from "@tanstack/react-query"
import { BACKEND } from "@lib/api"
import { useAuth } from "@lib/auth-context"

/**
 * The turn inspector's data.
 *
 * Two reads, both admin-only on the server: one turn (everything it decided) and
 * the org's recent decisions, which is how you find a trace id in the first
 * place. Types mirror src/brain/turn/turn-inspection.ts and decision-log.ts —
 * the web app keeps its own copies rather than importing worker code.
 */

export type TurnRouteTaken = {
	primary: string
	matched: string[]
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
	source: string
}

export type TurnToolEffect = {
	subject: string
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
	durationMs: number | null
}

export type DecisionView = {
	traceId: string
	kind: string
	subject: string
	choice: string
	reason: string | null
	confidence: number | null
	alternatives: Record<string, number> | null
	source: string
	actor: string | null
	supersedes: string | null
	createdAt: number
}

export type TurnInspection = {
	traceId: string
	summary: TurnInspectionSummary
	decisions: DecisionView[]
}

function errorFor(status: number, fallback: string): string {
	if (status === 401) return "Sign in again to read the decision log."
	if (status === 403) return "The turn inspector is for workspace admins."
	return fallback
}

export function useTurnInspection(traceId: string | null, enabled: boolean) {
	const { org } = useAuth()
	return useQuery({
		queryKey: ["brain", "turn", org?.id, traceId],
		queryFn: async (): Promise<TurnInspection> => {
			const res = await fetch(
				`${BACKEND}/brain/turns/${encodeURIComponent(traceId ?? "")}`,
				{ credentials: "include" },
			)
			if (!res.ok) throw new Error(errorFor(res.status, "Failed to load this turn"))
			return res.json()
		},
		enabled: enabled && Boolean(traceId),
		staleTime: 30_000,
		retry: false,
	})
}

/**
 * Recent decisions, newest first — the index of turns. Deliberately one request:
 * the point is to find an interesting turn, and grouping happens in the view.
 */
export function useRecentDecisions(enabled: boolean) {
	const { org } = useAuth()
	return useQuery({
		queryKey: ["brain", "decisions", "recent", org?.id],
		queryFn: async (): Promise<DecisionView[]> => {
			const res = await fetch(`${BACKEND}/brain/decisions?limit=200`, {
				credentials: "include",
			})
			if (!res.ok) throw new Error(errorFor(res.status, "Failed to load decisions"))
			const body = (await res.json()) as { decisions?: DecisionView[] }
			return body.decisions ?? []
		},
		enabled,
		staleTime: 15_000,
		retry: false,
	})
}
