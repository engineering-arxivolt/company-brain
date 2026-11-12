import {
	runLeaseEscalation as runLeaseEscalationImpl,
	runSlackLeaseDecision,
} from "../lease/decision"
import { ensureLeaseTables, revokeLeasesForConnection } from "../lease/store"
import type { LeaseEscalationPayload, SlackLeaseDecision } from "../lease/types"
import { clearBrainProfileSync } from "../memory/profile-sync"
import {
	runDream as runDreamTurn,
	shouldApplyDream,
	type DreamReport,
} from "../memory/dream"
import {
	ensureDreamScheduleTable,
	ensureDreamScheduled,
} from "../memory/dream-schedule"
import { ensureBrainMemoryTagTable } from "../memory/tags"
import {
	runContentDraftInteraction,
	runContentNewsInteraction,
	type SlackContentDraftInteraction,
} from "../content/interactions"
import type { ContentNewsInteraction } from "../content/news"
import {
	advanceBrainMemoryResetEpoch,
	clearBrainMemoryRegistry,
	ensureBrainMemoryNodeTable,
	ensureBrainMemoryStateTable,
} from "../memory/tree"
import { ensureWorkspacePromptTable } from "../memory/workspace-prompt"
import type { MemoryWriteback } from "../memory/writeback"
import { memoryDocsFromWriteback } from "../memory/writeback"
import {
	createSkillWithSideEffects,
	deleteSkillWithSideEffects,
	importSkillsWithSideEffects,
	updateSkillWithSideEffects,
} from "../skills/operations"
import {
	runSlackSkillDraftInteraction,
	type SlackSkillDraftInteraction,
} from "../skills/slack-interactions"
import {
	ensureSkillTables,
	listSkills,
	sweepExpiredSkillDrafts,
} from "../skills/store"
import {
	ensureChannelMembershipTables,
	reconcileChannelMembership as reconcileChannelMembershipImpl,
	runSlackMembershipEvent,
} from "../slack/channel-membership"
import {
	ensureChannelObserveTables,
	reconcileChannelObserveSchedules,
} from "../slack/channel-observe"
import { ensureChimeBudgetTables } from "../slack/chime-budget"
import {
	ensureSlackEventStoreTables,
	getStoredSlackEventAudit,
	markStoredEventFiltered,
	recordSlackEvent,
	recordStoredActionOutcome,
	recordStoredTriageDecision,
} from "../slack/event-store"
import { ensureMessageTraceTable } from "../slack/message-trace"
import { ensureSlackProfileCacheTable } from "../slack/profile-cache"
import { ensurePublicChannelRolloutTables } from "../slack/public-channel-rollout"
import {
	ensureReactionQueueTables,
	type ReactionQueuePayload,
	recoverPassiveReactionQueue,
	runPassiveReactionQueue as runPassiveReactionQueueImpl,
} from "../slack/reaction-queue"
import { ensureTriageTraceSamplingTable } from "../slack/triage-sampling"
import { ensureTurnControlTables, getThreadTurn } from "../slack/turn-control"
import { postSlackMessage } from "../slack/client"
import {
  buildEtimsOscuConfig,
  submitInvoiceToETimsOscu,
  ETimsOscuError,
} from "../etims/oscue-client"
import { type EtimsInvoiceSlackPayload, postEtimsInvoiceToSlack as postEtimsInvoiceToSlackChannel } from "../slack/invoice-notification"
import { brainAgent, type CompanyBrainAgent } from "./agent"
import { ensureApprovalTables } from "./approval"
import {
	ensurePausedTurnTables,
	loadPausedTurn,
	markPausedTurnTerminal,
} from "./pause"
import {
	cancelLongJob,
	cancelPendingApprovalsForJob,
	ensureLongJobTables,
	hasPendingApprovalForJob,
	loadLongJob,
	longJobIsExpired,
	type LongJobStepPayload,
	type LongJobStopPayload,
	markLongJobStatus,
	reconcileLongJobs,
} from "./long-job"
import { ensureDecisionTables } from "./decision-log"
import {
	type ApprovalExpiryPayload,
	runApprovalExpiry as runApprovalExpiryImpl,
} from "./approval-expiry"
import { computeTurn } from "./compute"
import { maybeNudgeInstallTools } from "./install-nudge"
import { clearInteractionObserveState } from "./interaction-observe"
import {
	type ParallelMonitorEvent,
	runParallelMonitorEvent,
} from "./parallel-monitor"

export {
	getWorkspacePrompt,
	setWorkspacePrompt,
} from "../memory/workspace-prompt"
export { computeInteractionContext } from "../prompt/build"
export { runChannelObserve } from "../slack/channel-observe"
export {
	createAutomation,
	deleteAutomation,
	listAutomations,
	runAutomationNow,
	updateAutomation,
} from "../tools/automations"
export {
	createSkillWithSideEffects,
	deleteSkillWithSideEffects,
	importSkillsWithSideEffects,
	updateSkillWithSideEffects,
}
export { listSkills }
export { runAdminChat } from "../admin/chat"
export { listBrainSurfaces } from "../admin/surfaces"
export { readDraftOutcome } from "../auto-research/outcome"
export { autoResearchRunState, runAutoResearch } from "../auto-research/run"
export { sendAutoResearchDraft } from "../auto-research/send"
export {
	dismissAutoResearchDraft,
	editAutoResearchDraftBody,
	listAutoResearchDrafts,
} from "../auto-research/store"
export { journeySnapshot, resetJourney } from "../journey/debug"
export { armJourney, runJourneyTick } from "../journey/engine"

import {
	cancelAutoResearchSchedules,
	resetAutoResearch,
} from "../auto-research/run"

export { runScheduledTask } from "../tools/scheduling"
export { runPostTurnReflect } from "./post-turn-reflect"
export {
	getResearchState,
	researchCompanyOnSignup,
	runResearchTask,
	syncResearchCardIfDone,
} from "./research"
export { getDecisions } from "./decision-log"
export { inspectTurn } from "./turn-inspection"
export { answerQuality } from "../slack/answer-quality"

import { recordDecision } from "./decision-log"

/**
 * The dream's two entry points.
 *
 * `runDream` is the scheduled callback: it runs the pass and re-arms tomorrow's
 * alarm. `runDreamNow` is the admin trigger behind `POST /brain/dream` and
 * deliberately does *not* touch the schedule — a manual dry run must not shift
 * the nightly clock.
 *
 * Deleting anything needs both the caller's `apply` and `DREAM_APPLY=on` in the
 * deployment: the plan is worth reading for a while before it is worth trusting.
 */
async function dreamPass(
	agent: CompanyBrainAgent,
	options: { requestedApply: boolean; rearm: boolean },
): Promise<DreamReport> {
	const env = brainAgent(agent).env
	const apply = shouldApplyDream(env.DREAM_APPLY, options.requestedApply)
	const traceId = `dream:${new Date().toISOString().slice(0, 10)}`
	const report = await runDreamTurn({
		env,
		orgId: agent.name,
		apply,
		traceId,
	})
	recordDecision(agent, {
		traceId,
		orgId: agent.name,
		kind: "dream",
		subject: report.containerTag,
		choice: report.applied ? "applied" : "planned",
		reason: `scanned=${report.scanned} distinct=${report.distinct} duplicates=${report.duplicateNotes} stale=${report.staleNotes} deleted=${report.deleted}`,
		source: "dream",
	})
	if (options.rearm) {
		await ensureDreamScheduled(agent, { force: true }).catch((error) => {
			console.warn(`[company-brain][${traceId}] dream re-arm failed:`, error)
		})
	}
	return report
}

export async function runDream(
	agent: CompanyBrainAgent,
	payload: { reason?: string } = {},
): Promise<void> {
	await dreamPass(agent, { requestedApply: true, rearm: true }).catch(
		async (error) => {
			// A failed dream is tomorrow's problem: it must never wedge the alarm
			// chain, so the failure is logged and the next run is still armed.
			console.error("[company-brain] dream failed:", error)
			await ensureDreamScheduled(agent, { force: true }).catch(() => undefined)
		},
	)
}

export async function runDreamNow(
	agent: CompanyBrainAgent,
	args: { apply?: boolean } = {},
): Promise<DreamReport> {
	return dreamPass(agent, {
		requestedApply: args.apply === true,
		rearm: false,
	})
}

import type { Schedule } from "agents"
import { flushBrainTelemetry } from "../observability"
import { runSlackChimeIn } from "../slack/chime"
import { updateSlackInteractionResponse } from "../slack/client"
import {
	isDebugReactionEvent,
	isFeedbackReactionEvent,
	isMuteReactionEvent,
	type SlackTurnMessage,
} from "../slack/events"
import {
	finalizeInterruptedSlackTurn as finalizeInterruptedSlackTurnImpl,
	runSlackApprovalDecision,
	runSlackConnectComplete,
	runSlackContinueTurn,
	runSlackDebugReaction,
	runSlackFeedbackReaction,
	runSlackMuteReaction,
	runSlackTurn,
	type SlackApprovalDecision,
	type SlackTurnContinue,
	type SlackConnectCompletion,
} from "../slack/turn"
import type { SlackOrg } from "../slack/workspace"
import { ensureAutomationTable } from "../tools/automations"
import { ensureCodePauseTable } from "../tools/mcp/pause"
import {
	ensureMcpToolCatalogTable,
	invalidateMcpToolCatalog,
} from "../tools/mcp/tool-catalog-store"
import { ensureSandboxSessionTables } from "../tools/sandbox/sessions"
import {
	ensurePostTurnReflectTable,
	reconcilePostTurnReflectSchedules,
} from "./post-turn-reflect"
import type {
	SlackTurnFiberControl,
	SlackTurnFiberSnapshot,
} from "./slack-turn-fiber"
import {
	ensureTeamInviteTables,
	reconcileTeamInviteSchedule,
} from "./team-invite"
import { ensureThreadInvestigationTable } from "./thread-investigation"

export async function onStart(agent: CompanyBrainAgent): Promise<void> {
	ensureBrainMemoryTagTable(agent)
	ensureBrainMemoryNodeTable(agent)
	ensureBrainMemoryStateTable(agent)
	ensureApprovalTables(agent)
	ensurePausedTurnTables(agent)
	ensureLongJobTables(agent)
	ensureDecisionTables(agent)
	ensureLeaseTables(agent)
	ensureChimeBudgetTables(agent)
	ensureSlackEventStoreTables(agent)
	ensureSlackProfileCacheTable(agent)
	ensureReactionQueueTables(agent)
	ensureTriageTraceSamplingTable(agent)
	ensureTurnControlTables(agent)
	ensureMessageTraceTable(agent)
	ensureSandboxSessionTables(agent)
	ensureAutomationTable(agent)
	ensureChannelObserveTables(agent)
	ensureSkillTables(agent)
	sweepExpiredSkillDrafts(agent)
	ensurePostTurnReflectTable(agent)
	ensureChannelMembershipTables(agent)
	ensureMcpToolCatalogTable(agent)
	ensureCodePauseTable(agent)
	ensureThreadInvestigationTable(agent)
	ensurePublicChannelRolloutTables(agent)
	ensureTeamInviteTables(agent)
	ensureWorkspacePromptTable(agent)
	ensurePesacastTables(agent)
	ensureInvoicesTable(agent)
	ensureDreamScheduleTable(agent)
	await recoverPassiveReactionQueue(agent)
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_user_seen (
			user_id TEXT PRIMARY KEY,
			last_seen INTEGER NOT NULL
		)
	`
	const repairs = await Promise.allSettled([
		reconcileChannelObserveSchedules(agent),
		reconcilePostTurnReflectSchedules(agent),
		reconcileTeamInviteSchedule(agent),
		cancelAutoResearchSchedules(agent),
		reconcileLongJobs(agent),
	])
	for (const repair of repairs) {
		if (repair.status === "rejected") {
			console.error(
				"[company-brain] observer schedule repair failed:",
				repair.reason,
			)
		}
	}
	await agent
		.deleteFibers({
			status: ["completed", "error", "aborted"],
			settledBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
			limit: 500,
		})
		.catch((error) => {
			console.warn("[company-brain] settled fiber cleanup failed:", error)
		})
	// Arm the nightly dream if this org does not already have one pending.
	// Idempotent by the row in brain_dream_schedule, because this runs on every
	// wake: without it the consolidation would only happen in months with a
	// deploy.
	await ensureDreamScheduled(agent).catch((error) => {
		console.warn("[company-brain] dream schedule failed:", error)
	})
}

/**
 * Ensure the pesacast_transactions table exists in this Durable Object's
 * embedded SQLite. Idempotent on (org_id, device_id, ref, time).
 */
export function ensurePesacastTables(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_pesacast_transaction (
			org_id TEXT NOT NULL,
			device_id TEXT,
			source TEXT NOT NULL DEFAULT 'android',
			direction TEXT NOT NULL,
			amount TEXT NOT NULL,
			currency TEXT NOT NULL DEFAULT 'KES',
			counterparty TEXT,
			ref TEXT NOT NULL,
			time TEXT NOT NULL,
			balance TEXT,
			transaction_cost TEXT,
			raw_payload TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			PRIMARY KEY (org_id, device_id, ref, time)
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_pesacast_transaction_org_idx
		ON brain_pesacast_transaction (org_id, received_at DESC)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_pesacast_transaction_ref_idx
		ON brain_pesacast_transaction (ref)
	`
}

/**
 * Ingest PesaCast M-PESA transactions from a phone webhook delivery.
 * Idempotent: a transaction with the same (org_id, device_id, ref, time)
 * is inserted once; duplicates are silently ignored.
 */
export async function ingestPesacastTransactions(
	agent: CompanyBrainAgent,
	input: {
		orgId: string
		deviceId: string | null
		source: "android" | "desktop"
		transactions: Array<{
			type: string
			direction: string
			amount: string
			currency: string
			from?: string | null
			recipient?: string | null
			ref: string
			time?: string
			balance?: string | null
			transaction_cost?: string | null
		}>
	},
): Promise<void> {
	const now = Date.now()
	for (const txn of input.transactions) {
		const time = txn.time ?? new Date(now).toISOString()
		const counterparty =
			txn.from ?? txn.recipient ?? null
		const existing = await agent.sql<{ n: string }>`
			SELECT COUNT(*) AS n FROM brain_pesacast_transaction
			WHERE org_id = ${input.orgId}
			  AND device_id IS NOT DISTINCT FROM ${input.deviceId}
			  AND ref = ${txn.ref}
			  AND time = ${time}
		`
		if (Number(existing[0]?.n) > 0) continue

		agent.sql`
			INSERT INTO brain_pesacast_transaction (
				org_id, device_id, source, direction, amount, currency,
				counterparty, ref, time, balance, transaction_cost,
				raw_payload, received_at
			) VALUES (
				${input.orgId}, ${input.deviceId}, ${input.source},
				${txn.direction}, ${txn.amount}, ${txn.currency},
				${counterparty}, ${txn.ref}, ${time},
				${txn.balance ?? null}, ${txn.transaction_cost ?? null},
				${JSON.stringify(txn)}, ${now}
			)
		`

		// Try to match this M-PESA transaction to an open invoice
		if (txn.direction === "received" && txn.ref) {
			try {
				await matchMpesaToInvoice(agent, input.orgId, {
					ref: txn.ref,
					amount: txn.amount,
					counterparty,
					time,
					direction: txn.direction,
				})
			} catch (err) {
				console.error("[pesacast] invoice match failed:", err)
			}
		}
	}
}

/**
 * List PesaCast transactions for an org, newest first. Optional filters on
 * direction and time range.
 */
export async function listPesacastTransactions(
	agent: CompanyBrainAgent,
	input: {
		orgId: string
		limit?: number
		offset?: number
		direction?: string
		from?: string
		to?: string
	},
): Promise<Array<{
	orgId: string
	deviceId: string | null
	source: string
	direction: string
	amount: string
	currency: string
	counterparty: string | null
	ref: string
	time: string
	balance: string | null
	transactionCost: string | null
	receivedAt: number
}>> {
	const limit = Math.min(input.limit ?? 100, 500)
	const offset = input.offset ?? 0

	let sql = `
		SELECT org_id, device_id, source, direction, amount, currency,
			counterparty, ref, time, balance, transaction_cost, received_at
		FROM brain_pesacast_transaction
		WHERE org_id = ${input.orgId}
	`
	const params: Array<string | number> = []

	if (input.direction) {
		sql += ` AND direction = $${params.length + 1}`
		params.push(input.direction)
	}
	if (input.from) {
		sql += ` AND time >= $${params.length + 1}`
		params.push(input.from)
	}
	if (input.to) {
		sql += ` AND time <= $${params.length + 1}`
		params.push(input.to)
	}

	sql += ` ORDER BY time DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
	params.push(limit, offset)

	const rows = await agent.sql<{
		org_id: string
		device_id: string | null
		source: string
		direction: string
		amount: string
		currency: string
		counterparty: string | null
		ref: string
		time: string
		balance: string | null
		transaction_cost: string | null
		received_at: number
	}>(sql as any, ...params)

	return rows.map((row) => ({
		orgId: row.org_id,
		deviceId: row.device_id,
		source: row.source,
		direction: row.direction,
		amount: row.amount,
		currency: row.currency,
		counterparty: row.counterparty,
		ref: row.ref,
		time: row.time,
		balance: row.balance,
		transactionCost: row.transaction_cost,
		receivedAt: row.received_at,
	}))
}

export function ensureInvoicesTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_invoice (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			customer_tin TEXT,
			customer_name TEXT,
			customer_mobile TEXT,
			status TEXT NOT NULL DEFAULT 'draft',
			tot_taxbl_amt REAL NOT NULL DEFAULT 0,
			tot_tax_amt REAL NOT NULL DEFAULT 0,
			tot_amt REAL NOT NULL DEFAULT 0,
			etims_invoice_no TEXT,
			etims_confirmed_at TEXT,
			etims_qr_code TEXT,
			mpesa_ref TEXT,
			mpesa_amount TEXT,
			mpesa_received_at TEXT,
			mpesa_direction TEXT,
			raw_payload TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_invoice_org_idx
		ON brain_invoice (org_id, created_at DESC)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_invoice_status_idx
		ON brain_invoice (org_id, status)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_invoice_etims_idx
		ON brain_invoice (etims_invoice_no)
	`
	agent.sql`
		CREATE INDEX IF NOT EXISTS brain_invoice_mpesa_ref_idx
		ON brain_invoice (mpesa_ref)
	`
}

export async function createInvoice(
	agent: CompanyBrainAgent,
	input: {
		orgId: string
		customerTin?: string
		customerName?: string
		customerMobile?: string
		items: Array<{
			itemSeq: number
			itemCd: string
			itemNm: string
			pkgUnitCd: string
			pkg: number
			qtyUnitCd: string
			qty: number
			prc: number
			splyAmt: number
			dcRt?: number
			dcAmt?: number
			taxTyCd: string
			taxblAmt: number
			taxAmt: number
			totAmt: number
		}>
		receipt: {
			rcptPbctDt: string
			prchrAcptcYn: "Y" | "N"
			custTin?: string
			custMblNo?: string
			trdeNm?: string
			adrs?: string
			topMsg?: string
			btmMsg?: string
		}
		totTaxblAmt: number
		totTaxAmt: number
		totAmt: number
	},
): Promise<string> {
	const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
	const now = Date.now()

	agent.sql`
		INSERT INTO brain_invoice (
			id, org_id, customer_tin, customer_name, customer_mobile,
			status, tot_taxbl_amt, tot_tax_amt, tot_amt,
			raw_payload, created_at, updated_at
		) VALUES (
			${id}, ${input.orgId}, ${input.customerTin ?? null},
			${input.customerName ?? null}, ${input.customerMobile ?? null},
			'draft', ${input.totTaxblAmt}, ${input.totTaxAmt}, ${input.totAmt},
			${JSON.stringify({ items: input.items, receipt: input.receipt })}, ${now}, ${now}
		)
	`

	return id
}

export async function submitInvoiceToETims(
	agent: CompanyBrainAgent,
	env: Env,
	invoiceId: string,
): Promise<{ etimsInvoiceNo: string; confirmedAt: string; qrCode?: string }> {
	const [row] = await agent.sql<{
		id: string
		org_id: string
		status: string
		etims_invoice_no: string | null
		etims_qr_code: string | null
		tot_taxbl_amt: number
		tot_tax_amt: number
		tot_amt: number
		customer_tin: string | null
		customer_name: string | null
		customer_mobile: string | null
		raw_payload: string
	}>`
		SELECT id, org_id, status, etims_invoice_no, etims_qr_code,
			tot_taxbl_amt, tot_tax_amt, tot_amt,
			customer_tin, customer_name, customer_mobile, raw_payload
		FROM brain_invoice WHERE id = ${invoiceId}
	`

	if (!row) throw new Error(`Invoice ${invoiceId} not found`)
	if (row.status !== "draft")
		throw new Error(`Invoice ${invoiceId} is already ${row.status}`)

	const config = buildEtimsOscuConfig(env)
	if (!config) {
		throw new Error(
			"eTIMS OSCU is not configured. Set ETIMS_OSCU_BASE_URL, ETIMS_OSCU_CLIENT_ID, ETIMS_OSCU_CLIENT_SECRET, ETIMS_OSCU_REGR_ID, ETIMS_OSCU_REGR_NM.",
		)
	}

	const now = new Date()
	const salesDt = now.toISOString().replace(/[-:]/g, "").slice(0, 8)
	const cfmDt = now.toISOString().replace(/[-:]/g, "").slice(0, 14)

	const raw = row.raw_payload ? JSON.parse(row.raw_payload) : {}
	const items: Array<{
		itemSeq: number
		itemCd: string
		itemNm: string
		pkgUnitCd: string
		pkg: number
		qtyUnitCd: string
		qty: number
		prc: number
		splyAmt: number
		dcRt?: number
		dcAmt?: number
		taxTyCd: string
		taxblAmt: number
		taxAmt: number
		totAmt: number
	}> = Array.isArray(raw.items) ? raw.items : []

	const etimsInvoiceNo = `ETIMS-${invoiceId}`

	let oscueResponse
	try {
		oscueResponse = await submitInvoiceToETimsOscu(config, {
			invcNo: etimsInvoiceNo,
			salesDt,
			cfmDt,
			taxblAmtA: row.tot_taxbl_amt,
			taxblAmtB: 0,
			taxblAmtC: 0,
			taxblAmtD: 0,
			taxblAmtE: 0,
			taxAmtA: row.tot_tax_amt,
			taxAmtB: 0,
			taxAmtC: 0,
			taxAmtD: 0,
			taxAmtE: 0,
			totTaxblAmt: row.tot_taxbl_amt,
			totTaxAmt: row.tot_tax_amt,
			totAmt: row.tot_amt,
			prchrAcctcYn: "N",
			regrId: config.regrId,
			regrNm: config.regrNm,
			modrId: config.regrId,
			modrNm: config.regrNm,
			receipt: {
				rcptPbctDt: cfmDt,
				prchrAcptcYn: "N",
				custTin: row.customer_tin ?? undefined,
				custMblNo: row.customer_mobile ?? undefined,
				trdeNm: row.customer_name ?? undefined,
				topMsg: "Thank you for your business",
				btmMsg: "E&OE",
			},
			itemList: items.map((item, i) => ({
				itemSeq: i + 1,
				itemCd: item.itemCd,
				itemNm: item.itemNm,
				pkgUnitCd: item.pkgUnitCd,
				pkg: item.pkg,
				qtyUnitCd: item.qtyUnitCd,
				qty: item.qty,
				prc: item.prc,
				splyAmt: item.splyAmt,
				dcRt: item.dcRt,
				dcAmt: item.dcAmt,
				taxTyCd: item.taxTyCd,
				taxblAmt: item.taxblAmt,
				taxAmt: item.taxAmt,
				totAmt: item.totAmt,
			})),
			custTin: row.customer_tin ?? undefined,
			custNm: row.customer_name ?? undefined,
		})
	} catch (err) {
		if (err instanceof ETimsOscuError) {
			throw new Error(
				`KRA eTIMS OSCU submission failed: ${err.resultMsg ?? err.message}`,
			)
		}
		throw err
	}

	const qrCode = oscueResponse.qrcode ?? undefined
	const confirmedAt = new Date().toISOString()

	agent.sql`
		UPDATE brain_invoice
		SET status = 'etims_confirmed',
			etims_invoice_no = ${etimsInvoiceNo},
			etims_confirmed_at = ${confirmedAt},
			etims_qr_code = ${qrCode ?? null},
			updated_at = ${Date.now()}
		WHERE id = ${invoiceId}
	`

	return { etimsInvoiceNo, confirmedAt, qrCode }
}

export async function postEtimsInvoiceToSlack(
	agent: CompanyBrainAgent,
	env: Env,
	input: {
		orgId: string
		invoiceId: string
		channel?: string
		threadTs?: string
	},
): Promise<{ ok: boolean; ts?: string; error?: string }> {
	const [row] = await agent.sql<{
		id: string
		org_id: string
		customer_name: string | null
		customer_tin: string | null
		customer_mobile: string | null
		status: string
		tot_taxbl_amt: number
		tot_tax_amt: number
		tot_amt: number
		etims_invoice_no: string | null
		etims_confirmed_at: string | null
		etims_qr_code: string | null
		raw_payload: string
	}>`
		SELECT id, org_id, customer_name, customer_tin, customer_mobile,
			status, tot_taxbl_amt, tot_tax_amt, tot_amt,
			etims_invoice_no, etims_confirmed_at, etims_qr_code, raw_payload
		FROM brain_invoice WHERE id = ${input.invoiceId}
	`

	if (!row) {
		return { ok: false, error: `Invoice ${input.invoiceId} not found` }
	}
	if (row.org_id !== input.orgId) {
		return { ok: false, error: "Invoice does not belong to this organization" }
	}

	const raw = row.raw_payload ? JSON.parse(row.raw_payload) : {}
	const items: Array<{
		itemNm: string
		qty: number
		prc: number
		totAmt: number
		taxAmt: number
	}> = Array.isArray(raw.items)
		? raw.items.map((item: any) => ({
				itemNm: item.itemNm,
				qty: item.qty,
				prc: item.prc,
				totAmt: item.totAmt,
				taxAmt: item.taxAmt,
			}))
		: []

	const payload: import("../slack/invoice-notification").EtimsInvoiceSlackPayload = {
		orgId: input.orgId,
		invoiceId: row.id,
		customerName: row.customer_name,
		customerTin: row.customer_tin,
		customerMobile: row.customer_mobile,
		totTaxblAmt: row.tot_taxbl_amt,
		totTaxAmt: row.tot_tax_amt,
		totAmt: row.tot_amt,
		status: row.status,
		etimsInvoiceNo: row.etims_invoice_no,
		etimsConfirmedAt: row.etims_confirmed_at,
		etimsQrCode: row.etims_qr_code,
		items,
		channel: input.channel,
		threadTs: input.threadTs,
	}

	const ts = await postEtimsInvoiceToSlackChannel(env, input.orgId, payload)
	if (!ts) {
		return { ok: false, error: "Failed to post invoice to Slack" }
	}

	return { ok: true, ts }
}

export async function listInvoices(
	agent: CompanyBrainAgent,
	input: {
		orgId: string
		status?: string
		limit?: number
		offset?: number
	},
): Promise<Array<{
	id: string
	orgId: string
	customerTin: string | null
	customerName: string | null
	customerMobile: string | null
	status: string
	totTaxblAmt: number
	totTaxAmt: number
	totAmt: number
	etimsInvoiceNo: string | null
	etimsConfirmedAt: string | null
	mpesaRef: string | null
	mpesaAmount: string | null
	mpesaReceivedAt: string | null
	createdAt: number
	updatedAt: number
}>> {
	const limit = Math.min(input.limit ?? 100, 500)
	const offset = input.offset ?? 0
	let sql = `
		SELECT id, org_id, customer_tin, customer_name, customer_mobile,
			status, tot_taxbl_amt, tot_tax_amt, tot_amt,
			etims_invoice_no, etims_confirmed_at,
			mpesa_ref, mpesa_amount, mpesa_received_at,
			created_at, updated_at
		FROM brain_invoice
		WHERE org_id = ${input.orgId}
	`
	const params: Array<string | number> = []
	if (input.status) {
		sql += ` AND status = $${params.length + 1}`
		params.push(input.status)
	}
	sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
	params.push(limit, offset)
	const rows = await agent.sql<{
		id: string
		org_id: string
		customer_tin: string | null
		customer_name: string | null
		customer_mobile: string | null
		status: string
		tot_taxbl_amt: number
		tot_tax_amt: number
		tot_amt: number
		etims_invoice_no: string | null
		etims_confirmed_at: string | null
		mpesa_ref: string | null
		mpesa_amount: string | null
		mpesa_received_at: string | null
		created_at: number
		updated_at: number
	}>(sql as any, ...params)
	return rows.map((row) => ({
		id: row.id,
		orgId: row.org_id,
		customerTin: row.customer_tin,
		customerName: row.customer_name,
		customerMobile: row.customer_mobile,
		status: row.status,
		totTaxblAmt: row.tot_taxbl_amt,
		totTaxAmt: row.tot_tax_amt,
		totAmt: row.tot_amt,
		etimsInvoiceNo: row.etims_invoice_no,
		etimsConfirmedAt: row.etims_confirmed_at,
		mpesaRef: row.mpesa_ref,
		mpesaAmount: row.mpesa_amount,
		mpesaReceivedAt: row.mpesa_received_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}))
}

/**
 * Match an incoming M-PESA transaction to an open invoice.
 * Matching rules (per Vendly/Tally/Upeosoft reconciliation guidance):
 *   1. Exact match on M-PESA ref code (highest confidence)
 *   2. Amount match + sender name match (medium confidence)
 *   3. Amount match alone (low confidence, exception queue)
 */
export async function matchMpesaToInvoice(
	agent: CompanyBrainAgent,
	orgId: string,
	mpesa: {
		ref: string
		amount: string
		counterparty: string | null
		time: string
		direction: string
	},
): Promise<{
	matched: boolean
	invoiceId: string | null
	confidence: "exact" | "amount" | "none"
	reason: string
}> {
	// Rule 1: Try exact match on M-PESA ref
	const [refMatch] = await agent.sql<{
		id: string
		status: string
	}>`SELECT id, status FROM brain_invoice
		WHERE org_id = ${orgId} AND mpesa_ref = ${mpesa.ref}`

	if (refMatch && refMatch.status !== "paid") {
		agent.sql`
			UPDATE brain_invoice
			SET status = 'paid',
				mpesa_amount = ${mpesa.amount},
				mpesa_received_at = ${mpesa.time},
				mpesa_direction = ${mpesa.direction},
				updated_at = ${Date.now()}
			WHERE id = ${refMatch.id}
		`
		await postPesaCastReceipt(agent, {
			invoiceId: refMatch.id,
			amount: mpesa.amount,
			counterparty: mpesa.counterparty ?? "",
			ref: mpesa.ref,
			time: mpesa.time,
			confidence: "exact",
		})
		return {
			matched: true,
			invoiceId: refMatch.id,
			confidence: "exact",
			reason: `Matched on M-PESA ref ${mpesa.ref}`,
		}
	}

	// Rule 2: Try amount match on open invoices
	const amount = Number(mpesa.amount)
	const [amtMatch] = await agent.sql<{
		id: string
		customer_name: string | null
	}>`SELECT id, customer_name FROM brain_invoice
		WHERE org_id = ${orgId}
			AND status IN ('draft', 'submitted_to_etims', 'etims_confirmed', 'partially_paid')
			AND ABS(CAST(tot_amt AS REAL) - ${amount}) < 1
		ORDER BY created_at DESC LIMIT 1`

	if (amtMatch) {
		const nameMatch =
			amtMatch.customer_name && mpesa.counterparty
				? amtMatch.customer_name
						.toLowerCase()
						.includes(mpesa.counterparty.toLowerCase()) ||
				  mpesa.counterparty
						.toLowerCase()
						.includes(amtMatch.customer_name.toLowerCase())
				: false

		if (nameMatch) {
			agent.sql`
				UPDATE brain_invoice
				SET status = 'paid',
					mpesa_ref = ${mpesa.ref},
					mpesa_amount = ${mpesa.amount},
					mpesa_received_at = ${mpesa.time},
					mpesa_direction = ${mpesa.direction},
					updated_at = ${Date.now()}
				WHERE id = ${amtMatch.id}
			`
			await postPesaCastReceipt(agent, {
				invoiceId: amtMatch.id,
				amount: mpesa.amount,
				counterparty: mpesa.counterparty ?? "",
				ref: mpesa.ref,
				time: mpesa.time,
				confidence: "amount",
			})
			return {
				matched: true,
				invoiceId: amtMatch.id,
				confidence: "amount",
				reason: `Matched on amount KES ${mpesa.amount} for ${amtMatch.customer_name}`,
			}
		}

		return {
			matched: false,
			invoiceId: amtMatch.id,
			confidence: "none",
			reason: `Amount match KES ${mpesa.amount} but sender "${mpesa.counterparty}" doesn't match customer "${amtMatch.customer_name}" — needs manual review`,
		}
	}

	return { matched: false, invoiceId: null, confidence: "none", reason: "No matching invoice found" }
}

async function postPesaCastReceipt(
	agent: CompanyBrainAgent,
	input: {
		invoiceId: string
		amount: string
		counterparty: string
		ref: string
		time: string
		confidence: "exact" | "amount"
	},
): Promise<void> {
	const env = brainAgent(agent).env
	const channel = env.PESACAST_SLACK_CHANNEL
	const token = env.SLACK_BOT_TOKEN
	if (!channel || !token) return

	const [inv] = await agent.sql<{
		tot_amt: number
		etims_invoice_no: string | null
	}>`SELECT tot_amt, etims_invoice_no FROM brain_invoice WHERE id = ${input.invoiceId}`

	const text = [
		`💰 *M-PESA Payment Received*`,
		`*Amount:* KES ${input.amount}`,
		`*From:* ${input.counterparty}`,
		`*Ref:* ${input.ref}`,
		`*Time:* ${input.time}`,
		`*Invoice:* ${input.invoiceId}`,
		input.confidence === "exact" ? `*Match:* Exact (ref)` : `*Match:* Amount`,
		inv?.etims_invoice_no ? `*eTIMS:* ${inv.etims_invoice_no}` : "",
		"",
		"_Auto-matched via PesaCast webhook_",
	].filter(Boolean).join("\n")

	await postSlackMessage(token, channel, text).catch((err) => {
		console.error("[pesacast] slack receipt failed:", err)
	})
}

/** Tables are created lazily, so a missing one is expected; anything else is not. */
function ifTablesExist(...runs: Array<() => void>): void {
	for (const run of runs) {
		try {
			run()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (!/no such table/i.test(message)) throw error
		}
	}
}

function slackOwnedScheduleIds(agent: CompanyBrainAgent): string[] {
	const ids: string[] = []
	const collect = (rows: Array<{ schedule_id: string }>) => {
		for (const row of rows) if (row.schedule_id) ids.push(row.schedule_id)
	}
	collect([
		...agent.sql<{
			schedule_id: string
		}>`SELECT schedule_id FROM brain_channel_observe`,
	])
	ifTablesExist(
		() =>
			collect([
				...agent.sql<{
					schedule_id: string
				}>`SELECT schedule_id FROM brain_post_turn_reflect`,
			]),
		() =>
			collect([
				...agent.sql<{
					schedule_id: string
				}>`SELECT schedule_id FROM brain_reaction_queue_schedule`,
			]),
		() =>
			collect([
				...agent.sql<{
					schedule_id: string
				}>`SELECT schedule_id FROM brain_team_invite_run`,
			]),
		() =>
			collect([
				...agent.sql<{
					schedule_id: string
				}>`SELECT schedule_id FROM brain_long_job WHERE schedule_id IS NOT NULL`,
			]),
	)
	return ids
}

export async function resetSlackWorkspaceState(
	agent: CompanyBrainAgent,
): Promise<void> {
	const scheduleIds = slackOwnedScheduleIds(agent)
	ifTablesExist(
		() => agent.sql`DELETE FROM slack_home_channel`,
		() => agent.sql`DELETE FROM brain_channel_observe`,
		() => agent.sql`DELETE FROM brain_channel_observe_scan`,
		() => agent.sql`DELETE FROM brain_channel_observe_pending`,
		() => agent.sql`DELETE FROM brain_channel_observe_batch`,
		() => agent.sql`DELETE FROM brain_channel_observe_retry`,
		() => agent.sql`DELETE FROM brain_channel_observe_probe`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_card`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_channel`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_document`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_message`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_thread`,
		() => agent.sql`DELETE FROM brain_public_channel_introduction`,
		() => agent.sql`DELETE FROM brain_team_invite_run`,
		() => agent.sql`DELETE FROM brain_team_invite_settings`,
		() => agent.sql`DELETE FROM brain_team_invite_target`,
		() => agent.sql`DELETE FROM brain_home_welcome`,
		() => agent.sql`DELETE FROM brain_member_notified`,
		() => agent.sql`DELETE FROM brain_channel_membership`,
		() => agent.sql`DELETE FROM brain_channel_backfill`,
		() => agent.sql`DELETE FROM brain_reaction_queue_schedule`,
		() => agent.sql`DELETE FROM brain_trial_reminder_arm`,
		() => agent.sql`DELETE FROM brain_long_job`,
	)
	await Promise.all(
		scheduleIds.map((id) => agent.cancelSchedule(id).catch(() => false)),
	)
}

export async function resetMemoryRegistry(
	agent: CompanyBrainAgent,
): Promise<void> {
	advanceBrainMemoryResetEpoch(agent)
	const scheduleIds = [
		...agent.sql<{ schedule_id: string }>`
			SELECT schedule_id FROM brain_post_turn_reflect
		`,
		...agent.sql<{ schedule_id: string }>`
			SELECT schedule_id FROM brain_channel_observe
		`,
	].map((row) => row.schedule_id)
	agent.sql`DELETE FROM brain_post_turn_reflect`
	agent.sql`DELETE FROM brain_post_turn_reflect_retry`
	agent.sql`DELETE FROM brain_post_turn_reflect_probe`
	agent.sql`DELETE FROM brain_channel_observe`
	agent.sql`DELETE FROM brain_channel_observe_scan`
	agent.sql`DELETE FROM brain_channel_observe_pending`
	agent.sql`DELETE FROM brain_channel_observe_batch`
	agent.sql`DELETE FROM brain_channel_observe_retry`
	agent.sql`DELETE FROM brain_channel_observe_probe`
	// carried_state regenerates deleted style and profile-sync's 24h throttle can
	// skip re-provisioning; clear both so reset fully wipes learned behavior.
	clearInteractionObserveState(agent)
	clearBrainProfileSync(agent)
	clearBrainMemoryRegistry(agent)
	// Auto-research keeps its own tables + recurring schedule; wipe them too.
	await resetAutoResearch(agent)
	await Promise.all(
		scheduleIds.map((id) => agent.cancelSchedule(id).catch(() => false)),
	)
}

/** Nuke every embedded-SQL table and cancel every schedule on this DO.
 * Called after a deploy so stale fiber checkpoints, sandbox sessions,
 * schedules, and learned state don't survive into the new build.
 */
export async function resetAllState(
	agent: CompanyBrainAgent,
): Promise<void> {
	// Cancel every recurring schedule first so nothing re-fires mid-cleanup.
	const scheduleIds: string[] = []
	const collect = (rows: Array<{ schedule_id: string }>) => {
		for (const row of rows) if (row.schedule_id) scheduleIds.push(row.schedule_id)
	}
	collect(agent.sql<{ schedule_id: string }>`SELECT schedule_id FROM brain_channel_observe`)
	collect(agent.sql<{ schedule_id: string }>`SELECT schedule_id FROM brain_post_turn_reflect`)
	ifTablesExist(() =>
		collect(
			agent.sql<{ schedule_id: string }>`
				SELECT schedule_id FROM brain_long_job WHERE schedule_id IS NOT NULL
			`,
		),
	)

	ifTablesExist(
		() => agent.sql`DELETE FROM brain_user_seen`,
		() => agent.sql`DELETE FROM brain_observe_cursor`,
		() => agent.sql`DELETE FROM brain_paused_turn`,
		() => agent.sql`DELETE FROM brain_long_job`,
		() => agent.sql`DELETE FROM brain_thread_investigation`,
		() => agent.sql`DELETE FROM brain_pending_approval`,
		() => agent.sql`DELETE FROM brain_decision_log`,
		() => agent.sql`DELETE FROM brain_sandbox_session`,
		() => agent.sql`DELETE FROM brain_sandbox_edit`,
		() => agent.sql`DELETE FROM brain_memory_state`,
		() => agent.sql`DELETE FROM brain_memory_node`,
		() => agent.sql`DELETE FROM brain_memory_tag`,
		() => agent.sql`DELETE FROM brain_workspace_prompt`,
		() => agent.sql`DELETE FROM brain_profile_sync`,
		() => agent.sql`DELETE FROM brain_skill`,
		() => agent.sql`DELETE FROM brain_skill_draft`,
		() => agent.sql`DELETE FROM brain_lease`,
		() => agent.sql`DELETE FROM brain_founder_brain`,
		() => agent.sql`DELETE FROM brain_journey_beat`,
		() => agent.sql`DELETE FROM research_announced`,
		() => agent.sql`DELETE FROM brain_trial_claim`,
		() => agent.sql`DELETE FROM install_nudge`,
		() => agent.sql`DELETE FROM slack_home_channel`,
		() => agent.sql`DELETE FROM brain_channel_observe`,
		() => agent.sql`DELETE FROM brain_channel_observe_scan`,
		() => agent.sql`DELETE FROM brain_channel_observe_pending`,
		() => agent.sql`DELETE FROM brain_channel_observe_batch`,
		() => agent.sql`DELETE FROM brain_channel_observe_retry`,
		() => agent.sql`DELETE FROM brain_channel_observe_probe`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_card`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_channel`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_document`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_message`,
		() => agent.sql`DELETE FROM brain_public_channel_rollout_thread`,
		() => agent.sql`DELETE FROM brain_public_channel_introduction`,
		() => agent.sql`DELETE FROM brain_team_invite_run`,
		() => agent.sql`DELETE FROM brain_team_invite_settings`,
		() => agent.sql`DELETE FROM brain_team_invite_target`,
		() => agent.sql`DELETE FROM brain_home_welcome`,
		() => agent.sql`DELETE FROM brain_member_notified`,
		() => agent.sql`DELETE FROM brain_channel_membership`,
		() => agent.sql`DELETE FROM brain_channel_backfill`,
		() => agent.sql`DELETE FROM brain_reaction_queue_schedule`,
		() => agent.sql`DELETE FROM brain_trial_reminder_arm`,
		() => agent.sql`DELETE FROM brain_post_turn_reflect`,
		() => agent.sql`DELETE FROM brain_post_turn_reflect_retry`,
		() => agent.sql`DELETE FROM brain_post_turn_reflect_probe`,
		() => agent.sql`DELETE FROM brain_research`,
		() => agent.sql`DELETE FROM brain_research_phase`,
		() => agent.sql`DELETE FROM brain_research_card`,
	)

	clearInteractionObserveState(agent)
	clearBrainProfileSync(agent)
	clearBrainMemoryRegistry(agent)

	await Promise.all(
		scheduleIds.map((id) => agent.cancelSchedule(id).catch(() => false)),
	)
}

export async function onApprovalDecision(
	agent: CompanyBrainAgent,
	decision: SlackApprovalDecision,
): Promise<void> {
	try {
		await runSlackApprovalDecision(agent, decision)
	} catch (err) {
		console.error("[company-brain] approval decision failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onTurnContinue(
	agent: CompanyBrainAgent,
	turnContinue: SlackTurnContinue,
): Promise<void> {
	try {
		await runSlackContinueTurn(agent, turnContinue)
	} catch (err) {
		console.error("[company-brain] turn continue failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

// One chunk per job at a time. Duplicate alarms are harmless to the paused
// envelope (resuming is one-shot), but two callbacks racing would each decide
// the job's terminal status and could mark a still-running job completed.
const activeLongJobSteps = new Set<string>()

export async function runTurnAutoContinue(
	agent: CompanyBrainAgent,
	payload: LongJobStepPayload,
): Promise<void> {
	try {
		if (activeLongJobSteps.has(payload.jobId)) return
		const job = loadLongJob(agent, payload.jobId)
		if (!job || job.status !== "running") return
		if (longJobIsExpired(job)) {
			markLongJobStatus(agent, job.jobId, "expired")
			return
		}
		const paused = loadPausedTurn(agent, payload.pauseId)
		if (!paused || paused.status !== "paused") return

		activeLongJobSteps.add(payload.jobId)
		try {
			await runSlackContinueTurn(agent, {
				teamId: job.teamId,
				pauseId: payload.pauseId,
				userId: job.askerUser,
			})

			// A pause while this chunk ran armed the next step and moved the
			// job's last_pause_id; leave the job alone. Otherwise the job is
			// done, or it handed off to an approval card.
			const after = loadLongJob(agent, payload.jobId)
			if (
				!after ||
				after.status !== "running" ||
				after.lastPauseId !== payload.pauseId
			) {
				return
			}
			const stillPaused = loadPausedTurn(agent, payload.pauseId)
			// Only a consumed pause means this chunk got to run. Anything else
			// (still paused, expired, unreadable) means the resume was refused.
			if (stillPaused?.status !== "resumed") {
				markLongJobStatus(agent, after.jobId, "cancelled")
				return
			}
			if (hasPendingApprovalForJob(agent, after)) {
				markLongJobStatus(agent, after.jobId, "waiting_approval")
				return
			}
			// A turn that was superseded or aborted between chunks never reached
			// the finish card, so close the job instead of reporting completion.
			const threadTurn = getThreadTurn(agent, after.threadKey)
			markLongJobStatus(
				agent,
				after.jobId,
				threadTurn?.turn_id === after.turnId &&
					threadTurn.status === "completed"
					? "completed"
					: "cancelled",
			)
		} finally {
			activeLongJobSteps.delete(payload.jobId)
		}
	} catch (err) {
		console.error("[company-brain] long job auto-continue failed:", err)
		markLongJobStatus(agent, payload.jobId, "error")
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onLongJobStop(
	agent: CompanyBrainAgent,
	payload: LongJobStopPayload,
): Promise<void> {
	const respond = async (text: string, responseType?: "ephemeral") => {
		if (!payload.responseUrl) return
		await updateSlackInteractionResponse(payload.responseUrl, {
			text,
			replaceOriginal: !responseType,
			...(responseType ? { responseType } : {}),
		})
	}
	try {
		const job = loadLongJob(agent, payload.jobId)
		if (!job) {
			await respond("That task is no longer running.", "ephemeral")
			return
		}
		if (job.teamId !== payload.teamId) return
		if (job.askerUser !== payload.userId) {
			await respond(
				`Only <@${job.askerUser}> can stop this task.`,
				"ephemeral",
			)
			return
		}
		if (job.status === "cancelled" || job.status === "completed") {
			await respond("That task already finished.", "ephemeral")
			return
		}
		const cancelled = await cancelLongJob(agent, job.jobId)
		if (cancelled?.lastPauseId) {
			markPausedTurnTerminal(agent, cancelled.lastPauseId, "cancelled")
		}
		cancelPendingApprovalsForJob(agent, job)
		await respond(
			"Stopped. Anything I already finished is still in the thread.",
		)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onLeaseDecision(
	agent: CompanyBrainAgent,
	decision: SlackLeaseDecision,
): Promise<void> {
	try {
		await runSlackLeaseDecision(agent, decision)
	} catch (err) {
		console.error("[company-brain] lease decision failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onSkillDraftInteraction(
	agent: CompanyBrainAgent,
	interaction: SlackSkillDraftInteraction,
): Promise<void> {
	try {
		await runSlackSkillDraftInteraction(agent, interaction)
	} catch (err) {
		console.error("[company-brain] skill draft interaction failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onContentDraftInteraction(
	agent: CompanyBrainAgent,
	interaction: SlackContentDraftInteraction,
): Promise<void> {
	try {
		await runContentDraftInteraction(agent, interaction)
	} catch (err) {
		console.error("[company-brain] content draft interaction failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onContentNewsInteraction(
	agent: CompanyBrainAgent,
	interaction: ContentNewsInteraction,
): Promise<void> {
	try {
		await runContentNewsInteraction(agent, interaction)
	} catch (err) {
		console.error("[company-brain] content news interaction failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function runLeaseEscalation(
	agent: CompanyBrainAgent,
	payload: LeaseEscalationPayload,
): Promise<void> {
	try {
		await runLeaseEscalationImpl(agent, payload)
	} catch (err) {
		console.error("[company-brain] lease escalation failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function runApprovalExpiry(
	agent: CompanyBrainAgent,
	payload: ApprovalExpiryPayload,
): Promise<void> {
	try {
		await runApprovalExpiryImpl(agent, payload)
	} catch (err) {
		console.error("[company-brain] approval expiry failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export function onConnectionRevoked(
	agent: CompanyBrainAgent,
	connectionId: string,
): void {
	invalidateMcpToolCatalog(agent, { connectionId })
	const n = revokeLeasesForConnection(agent, connectionId)
	if (n > 0) {
		console.log(
			`[company-brain] revoked ${n} lease(s) for deleted connection ${connectionId}`,
		)
	}
}

export function onConnectionChanged(
	agent: CompanyBrainAgent,
	serverSlug: string,
): void {
	invalidateMcpToolCatalog(agent, { serverSlug })
}

export async function onSlackConnectComplete(
	agent: CompanyBrainAgent,
	completion: SlackConnectCompletion,
): Promise<void> {
	try {
		await runSlackConnectComplete(agent, completion)
	} catch (err) {
		console.error("[company-brain] slack connect completion failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onParallelMonitorEvent(
	agent: CompanyBrainAgent,
	event: ParallelMonitorEvent,
): Promise<void> {
	try {
		await runParallelMonitorEvent(agent, event)
	} catch (err) {
		console.error("[company-brain] parallel monitor event failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export {
	armPublicChannelBeachhead,
	ensureAdminRolloutCard,
	ensurePublicChannelRolloutCard,
	getPublicChannelRolloutOverview,
	runPublicChannelBeachhead,
	runPublicChannelRollout,
	startPublicChannelRollout,
} from "../slack/public-channel-rollout"
export { getHomeChannel, setHomeChannel } from "./home-channel"
export { armInstallNudge, runInstallNudge } from "./install-nudge"
export { announceResearchIfDone } from "./research-announce"
export {
	attachAutomaticTeamInviteCard,
	onSlackTeamJoin,
	onSlackUserChange,
	recoverTeamInviteCallbackFailure,
	runSlackTeamJoinRetry,
	runSlackUserChangeRetry,
	runTeamInviteDirectoryPage,
	runTeamInviteProvisionStep,
	runTeamInviteStep,
	startAutomaticTeamInviteRollout,
	startTeamInviteWave,
} from "./team-invite"
export { claimTrialGrant, releaseTrialGrant } from "./trial-claim"

export async function onSlackEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
	fiber?: SlackTurnFiberControl,
): Promise<void> {
	try {
		await runSlackTurn(agent, msg, { fiber })
		await maybeNudgeInstallTools(agent, msg)
	} catch (err) {
		markFailedTriageClaim(agent, msg)
		console.error("[company-brain] runTurn failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function onSlackChimeIn(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		await runSlackChimeIn(agent, msg)
	} catch (err) {
		markFailedTriageClaim(agent, msg)
		console.error("[company-brain] runSlackChimeIn failed:", err)
	} finally {
		await flushBrainTelemetry()
	}
}

export async function finalizeInterruptedSlackTurn(
	agent: CompanyBrainAgent,
	snapshot: SlackTurnFiberSnapshot,
): Promise<void> {
	// try/finally, like the sibling handlers: a throw here used to skip the
	// flush entirely, and since the PostHog queue is a module-level array the
	// isolate then discarded every event queued so far. One failure erased the
	// telemetry trail needed to diagnose it.
	try {
		await finalizeInterruptedSlackTurnImpl(agent, snapshot)
	} finally {
		await flushBrainTelemetry()
	}
}

function markFailedTriageClaim(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): void {
	if (!msg.triageClaimId) return
	const identity = recordSlackEvent(agent, msg)
	if (!identity) return
	if (getStoredSlackEventAudit(agent, identity)?.decision !== "judging") return
	const finalized = recordStoredTriageDecision(agent, identity, {
		decision: "pass",
		claimId: msg.triageClaimId,
		source: "handler_error",
		reason: "Proactivity handling failed after the event was claimed.",
	})
	if (!finalized) return
	recordStoredActionOutcome(agent, identity, "handler_failed")
}

export async function onSlackContextEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		const identity = recordSlackEvent(agent, msg)
		if (!identity) return
		const audit = getStoredSlackEventAudit(agent, identity)
		if (!audit?.decision) {
			markStoredEventFiltered(
				agent,
				identity,
				"Slack event was retained as local context but is not model-triaged.",
			)
		}
	} catch (err) {
		console.error("[company-brain] onSlackContextEvent failed:", err)
	}
}

export async function runPassiveReactionQueue(
	agent: CompanyBrainAgent,
	payload: ReactionQueuePayload,
	schedule: Schedule<ReactionQueuePayload>,
): Promise<void> {
	try {
		await runPassiveReactionQueueImpl(agent, payload, schedule)
	} catch (err) {
		console.error("[company-brain] reaction queue failed:", err)
	} finally {
		await recoverPassiveReactionQueue(agent).catch((err) => {
			console.error("[company-brain] reaction queue recovery failed:", err)
		})
		await flushBrainTelemetry()
	}
}

export async function onSlackReaction(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		if (isMuteReactionEvent(msg.event)) {
			await runSlackMuteReaction(agent, msg)
			return
		}
		if (isFeedbackReactionEvent(msg.event)) {
			await runSlackFeedbackReaction(agent, msg)
			return
		}
		if (isDebugReactionEvent(msg.event)) {
			await runSlackDebugReaction(agent, msg)
		}
	} catch (err) {
		console.error("[company-brain] onSlackReaction failed:", err)
	}
}

export async function onSlackMembershipEvent(
	agent: CompanyBrainAgent,
	msg: SlackTurnMessage,
): Promise<void> {
	try {
		await runSlackMembershipEvent(agent, msg)
	} catch (err) {
		console.error("[company-brain] runSlackMembershipEvent failed:", err)
	}
}

export async function reconcileChannelMembership(
	agent: CompanyBrainAgent,
	teamId: string,
): Promise<void> {
	try {
		await reconcileChannelMembershipImpl(agent, teamId)
	} catch (err) {
		console.error("[company-brain] reconcileChannelMembership failed:", err)
	}
}

export async function debugTurn(
	agent: CompanyBrainAgent,
	input: { text: string; userId?: string },
): Promise<{
	reply: string
	memory: MemoryWriteback
	written: boolean
}> {
	const [{ db, eq }, { organization }, { writeMemories }] = await Promise.all([
		import("@repo/db"),
		import("@repo/db/schema/auth"),
		import("../memory"),
	])
	const [row] = await db(brainAgent(agent).env)
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			metadata: organization.metadata,
		})
		.from(organization)
		.where(eq(organization.id, agent.name))
		.limit(1)
	if (!row) {
		return {
			reply: `No org found for id "${agent.name}".`,
			memory: null,
			written: false,
		}
	}
	const org: SlackOrg = {
		id: row.id,
		name: row.name,
		slug: row.slug,
		metadata: row.metadata as Record<string, unknown> | null,
	}
	const out = await computeTurn({
		agent,
		org,
		userId: input.userId ?? org.id,
		actor: { orgId: org.id, userId: input.userId },
		question: input.text,
		threadText: "",
		obs: input.userId
			? { distinctId: input.userId, source: "api" }
			: { source: "api" },
	})
	if (out.status === "suspended") {
		return {
			reply: `Approval needed for ${out.approval.slug ?? out.approval.toolName}.`,
			memory: null,
			written: false,
		}
	}
	if (out.status === "paused") {
		// Internal turns borrow no thread surface, so the soft pause never arms
		// for them; this branch only keeps the result union exhaustive.
		return {
			reply: "I ran out of time on that one. Ask again to continue.",
			memory: null,
			written: false,
		}
	}
	const { reply, memory } = out
	let written = false
	if (memoryDocsFromWriteback(memory).length && input.userId) {
		written =
			(
				await writeMemories(
					brainAgent(agent).env,
					undefined,
					org,
					input.userId,
					memory,
					undefined,
					agent,
				)
			).written > 0
	}
	await flushBrainTelemetry()
	return { reply, memory, written }
}
