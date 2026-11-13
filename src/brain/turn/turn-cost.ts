import type { BrainCostEntry } from "../billing/cost"
import type { CompanyBrainAgent } from "./agent"

/**
 * What a turn cost, kept where it can be queried later.
 *
 * `billing/cost.ts` already computes a ledger per turn — provider-reported USD
 * when the vendor tells us (xAI ticks), otherwise tokens × list rates — and
 * `scheduleChargeBrainLlmCost` sends it off to be charged and captured. None of
 * that survives in our own storage, so "what did that 20-page report cost?"
 * could only be answered from PostHog, and nothing in the product could gate or
 * budget on spend.
 *
 * One row per turn, written where the ledger is already in hand (`compute.ts`
 * settles billing in a `finally` that every path passes through). The row is
 * small and the write is best-effort: cost accounting must never fail a turn.
 */
export const TURN_COST_TABLE = "brain_turn_cost"

export function ensureTurnCostTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_turn_cost (
			trace_id TEXT PRIMARY KEY,
			usd REAL NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			models TEXT NOT NULL,
			entries_json TEXT,
			created_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_turn_cost_recent
		ON brain_turn_cost (created_at)
	`
}

export type TurnCostTotals = {
	turns: number
	usd: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
}

const EMPTY_TOTALS: TurnCostTotals = {
	turns: 0,
	usd: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
}

/**
 * Fold a turn's ledger into the numbers worth storing.
 *
 * Tokens come from the entries (a vendor-only entry has none), and USD is
 * summed regardless of source, because a charge is a charge whether the
 * provider told us or we priced it from the list.
 */
export function turnCostTotals(entries: readonly BrainCostEntry[]): TurnCostTotals {
	const totals = { ...EMPTY_TOTALS, turns: entries.length ? 1 : 0 }
	for (const entry of entries) {
		totals.usd += Number.isFinite(entry.usd) ? entry.usd : 0
		totals.inputTokens += entry.usage.inputTokens ?? 0
		totals.outputTokens += entry.usage.outputTokens ?? 0
		totals.cacheReadTokens += entry.usage.cacheReadTokens ?? 0
		totals.cacheWriteTokens += entry.usage.cacheWriteTokens ?? 0
	}
	return totals
}

/** The models that actually cost something, most expensive first. */
export function billableModels(entries: readonly BrainCostEntry[]): string[] {
	const byModel = new Map<string, number>()
	for (const entry of entries) {
		if (!(entry.usd > 0)) continue
		byModel.set(entry.model, (byModel.get(entry.model) ?? 0) + entry.usd)
	}
	return [...byModel.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([model]) => model)
}

/** Persist one turn's cost. Returns false when it could not be stored. */
export function recordTurnCost(
	agent: CompanyBrainAgent,
	args: { traceId: string; entries: readonly BrainCostEntry[]; now?: number },
): boolean {
	if (!args.entries.length) return false
	try {
		ensureTurnCostTable(agent)
		const totals = turnCostTotals(args.entries)
		agent.sql`
			INSERT INTO brain_turn_cost (
				trace_id, usd, input_tokens, output_tokens, cache_read_tokens,
				cache_write_tokens, models, entries_json, created_at
			) VALUES (
				${args.traceId}, ${totals.usd}, ${totals.inputTokens},
				${totals.outputTokens}, ${totals.cacheReadTokens},
				${totals.cacheWriteTokens}, ${billableModels(args.entries).join(",")},
				${JSON.stringify(args.entries)}, ${args.now ?? Date.now()}
			)
			ON CONFLICT(trace_id) DO UPDATE SET
				usd = excluded.usd,
				input_tokens = excluded.input_tokens,
				output_tokens = excluded.output_tokens,
				cache_read_tokens = excluded.cache_read_tokens,
				cache_write_tokens = excluded.cache_write_tokens,
				models = excluded.models,
				entries_json = excluded.entries_json,
				created_at = excluded.created_at
		`
		return true
	} catch (error) {
		console.warn(
			`[company-brain][${args.traceId}] turn cost write failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return false
	}
}

export type TurnCostRow = {
	usd: number
	input_tokens: number
	output_tokens: number
	cache_read_tokens: number
	cache_write_tokens: number
}

/** Sum stored rows. Pure, so the arithmetic is testable without a database. */
export function sumCostRows(rows: readonly TurnCostRow[]): TurnCostTotals {
	const totals = { ...EMPTY_TOTALS }
	for (const row of rows) {
		totals.turns += 1
		totals.usd += Number.isFinite(row.usd) ? row.usd : 0
		totals.inputTokens += row.input_tokens ?? 0
		totals.outputTokens += row.output_tokens ?? 0
		totals.cacheReadTokens += row.cache_read_tokens ?? 0
		totals.cacheWriteTokens += row.cache_write_tokens ?? 0
	}
	return totals
}

/**
 * Spend over a window. Never throws: an audit that can fail the caller is worse
 * than one that says "unknown", and an empty row set is a real answer.
 */
export function turnCostSummary(
	agent: CompanyBrainAgent,
	args: { sinceMs?: number; now?: number } = {},
): TurnCostTotals {
	const now = args.now ?? Date.now()
	const since = now - (args.sinceMs ?? 24 * 60 * 60 * 1000)
	try {
		ensureTurnCostTable(agent)
		const rows = agent.sql<TurnCostRow>`
			SELECT usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
			FROM brain_turn_cost
			WHERE created_at >= ${since}
		`
		return sumCostRows(rows)
	} catch (error) {
		console.warn(
			"[company-brain] cost summary read failed:",
			error instanceof Error ? error.message : String(error),
		)
		return { ...EMPTY_TOTALS }
	}
}
