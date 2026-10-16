/**
 * Content Studio drafts.
 *
 * One durable row per generated social-post draft. The row carries everything
 * the review card and the Buffer handoff need: the copy, the target channel,
 * provenance for anti-repetition, and a claim-guarded status so a double click
 * (or a retry racing a slow push) can't push the same draft twice.
 *
 * Status lifecycle:
 *   pending → pushing   → pushed      (Buffer accepted it)
 *                       → pending     (push failed; error column explains)
 *   pending → remixing  → pending     (body replaced with a fresh angle)
 *   pending → dismissed | superseded
 *
 * A claim older than CONTENT_DRAFT_STALE_CLAIM_MS is reclaimed: the worker may
 * have died mid-flight and the draft should not stay stuck forever.
 */
import { generateId } from "@repo/lib/generate-id"
import type { CompanyBrainAgent } from "../turn/agent"

export const CONTENT_DRAFT_KINDS = [
	"build_log",
	"lesson",
	"spotlight",
	"behind_the_scenes",
	"hot_take",
	"question",
] as const

export type ContentDraftKind = (typeof CONTENT_DRAFT_KINDS)[number]

export type ContentDraftStatus =
	| "pending"
	| "pushing"
	| "pushed"
	| "remixing"
	| "dismissed"
	| "superseded"

/** How long a push/remix claim may sit before another attempt may reclaim it. */
export const CONTENT_DRAFT_STALE_CLAIM_MS = 15 * 60 * 1000

/** How far back recent drafts feed the anti-repetition list. */
export const CONTENT_DRAFT_ANTI_REPEAT_MS = 7 * 24 * 60 * 60 * 1000

export type ContentDraft = {
	id: string
	automationId: string
	roundId: string
	teamId: string | null
	ownerUserId: string | null
	ownerSlackUserId: string | null
	dmChannelId: string | null
	kind: ContentDraftKind
	channelId: string | null
	channelService: string | null
	channelLabel: string | null
	body: string
	sourcesJson: string
	flagsJson: string
	traceId: string
	status: ContentDraftStatus
	bufferPostId: string | null
	bufferMode: string | null
	error: string | null
	createdAt: number
	updatedAt: number
}

export type NewContentDraft = {
	automationId: string
	roundId: string
	teamId?: string | null
	ownerUserId?: string | null
	ownerSlackUserId?: string | null
	dmChannelId?: string | null
	kind: ContentDraftKind
	channelId?: string | null
	channelService?: string | null
	channelLabel?: string | null
	body: string
	sourcesJson?: string
	flagsJson?: string
	traceId: string
}

type ContentDraftRow = {
	id: string
	automation_id: string
	round_id: string
	team_id: string | null
	owner_user_id: string | null
	owner_slack_user_id: string | null
	dm_channel_id: string | null
	kind: string
	channel_id: string | null
	channel_service: string | null
	channel_label: string | null
	body: string
	sources_json: string
	flags_json: string
	trace_id: string
	status: string
	buffer_post_id: string | null
	buffer_mode: string | null
	error: string | null
	created_at: number
	updated_at: number
}

const DRAFT_STATUSES = new Set<ContentDraftStatus>([
	"pending",
	"pushing",
	"pushed",
	"remixing",
	"dismissed",
	"superseded",
])

function asStatus(value: string): ContentDraftStatus {
	return DRAFT_STATUSES.has(value as ContentDraftStatus)
		? (value as ContentDraftStatus)
		: "pending"
}

function asKind(value: string): ContentDraftKind {
	return (CONTENT_DRAFT_KINDS as readonly string[]).includes(value)
		? (value as ContentDraftKind)
		: "build_log"
}

function rowToDraft(row: ContentDraftRow): ContentDraft {
	return {
		id: row.id,
		automationId: row.automation_id,
		roundId: row.round_id,
		teamId: row.team_id,
		ownerUserId: row.owner_user_id,
		ownerSlackUserId: row.owner_slack_user_id,
		dmChannelId: row.dm_channel_id,
		kind: asKind(row.kind),
		channelId: row.channel_id,
		channelService: row.channel_service,
		channelLabel: row.channel_label,
		body: row.body,
		sourcesJson: row.sources_json,
		flagsJson: row.flags_json,
		traceId: row.trace_id,
		status: asStatus(row.status),
		bufferPostId: row.buffer_post_id,
		bufferMode: row.buffer_mode,
		error: row.error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function ensureContentDraftTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_content_draft (
			id TEXT PRIMARY KEY,
			automation_id TEXT NOT NULL,
			round_id TEXT NOT NULL,
			team_id TEXT,
			owner_user_id TEXT,
			owner_slack_user_id TEXT,
			dm_channel_id TEXT,
			kind TEXT NOT NULL,
			channel_id TEXT,
			channel_service TEXT,
			channel_label TEXT,
			body TEXT NOT NULL,
			sources_json TEXT NOT NULL DEFAULT '[]',
			flags_json TEXT NOT NULL DEFAULT '[]',
			trace_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			buffer_post_id TEXT,
			buffer_mode TEXT,
			error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	try {
		agent.sql`CREATE INDEX IF NOT EXISTS brain_content_draft_automation ON brain_content_draft (automation_id, created_at)`
	} catch {}
	try {
		agent.sql`CREATE INDEX IF NOT EXISTS brain_content_draft_round ON brain_content_draft (round_id)`
	} catch {}
}

export function insertContentDraft(
	agent: CompanyBrainAgent,
	input: NewContentDraft,
): ContentDraft {
	ensureContentDraftTable(agent)
	const now = Date.now()
	const draft: ContentDraft = {
		id: generateId(),
		automationId: input.automationId,
		roundId: input.roundId,
		teamId: input.teamId ?? null,
		ownerUserId: input.ownerUserId ?? null,
		ownerSlackUserId: input.ownerSlackUserId ?? null,
		dmChannelId: input.dmChannelId ?? null,
		kind: input.kind,
		channelId: input.channelId ?? null,
		channelService: input.channelService ?? null,
		channelLabel: input.channelLabel ?? null,
		body: input.body,
		sourcesJson: input.sourcesJson ?? "[]",
		flagsJson: input.flagsJson ?? "[]",
		traceId: input.traceId,
		status: "pending",
		bufferPostId: null,
		bufferMode: null,
		error: null,
		createdAt: now,
		updatedAt: now,
	}
	agent.sql`
		INSERT INTO brain_content_draft (
			id, automation_id, round_id, team_id, owner_user_id,
			owner_slack_user_id, dm_channel_id, kind, channel_id, channel_service,
			channel_label, body, sources_json, flags_json, trace_id, status,
			buffer_post_id, buffer_mode, error, created_at, updated_at
		) VALUES (
			${draft.id}, ${draft.automationId}, ${draft.roundId}, ${draft.teamId},
			${draft.ownerUserId}, ${draft.ownerSlackUserId}, ${draft.dmChannelId},
			${draft.kind}, ${draft.channelId}, ${draft.channelService},
			${draft.channelLabel}, ${draft.body}, ${draft.sourcesJson},
			${draft.flagsJson}, ${draft.traceId}, ${draft.status},
			${draft.bufferPostId}, ${draft.bufferMode}, ${draft.error},
			${draft.createdAt}, ${draft.updatedAt}
		)
	`
	return draft
}

export function getContentDraft(
	agent: CompanyBrainAgent,
	id: string,
): ContentDraft | null {
	ensureContentDraftTable(agent)
	const rows = agent.sql<ContentDraftRow>`
		SELECT * FROM brain_content_draft WHERE id = ${id}
	`
	return rows[0] ? rowToDraft(rows[0]) : null
}

export function listDraftsForRound(
	agent: CompanyBrainAgent,
	roundId: string,
): ContentDraft[] {
	ensureContentDraftTable(agent)
	const rows = agent.sql<ContentDraftRow>`
		SELECT * FROM brain_content_draft WHERE round_id = ${roundId}
		ORDER BY created_at ASC, id ASC
	`
	return rows.map(rowToDraft)
}

/** Recent drafts for one automation, newest first (anti-repetition input). */
export function listRecentDrafts(
	agent: CompanyBrainAgent,
	automationId: string,
	options: { sinceMs?: number; limit?: number } = {},
): ContentDraft[] {
	ensureContentDraftTable(agent)
	const since = options.sinceMs ?? Date.now() - CONTENT_DRAFT_ANTI_REPEAT_MS
	const limit = Math.max(1, Math.min(options.limit ?? 24, 60))
	const rows = agent.sql<ContentDraftRow>`
		SELECT * FROM brain_content_draft
		WHERE automation_id = ${automationId} AND created_at >= ${since}
		ORDER BY created_at DESC, id DESC
		LIMIT ${limit}
	`
	return rows.map(rowToDraft)
}

/**
 * Atomically take a draft out of `pending` for a push or remix. Returns null
 * when someone else holds a fresh claim (or the draft is settled/gone).
 */
export function claimContentDraft(
	agent: CompanyBrainAgent,
	id: string,
	next: "pushing" | "remixing",
): ContentDraft | null {
	ensureContentDraftTable(agent)
	const now = Date.now()
	const staleCutoff = now - CONTENT_DRAFT_STALE_CLAIM_MS
	const rows = agent.sql<ContentDraftRow>`
		UPDATE brain_content_draft
		SET status = ${next}, error = NULL, updated_at = ${now}
		WHERE id = ${id} AND (
			status = 'pending'
			OR (status IN ('pushing', 'remixing') AND updated_at < ${staleCutoff})
		)
		RETURNING *
	`
	return rows[0] ? rowToDraft(rows[0]) : null
}

/**
 * Settle a push claim. Success marks the draft pushed; failure parks it back
 * in pending with the reason so the card offers a retry.
 */
export function finishContentPush(
	agent: CompanyBrainAgent,
	id: string,
	out:
		| { ok: true; bufferPostId?: string | null; bufferMode?: string | null }
		| { ok: false; error: string },
): void {
	ensureContentDraftTable(agent)
	const now = Date.now()
	if (out.ok) {
		agent.sql`
			UPDATE brain_content_draft SET
				status = 'pushed',
				buffer_post_id = ${out.bufferPostId ?? null},
				buffer_mode = ${out.bufferMode ?? null},
				error = NULL,
				updated_at = ${now}
			WHERE id = ${id} AND status = 'pushing'
		`
		return
	}
	agent.sql`
		UPDATE brain_content_draft SET
			status = 'pending',
			error = ${out.error.slice(0, 500)},
			updated_at = ${now}
		WHERE id = ${id} AND status = 'pushing'
	`
}

/** Settle a remix claim with the freshly written body. */
export function finishContentRemix(
	agent: CompanyBrainAgent,
	id: string,
	out: {
		body: string
		sourcesJson: string
		flagsJson: string
		/** The rewrite turn's trace id, kept for debugging. */
		traceId?: string
		/** When the remix re-resolved a channel, persist the new target too. */
		channelId?: string | null
		channelService?: string | null
		channelLabel?: string | null
	},
): void {
	ensureContentDraftTable(agent)
	agent.sql`
		UPDATE brain_content_draft SET
			status = 'pending',
			body = ${out.body},
			sources_json = ${out.sourcesJson},
			flags_json = ${out.flagsJson},
			trace_id = COALESCE(${out.traceId ?? null}, trace_id),
			channel_id = COALESCE(${out.channelId ?? null}, channel_id),
			channel_service = COALESCE(${out.channelService ?? null}, channel_service),
			channel_label = COALESCE(${out.channelLabel ?? null}, channel_label),
			error = NULL,
			updated_at = ${Date.now()}
		WHERE id = ${id} AND status = 'remixing'
	`
}

/** Settle a remix claim that produced nothing usable; keep the old body. */
export function failContentRemix(
	agent: CompanyBrainAgent,
	id: string,
	error: string,
): void {
	ensureContentDraftTable(agent)
	agent.sql`
		UPDATE brain_content_draft SET
			status = 'pending',
			error = ${error.slice(0, 500)},
			updated_at = ${Date.now()}
		WHERE id = ${id} AND status = 'remixing'
	`
}

export function dismissContentDraft(
	agent: CompanyBrainAgent,
	id: string,
): boolean {
	ensureContentDraftTable(agent)
	const rows = agent.sql<{ id: string }>`
		UPDATE brain_content_draft
		SET status = 'dismissed', updated_at = ${Date.now()}
		WHERE id = ${id} AND status = 'pending'
		RETURNING id
	`
	return Boolean(rows[0])
}

/**
 * A fresh round replaces yesterday's leftovers: older pending drafts are
 * superseded so the DM does not grow into a pile of stale buttons.
 */
export function supersedePendingDrafts(
	agent: CompanyBrainAgent,
	automationId: string,
	keepIds: string[],
): number {
	ensureContentDraftTable(agent)
	const keep = new Set(keepIds)
	const rows = agent.sql<{ id: string }>`
		SELECT id FROM brain_content_draft
		WHERE automation_id = ${automationId} AND status = 'pending'
	`
	let superseded = 0
	for (const row of rows) {
		if (keep.has(row.id)) continue
		const done = agent.sql<{ id: string }>`
			UPDATE brain_content_draft
			SET status = 'superseded', updated_at = ${Date.now()}
			WHERE id = ${row.id} AND status = 'pending'
			RETURNING id
		`
		if (done[0]) superseded++
	}
	return superseded
}

/** Recover claims abandoned mid-flight (worker died, request timed out). */
export function sweepStaleContentDrafts(agent: CompanyBrainAgent): number {
	ensureContentDraftTable(agent)
	const now = Date.now()
	const staleCutoff = now - CONTENT_DRAFT_STALE_CLAIM_MS
	const rows = agent.sql<{ id: string }>`
		UPDATE brain_content_draft SET
			status = 'pending',
			error = 'the previous attempt was interrupted — try again',
			updated_at = ${now}
		WHERE status IN ('pushing', 'remixing') AND updated_at < ${staleCutoff}
		RETURNING id
	`
	return rows.length
}
