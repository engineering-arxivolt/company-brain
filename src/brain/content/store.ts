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
import {
	defaultFunnelForKind,
	defaultVehicleForKind,
	resolveFunnel,
	resolveVehicle,
	type ContentFunnel,
	type ContentVehicle,
} from "./taxonomy"

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

/**
 * What a draft was grounded in.
 *
 * `cited` and `tools` are the older shape (what the writing turn named).
 * `facts` is the evidence packet's contribution: each fact carries the claim,
 * where it came from and, when the source gave one, the quote behind it. The
 * review card shows these, so the operator checks a fact rather than
 * trusting the prose around it.
 */
export type ContentDraftFact = {
	id?: string
	claim?: string
	source?: string
	quote?: string
	url?: string
}

export type ContentDraftSources = {
	cited?: string[]
	tools?: string[]
	facts?: ContentDraftFact[]
}

/** The stored provenance of a draft, read back defensively. */
export function draftSources(draft: ContentDraft): ContentDraftSources {
	try {
		const parsed = JSON.parse(draft.sourcesJson) as unknown
		if (!parsed || typeof parsed !== "object") return {}
		const record = parsed as ContentDraftSources
		return {
			...(Array.isArray(record.cited) ? { cited: record.cited } : {}),
			...(Array.isArray(record.tools) ? { tools: record.tools } : {}),
			...(Array.isArray(record.facts) ? { facts: record.facts } : {}),
		}
	} catch {
		return {}
	}
}

/** The facts a draft used, in packet order. */
export function draftFacts(draft: ContentDraft): ContentDraftFact[] {
	return draftSources(draft).facts ?? []
}

const URL_RE = /https?:\/\/\S+/i

/**
 * The first source that is a link, with the claim as its title.
 *
 * This is what becomes the post's link preview card: a post that shows what
 * it links to reads as a post with a source, and the reader can open the
 * thing it is about.
 */
export function draftLink(
	draft: ContentDraft,
): { url: string; title: string | null } | null {
	for (const fact of draftFacts(draft)) {
		const explicit = fact.url?.trim()
		if (explicit) {
			return {
				url: explicit.replace(/[),.;]+$/, ""),
				title: fact.claim?.trim() || null,
			}
		}
		const source = fact.source?.trim()
		if (!source) continue
		const match = source.match(URL_RE)
		if (!match) continue
		return {
			url: match[0].replace(/[),.;]+$/, ""),
			title: fact.claim?.trim() || null,
		}
	}
	return null
}

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
	/** The job this post does: reach, trust, or action. */
	funnel: ContentFunnel
	/** The form the post takes: story, breakdown, proof, ... */
	vehicle: ContentVehicle
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
	funnel?: ContentFunnel | null
	vehicle?: ContentVehicle | null
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
	funnel: string | null
	vehicle: string | null
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
	const kind = asKind(row.kind)
	return {
		id: row.id,
		automationId: row.automation_id,
		roundId: row.round_id,
		teamId: row.team_id,
		ownerUserId: row.owner_user_id,
		ownerSlackUserId: row.owner_slack_user_id,
		dmChannelId: row.dm_channel_id,
		kind,
		funnel: resolveFunnel(row.funnel, kind),
		vehicle: resolveVehicle(row.vehicle, kind),
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

/** The schema work is once per Durable Object, not once per query. */
const contentDraftSchemaReady = new WeakSet<CompanyBrainAgent>()

export function ensureContentDraftTable(agent: CompanyBrainAgent): void {
	if (contentDraftSchemaReady.has(agent)) return
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
			funnel TEXT,
			vehicle TEXT,
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
	try {
		agent.sql`CREATE INDEX IF NOT EXISTS brain_content_draft_buffer_post ON brain_content_draft (buffer_post_id)`
	} catch {}
	// Existing orgs have the original table. SQLite has no ADD COLUMN IF NOT
	// EXISTS, so each migration is tried once and ignored when the column is
	// already there (the normal case after the first run).
	try {
		agent.sql`ALTER TABLE brain_content_draft ADD COLUMN funnel TEXT`
	} catch {}
	try {
		agent.sql`ALTER TABLE brain_content_draft ADD COLUMN vehicle TEXT`
	} catch {}
	contentDraftSchemaReady.add(agent)
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
		funnel:
			input.funnel ?? defaultFunnelForKind(input.kind),
		vehicle:
			input.vehicle ?? defaultVehicleForKind(input.kind),
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
			owner_slack_user_id, dm_channel_id, kind, funnel, vehicle,
			channel_id, channel_service,
			channel_label, body, sources_json, flags_json, trace_id, status,
			buffer_post_id, buffer_mode, error, created_at, updated_at
		) VALUES (
			${draft.id}, ${draft.automationId}, ${draft.roundId}, ${draft.teamId},
			${draft.ownerUserId}, ${draft.ownerSlackUserId}, ${draft.dmChannelId},
			${draft.kind}, ${draft.funnel}, ${draft.vehicle},
			${draft.channelId}, ${draft.channelService},
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

/** The draft a Buffer post came from, for joining performance back to content. */
export function getContentDraftByBufferPostId(
	agent: CompanyBrainAgent,
	bufferPostId: string,
): ContentDraft | null {
	if (!bufferPostId) return null
	ensureContentDraftTable(agent)
	const rows = agent.sql<ContentDraftRow>`
		SELECT * FROM brain_content_draft
		WHERE buffer_post_id = ${bufferPostId}
		ORDER BY updated_at DESC
		LIMIT 1
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

/**
 * The state of a round, so "what happened to that run?" has an answer.
 *
 * A round is a background task: it can be in the evidence stage, writing, or
 * done, and from Slack none of that is visible until a card arrives. One row
 * per round, written as the round moves, is what makes the wait explainable.
 */
export type ContentRoundStatus =
	| "running"
	| "writing"
	| "posted"
	| "empty"
	| "failed"

export type ContentRound = {
	id: string
	automationId: string
	teamId: string | null
	ownerUserId: string | null
	trigger: string | null
	brief: string
	status: ContentRoundStatus
	drafts: number
	error: string | null
	startedAt: number
	updatedAt: number
}

type ContentRoundRow = {
	id: string
	automation_id: string
	team_id: string | null
	owner_user_id: string | null
	trigger: string | null
	brief: string
	status: string
	drafts: number
	error: string | null
	started_at: number
	updated_at: number
}

const ROUND_STATUSES = new Set<ContentRoundStatus>([
	"running",
	"writing",
	"posted",
	"empty",
	"failed",
])

function asRoundStatus(value: string): ContentRoundStatus {
	return ROUND_STATUSES.has(value as ContentRoundStatus)
		? (value as ContentRoundStatus)
		: "running"
}

function rowToRound(row: ContentRoundRow): ContentRound {
	return {
		id: row.id,
		automationId: row.automation_id,
		teamId: row.team_id,
		ownerUserId: row.owner_user_id,
		trigger: row.trigger,
		brief: row.brief,
		status: asRoundStatus(row.status),
		drafts: row.drafts ?? 0,
		error: row.error,
		startedAt: row.started_at,
		updatedAt: row.updated_at,
	}
}

const contentRoundSchemaReady = new WeakSet<CompanyBrainAgent>()

export function ensureContentRoundTable(agent: CompanyBrainAgent): void {
	if (contentRoundSchemaReady.has(agent)) return
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_content_round (
			id TEXT PRIMARY KEY,
			automation_id TEXT NOT NULL,
			team_id TEXT,
			owner_user_id TEXT,
			trigger TEXT,
			brief TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'running',
			drafts INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			started_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	try {
		agent.sql`CREATE INDEX IF NOT EXISTS brain_content_round_started ON brain_content_round (started_at)`
	} catch {}
	contentRoundSchemaReady.add(agent)
}

export function startContentRound(
	agent: CompanyBrainAgent,
	input: {
		id: string
		automationId: string
		teamId?: string | null
		ownerUserId?: string | null
		trigger?: string | null
		brief?: string | null
	},
): ContentRound {
	ensureContentRoundTable(agent)
	const now = Date.now()
	const round: ContentRound = {
		id: input.id,
		automationId: input.automationId,
		teamId: input.teamId ?? null,
		ownerUserId: input.ownerUserId ?? null,
		trigger: input.trigger ?? null,
		brief: (input.brief ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
		status: "running",
		drafts: 0,
		error: null,
		startedAt: now,
		updatedAt: now,
	}
	agent.sql`
		INSERT INTO brain_content_round (
			id, automation_id, team_id, owner_user_id, trigger, brief,
			status, drafts, error, started_at, updated_at
		) VALUES (
			${round.id}, ${round.automationId}, ${round.teamId},
			${round.ownerUserId}, ${round.trigger}, ${round.brief},
			${round.status}, ${round.drafts}, ${round.error},
			${round.startedAt}, ${round.updatedAt}
		)
	`
	return round
}

export function updateContentRound(
	agent: CompanyBrainAgent,
	id: string,
	patch: {
		status?: ContentRoundStatus
		drafts?: number
		error?: string | null
	},
): void {
	ensureContentRoundTable(agent)
	const now = Date.now()
	const status = patch.status ?? null
	const drafts = patch.drafts ?? null
	const error = patch.error === undefined ? null : patch.error
	agent.sql`
		UPDATE brain_content_round SET
			status = COALESCE(${status}, status),
			drafts = COALESCE(${drafts}, drafts),
			error = COALESCE(${error}, error),
			updated_at = ${now}
		WHERE id = ${id}
	`
}

/** The most recent rounds, newest first. */
export function listRecentContentRounds(
	agent: CompanyBrainAgent,
	limit = 5,
): ContentRound[] {
	ensureContentRoundTable(agent)
	const take = Math.max(1, Math.min(limit, 20))
	const rows = agent.sql<ContentRoundRow>`
		SELECT * FROM brain_content_round
		ORDER BY started_at DESC
		LIMIT ${take}
	`
	return rows.map(rowToRound)
}

/**
 * Mark rounds that never finished as failed.
 *
 * A round runs in the background, so a deploy or an evicted Durable Object
 * can end it without anything recording the fact. Left alone, the round
 * would read as "still writing" forever, which is the one answer the
 * operator can least use.
 */
export function sweepStaleContentRounds(
	agent: CompanyBrainAgent,
	maxAgeMs = 30 * 60 * 1000,
): number {
	ensureContentRoundTable(agent)
	const now = Date.now()
	const cutoff = now - maxAgeMs
	const rows = agent.sql<{ id: string }>`
		UPDATE brain_content_round SET
			status = 'failed',
			error = 'the round was interrupted before it finished',
			updated_at = ${now}
		WHERE status IN ('running', 'writing') AND updated_at < ${cutoff}
		RETURNING id
	`
	return rows.length
}
