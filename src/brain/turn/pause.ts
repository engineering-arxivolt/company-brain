import { generateId } from "@repo/lib/generate-id"
import type { ApprovalResumeState } from "./approval"
import type { CompanyBrainAgent } from "./agent"

export const PAUSED_TURN_TTL_MS = 15 * 60 * 1000

export type PausedTurnStatus = "paused" | "resumed" | "expired" | "error"

export type PausedTurn = {
	pauseId: string
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	threadKey: string
	turnId: string
	askerUser: string
	question: string
	stateJson: string
	status: PausedTurnStatus
	createdAt: number
	expiresAt: number
	resumedAt?: number
}

type PausedTurnRow = {
	pause_id: string
	org_id: string
	team_id: string
	channel: string
	thread_ts: string
	thread_key: string
	turn_id: string
	asker_user: string
	question: string
	state_json: string
	status: PausedTurnStatus
	created_at: number
	expires_at: number
	resumed_at: number | null
}

export function ensurePausedTurnTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_paused_turn (
			pause_id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			thread_key TEXT NOT NULL,
			turn_id TEXT NOT NULL,
			asker_user TEXT NOT NULL,
			question TEXT NOT NULL,
			state_json TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			resumed_at INTEGER
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_paused_turn_thread_idx
		ON brain_paused_turn (thread_key, status)
	`
}

function rowToPausedTurn(row: PausedTurnRow): PausedTurn | null {
	try {
		JSON.parse(row.state_json)
		return {
			pauseId: row.pause_id,
			orgId: row.org_id,
			teamId: row.team_id,
			channel: row.channel,
			threadTs: row.thread_ts,
			threadKey: row.thread_key,
			turnId: row.turn_id,
			askerUser: row.asker_user,
			question: row.question,
			stateJson: row.state_json,
			status: row.status,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			resumedAt: row.resumed_at ?? undefined,
		}
	} catch (err) {
		console.error(
			`[company-brain] paused turn ${row.pause_id} has unparseable persisted state; dropping:`,
			err,
		)
		return null
	}
}

export function insertPausedTurn(
	agent: CompanyBrainAgent,
	paused: PausedTurn,
): void {
	agent.sql`
		INSERT INTO brain_paused_turn (
			pause_id, org_id, team_id, channel, thread_ts, thread_key, turn_id,
			asker_user, question, state_json, status, created_at, expires_at, resumed_at
		) VALUES (
			${paused.pauseId},
			${paused.orgId},
			${paused.teamId},
			${paused.channel},
			${paused.threadTs},
			${paused.threadKey},
			${paused.turnId},
			${paused.askerUser},
			${paused.question},
			${paused.stateJson},
			${paused.status},
			${paused.createdAt},
			${paused.expiresAt},
			${paused.resumedAt ?? null}
		)
	`
}

export function loadPausedTurn(
	agent: CompanyBrainAgent,
	pauseId: string,
): PausedTurn | null {
	const rows = agent.sql<PausedTurnRow>`
		SELECT * FROM brain_paused_turn WHERE pause_id = ${pauseId}
	`
	return rows[0] ? rowToPausedTurn(rows[0]) : null
}

export function markPausedTurnResumed(
	agent: CompanyBrainAgent,
	pauseId: string,
	now = Date.now(),
): boolean {
	// One-shot: only the first Continue consumes the envelope. A resume that
	// later pauses again writes its own fresh envelope, so reuse buys nothing
	// and one-shot is the guard against double execution.
	const rows = agent.sql<{ pause_id: string }>`
		UPDATE brain_paused_turn
		SET status = ${"resumed"}, resumed_at = ${now}
		WHERE pause_id = ${pauseId} AND status = 'paused'
		RETURNING pause_id
	`
	return rows.length > 0
}

export function markPausedTurnTerminal(
	agent: CompanyBrainAgent,
	pauseId: string,
	status: "expired" | "error",
): void {
	agent.sql`
		UPDATE brain_paused_turn
		SET status = ${status}
		WHERE pause_id = ${pauseId}
	`
}

export function pausedTurnIsExpired(
	paused: Pick<PausedTurn, "expiresAt" | "status">,
	now = Date.now(),
): boolean {
	return paused.status === "paused" && paused.expiresAt <= now
}

/**
 * Persist a paused turn's resume envelope. Called by whichever surface paused
 * (the main turn, an approval resume, or a lease follow-up); the Continue
 * button replays the envelope verbatim, so nothing the turn already did is
 * re-derived.
 */
export function persistPausedTurn(args: {
	agent: CompanyBrainAgent
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	threadKey: string
	turnId: string
	askerUser: string
	question: string
	envelope: ApprovalResumeState
	now?: number
}): PausedTurn {
	const createdAt = args.now ?? Date.now()
	const paused: PausedTurn = {
		pauseId: generateId(),
		orgId: args.orgId,
		teamId: args.teamId,
		channel: args.channel,
		threadTs: args.threadTs,
		threadKey: args.threadKey,
		turnId: args.turnId,
		askerUser: args.askerUser,
		question: args.question,
		stateJson: JSON.stringify(args.envelope),
		status: "paused",
		createdAt,
		expiresAt: createdAt + PAUSED_TURN_TTL_MS,
	}
	ensurePausedTurnTables(args.agent)
	insertPausedTurn(args.agent, paused)
	return paused
}
