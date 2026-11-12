import { SHARED_TEAM_BRAIN_CONTAINER_TAG } from "@/lib/spaces/provisioning"
import { listBrainDocuments } from "../../memory/documents"
import { deleteStaleBrainMemoryDocument } from "./cleanup"
import {
	type ConsolidationDoc,
	msUntilNextDream,
	planConsolidation,
} from "./consolidate"

/**
 * The dream: the nightly pass over what the org remembers.
 *
 * It plans with `consolidate.ts` (pure, tested) and then *may* act on that
 * plan. Acting is gated twice on purpose — the caller has to ask, and the
 * deployment has to allow it (`DREAM_APPLY=on`) — because deleting the wrong
 * memory is not recoverable and the first weeks of a new job are when you want
 * to read the plan, not trust it.
 *
 * A run that plans but does not apply is not a no-op: it returns the same
 * report and writes the same decision row, which is how you decide whether to
 * turn it on.
 */
export const DREAM_CALLBACK = "runDream"
export const DREAM_HOUR_UTC = 3
/** One container's worth of recent notes; the long tail is not a memory problem. */
export const DREAM_SCAN_LIMIT = 200

export type DreamReport = {
	orgId: string
	containerTag: string
	/** Documents read from the container. */
	scanned: number
	/** Distinct notes left after de-duplication. */
	distinct: number
	duplicateNotes: number
	staleNotes: number
	/** Documents actually removed (0 when the run only planned). */
	deleted: number
	applied: boolean
	startedAt: number
	finishedAt: number
}

/** Both keys must turn for a run to delete anything. */
export function shouldApplyDream(
	flag: string | undefined,
	requested: boolean,
): boolean {
	return requested && flag === "on"
}

export function toCandidate(document: {
	id: string
	content: string | null
	title: string | null
	createdAt: string
	customId?: string | null
}, fallback: number): ConsolidationDoc {
	const parsed = Date.parse(document.createdAt)
	return {
		id: document.id,
		content: document.content ?? document.title ?? "",
		createdAt: Number.isFinite(parsed) ? parsed : fallback,
		customId: document.customId ?? null,
	}
}

export async function runDream(args: {
	env: Env
	orgId: string
	/** Delete what the plan says, instead of only reporting it. */
	apply: boolean
	traceId: string
	now?: number
}): Promise<DreamReport> {
	const startedAt = args.now ?? Date.now()
	const containerTag = SHARED_TEAM_BRAIN_CONTAINER_TAG

	// A container that cannot be read is not a reason to fail the night: the
	// report says nothing was scanned and the next run tries again.
	const documents = await listBrainDocuments(args.env, {
		containerTag,
		limit: DREAM_SCAN_LIMIT,
		includeContent: true,
	}).catch((error) => {
		console.warn(
			`[company-brain][${args.traceId}] dream scan failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return []
	})

	const plan = planConsolidation(
		documents.map((document) => toCandidate(document, startedAt)),
		{ now: startedAt },
	)

	const victims = [
		...plan.duplicates.flatMap((entry) => entry.drop),
		...plan.stale.map((entry) => entry.id),
	]
	let deleted = 0
	if (args.apply) {
		for (const documentId of victims) {
			try {
				await deleteStaleBrainMemoryDocument({
					env: args.env,
					orgId: args.orgId,
					documentId,
				})
				deleted += 1
			} catch (error) {
				// One stubborn document must not stop the sweep, and a partial
				// delete is reported rather than hidden.
				console.warn(
					`[company-brain][${args.traceId}] dream delete failed id=${documentId}:`,
					error instanceof Error ? error.message : String(error),
				)
			}
		}
	}

	const report: DreamReport = {
		orgId: args.orgId,
		containerTag,
		scanned: documents.length,
		distinct: plan.distinct,
		duplicateNotes: plan.duplicates.reduce(
			(total, entry) => total + entry.drop.length,
			0,
		),
		staleNotes: plan.stale.length,
		deleted,
		applied: args.apply,
		startedAt,
		finishedAt: Date.now(),
	}
	console.log(
		`[company-brain][${args.traceId}] dream scanned=${report.scanned} distinct=${report.distinct} duplicates=${report.duplicateNotes} stale=${report.staleNotes} deleted=${report.deleted} applied=${report.applied}`,
	)
	return report
}

/** How long until the next run, for the caller's alarm. */
export function dreamDelaySeconds(now = new Date()): number {
	return Math.max(60, Math.round(msUntilNextDream(now, DREAM_HOUR_UTC) / 1000))
}
