import type { ModelMessage } from "ai"
import type { MemoryWriteback, SlackMemoryScope } from "../memory"
import type { SlackBotIdentity } from "../slack/client"
import type { TurnControlSnapshot } from "../slack/turn-control"
import type { ConnectedAppPauseRef } from "../tools/mcp/pause"
import type { TurnActor } from "./actor"
import type { CompanyBrainAgent } from "./agent"
import type { TurnState } from "./state"
import type { TurnTerminalProposal } from "./terminal"
import type { TurnToolAssemblySnapshot } from "./tools"

export const APPROVAL_EXPIRY_MS = 15 * 60 * 1000

export type ApprovalStatus =
	| "pending"
	| "approved"
	| "denied"
	| "expired"
	| "executed"
	| "cancelled"
	| "error"

export type ApprovalResumeState = {
	userId: string
	actor: TurnActor
	/** Legacy deployments persisted a flattened system prompt. */
	system?: string
	/** Asker's original question, for post-resume memory writeback. */
	question?: string
	messages: ModelMessage[]
	approvalIds: string[]
	connectedAppPause?: ConnectedAppPauseRef
	/** Legacy compatibility; the shared assembler always restores the full tool set. */
	includeMemoryAndWeb?: boolean
	turnState?: TurnState
	assembly?: TurnToolAssemblySnapshot
	botIdentity?: SlackBotIdentity
	detailedAppPolicy?: boolean
	memoryScope?: SlackMemoryScope
	memoryTagSlackUserIds?: string[]
	memory?: MemoryWriteback
	turnControl?: TurnControlSnapshot
	skipPostTurnReflect?: boolean
	/** Last model-proposed terminal reply before an approval suspension. */
	terminalProposal?: TurnTerminalProposal
}

export type PendingApproval = {
	approvalId: string
	turnId: string
	orgId: string
	teamId: string
	channel: string
	threadTs: string
	cardTs?: string
	askerUser: string
	toolName: string
	slug?: string
	toolInput: unknown
	summary: string
	state: ApprovalResumeState
	status: ApprovalStatus
	createdAt: number
	expiresAt: number
	decidedAt?: number
	decidedBy?: string
}

type PendingApprovalRow = {
	approval_id: string
	turn_id: string
	org_id: string
	team_id: string
	channel: string
	thread_ts: string
	card_ts: string | null
	asker_user: string
	tool_name: string
	slug: string | null
	tool_input_json: string
	summary: string
	state_json: string
	status: ApprovalStatus
	created_at: number
	expires_at: number
	decided_at: number | null
	decided_by: string | null
}

export function ensureApprovalTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_pending_approval (
			approval_id TEXT PRIMARY KEY,
			turn_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			team_id TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_ts TEXT NOT NULL,
			card_ts TEXT,
			asker_user TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			slug TEXT,
			tool_input_json TEXT NOT NULL,
			summary TEXT NOT NULL,
			state_json TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			decided_at INTEGER,
			decided_by TEXT
		)
	`
}

export function approvalIsExpired(
	approval: Pick<PendingApproval, "expiresAt" | "status">,
	now = Date.now(),
): boolean {
	return approval.status === "pending" && approval.expiresAt <= now
}

function rowToApproval(row: PendingApprovalRow): PendingApproval | null {
	try {
		const toolInput = JSON.parse(row.tool_input_json)
		const state = JSON.parse(row.state_json) as ApprovalResumeState
		return {
			approvalId: row.approval_id,
			turnId: row.turn_id,
			orgId: row.org_id,
			teamId: row.team_id,
			channel: row.channel,
			threadTs: row.thread_ts,
			cardTs: row.card_ts ?? undefined,
			askerUser: row.asker_user,
			toolName: row.tool_name,
			slug: row.slug ?? undefined,
			toolInput,
			summary: row.summary,
			state,
			status: row.status,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			decidedAt: row.decided_at ?? undefined,
			decidedBy: row.decided_by ?? undefined,
		}
	} catch (err) {
		console.error(
			`[company-brain] approval ${row.approval_id} has unparseable persisted state; dropping:`,
			err,
		)
		return null
	}
}

/**
 * SQLite caps a single TEXT/BLOB value at 2,000,000 bytes (Cloudflare's D1
 * and Durable Object SQLite share this ceiling). The resume envelope embeds
 * the entire compacted conversation, so a long turn or a fat connected-app
 * tool result can push `state_json` past that limit — and when it does, the
 * INSERT throws inside `insertPendingApproval`. That kills the whole turn: the
 * approval card is never posted, the asker gets a generic "I hit an error"
 * reply, and the only trace is a `SqlError` stack with no indication that
 * size was the cause.
 *
 * So bound the envelope before it reaches SQL. Messages are the bulk and are
 * compacted from the oldest end, which is what `compactMessagesAtBoundary`
 * already does for tool results; this is the last line of defence that keeps
 * the persisted row inside the storage ceiling. The tail is preserved because
 * the live question, the pending approval request, and the model's in-flight
 * reasoning all live there.
 *
 * Well under the hard 2MB limit on purpose: the row also carries the summary
 * and tool input, and the ceiling applies to the value, not the table.
 */
export const MAX_RESUME_STATE_BYTES = 1_500_000

function byteLength(value: string): number {
	// Cheap ASCII fast path; the encoder is only paid for non-ASCII text.
	let ascii = true
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) > 127) {
			ascii = false
			break
		}
	}
	return ascii ? value.length : new TextEncoder().encode(value).byteLength
}

/** Oldest-first message budget: drop whole messages from the front. */
function shrinkMessagesToFit(
	messages: ModelMessage[],
	overheadBytes: number,
): { messages: ModelMessage[]; dropped: number } | null {
	let dropped = 0
	let working = messages
	while (dropped < messages.length - 1) {
		// Always keep the final message: it carries the approval request the
		// resume has to resolve.
		working = messages.slice(dropped + 1)
		dropped += 1
		if (byteLength(JSON.stringify(working)) + overheadBytes <= MAX_RESUME_STATE_BYTES) {
			return { messages: working, dropped }
		}
	}
	return null
}

/**
 * Serialize a resume envelope for storage, guaranteeing the result fits
 * SQLite's per-value ceiling. Throws rather than returning an oversized string:
 * a silently truncated envelope would resume with a corrupt transcript, which
 * is far worse than a loud, attributable failure.
 */
export function serializeResumeState(state: ApprovalResumeState): string {
	const serialized = JSON.stringify(state)
	if (byteLength(serialized) <= MAX_RESUME_STATE_BYTES) return serialized

	// Everything except `messages` is small and structurally required.
	const { messages: _messages, ...rest } = state
	const overhead =
		byteLength(JSON.stringify(rest)) + byteLength(state.question ?? "") + 512
	const shrunk = shrinkMessagesToFit(state.messages, overhead)
	if (!shrunk) {
		throw new Error(
			`[company-brain] approval resume envelope is too large to persist: ` +
				`${byteLength(serialized)} bytes exceeds the ${MAX_RESUME_STATE_BYTES}-byte ` +
				`storage budget even after dropping every prior message`,
		)
	}
	console.warn(
		`[company-brain] approval resume envelope truncated to fit storage: ` +
			`${byteLength(serialized)} -> ${byteLength(JSON.stringify(shrunk.messages)) + overhead} bytes ` +
			`(dropped ${shrunk.dropped} of ${state.messages.length} messages); ` +
			`the resumed turn will have less context to work from`,
	)
	return JSON.stringify({ ...state, messages: shrunk.messages })
}

export function insertPendingApproval(
	agent: CompanyBrainAgent,
	approval: PendingApproval,
): void {
	agent.sql`
		INSERT INTO brain_pending_approval (
			approval_id, turn_id, org_id, team_id, channel, thread_ts, card_ts,
			asker_user, tool_name, slug, tool_input_json, summary, state_json,
			status, created_at, expires_at, decided_at, decided_by
		) VALUES (
			${approval.approvalId},
			${approval.turnId},
			${approval.orgId},
			${approval.teamId},
			${approval.channel},
			${approval.threadTs},
			${approval.cardTs ?? null},
			${approval.askerUser},
			${approval.toolName},
			${approval.slug ?? null},
			${JSON.stringify(approval.toolInput)},
			${approval.summary},
			${serializeResumeState(approval.state)},
			${approval.status},
			${approval.createdAt},
			${approval.expiresAt},
			${approval.decidedAt ?? null},
			${approval.decidedBy ?? null}
		)
	`
}

export function loadApproval(
	agent: CompanyBrainAgent,
	approvalId: string,
): PendingApproval | null {
	const rows = agent.sql<PendingApprovalRow>`
		SELECT * FROM brain_pending_approval WHERE approval_id = ${approvalId}
	`
	return rows[0] ? rowToApproval(rows[0]) : null
}

export function setApprovalCardTs(
	agent: CompanyBrainAgent,
	approvalId: string,
	cardTs: string | undefined,
): void {
	if (!cardTs) return
	agent.sql`
		UPDATE brain_pending_approval
		SET card_ts = ${cardTs}
		WHERE approval_id = ${approvalId}
	`
}

export function checkpointApprovalResumeState(
	agent: CompanyBrainAgent,
	approvalId: string,
	state: ApprovalResumeState,
): void {
	agent.sql`
		UPDATE brain_pending_approval
		SET state_json = ${serializeResumeState(state)}
		WHERE approval_id = ${approvalId}
	`
}

export function markApprovalDecided(
	agent: CompanyBrainAgent,
	approvalId: string,
	status: "approved" | "denied",
	userId: string,
	now = Date.now(),
): boolean {
	const rows = agent.sql<{ approval_id: string }>`
		UPDATE brain_pending_approval
		SET status = ${status}, decided_at = ${now}, decided_by = ${userId}
		WHERE approval_id = ${approvalId} AND status = 'pending'
		RETURNING approval_id
	`
	return rows.length > 0
}

export function markApprovalTerminal(
	agent: CompanyBrainAgent,
	approvalId: string,
	status: "expired" | "executed" | "cancelled" | "error",
): void {
	agent.sql`
		UPDATE brain_pending_approval
		SET status = ${status}
		WHERE approval_id = ${approvalId}
	`
}
