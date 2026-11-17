import type { PendingBulletOptions } from "./options"
import { careerProfileDigest } from "../memory/career-profile"

/**
 * The CV the asker is actually working on.
 *
 * The published base CV is an operator artefact ("the facts, once"). A CV in
 * progress is something else: the last delivered document, plus the corrections
 * the asker confirmed along the way. Without it, every follow-up ("change the
 * date") re-derives the document from scratch and the change evaporates — the
 * bug this module exists to end.
 *
 * Two fields, because they answer two different questions:
 *
 * - `sourceMarkdown` — facts + confirmed edits only. Every new job is tailored
 *   from this, so a corrected date follows into the next application.
 * - `deliveredMarkdown` — the profile the last PDF was rendered from (tailoring
 *   and emphasis included, before page fitting). Edits are applied to *this*,
 *   because it is the document the asker is looking at when they say "the second
 *   bullet".
 *
 * A draft is pinned to the base it was seeded from. Re-publish the base and the
 * draft is dropped, because the operator has just said what the source of truth
 * is. That is a deliberate, logged trade: keeping edits that no longer apply to
 * the new base would resurrect facts the operator removed.
 */
export type CareerDraft = {
	sourceMarkdown: string
	deliveredMarkdown?: string
	/** Digest of the published base this chain started from. */
	baseDigest: string
	updatedAt: number
	/** The last applied edits, newest first — audit trail for the reply. */
	edits?: string[]
	/**
	 * The posting this CV is aimed at, compacted (`postingBrief`). An edit or an
	 * option request reads this when the thread no longer carries the posting —
	 * without it, a rewrite can only be judged on its own wording.
	 */
	postingBrief?: string
	/** Alternatives offered for one bullet, waiting for the asker to choose. */
	pendingOptions?: PendingBulletOptions
}

/** A working CV is not permanent state; a month idle means start from the base. */
const DRAFT_TTL_SECONDS = 60 * 24 * 60 * 60

/** One draft per user, beside the base CV in the same KV namespace. */
export function careerDraftKey(userId: string): string {
	return `career_cv_draft:${userId}`
}

/**
 * Which markdown a build should start from.
 *
 * Pure, so the rule is testable without KV: a draft only applies when its base
 * digest still matches the published base. A stale draft is not "mergeable" —
 * the base is the operator's statement of the facts, and stale edits can
 * contradict it.
 */
export function resolveWorkingCv(args: {
	base: string
	draft: CareerDraft | null
}): { markdown: string; fromDraft: boolean } {
	const base = args.base.trim()
	const draft = args.draft
	if (!draft) return { markdown: base, fromDraft: false }
	if (draft.baseDigest !== careerProfileDigest(base)) {
		return { markdown: base, fromDraft: false }
	}
	const working = draft.sourceMarkdown.trim()
	return working
		? { markdown: working, fromDraft: true }
		: { markdown: base, fromDraft: false }
}

/**
 * Which markdown an edit instruction is aimed at.
 *
 * The delivered document when there is one (that is what the asker is looking
 * at), otherwise the working CV — an edit can arrive before any PDF was built.
 */
export function editTargetMarkdown(args: {
	working: string
	draft: CareerDraft | null
}): string {
	const delivered = args.draft?.deliveredMarkdown?.trim()
	return delivered || args.working
}

function readDraft(raw: string | null): CareerDraft | null {
	if (!raw) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (typeof parsed !== "object" || parsed === null) return null
	const source = parsed as Record<string, unknown>
	if (
		typeof source.sourceMarkdown !== "string" ||
		!source.sourceMarkdown.trim() ||
		typeof source.baseDigest !== "string"
	) {
		return null
	}
	return {
		sourceMarkdown: source.sourceMarkdown,
		deliveredMarkdown:
			typeof source.deliveredMarkdown === "string"
				? source.deliveredMarkdown
				: undefined,
		baseDigest: source.baseDigest,
		updatedAt:
			typeof source.updatedAt === "number" ? source.updatedAt : Date.now(),
		edits: Array.isArray(source.edits)
			? source.edits.filter((line): line is string => typeof line === "string")
			: undefined,
		postingBrief:
			typeof source.postingBrief === "string" && source.postingBrief.trim()
				? source.postingBrief
				: undefined,
		pendingOptions: readPendingOptions(source.pendingOptions),
	}
}

/** A stored offer of bullet alternatives; anything malformed is simply dropped. */
function readPendingOptions(value: unknown): PendingBulletOptions | undefined {
	if (typeof value !== "object" || value === null) return undefined
	const source = value as Record<string, unknown>
	const entry = typeof source.entry === "string" ? source.entry : ""
	const index = typeof source.index === "number" ? Math.trunc(source.index) : 0
	if (!entry || index < 1 || !Array.isArray(source.options)) return undefined
	const options = source.options.slice(0, 6).flatMap((option) => {
		if (typeof option !== "object" || option === null) return []
		const record = option as Record<string, unknown>
		const text = typeof record.text === "string" ? record.text.trim() : ""
		const why = typeof record.why === "string" ? record.why.trim() : ""
		if (!text || !why) return []
		return [
			{
				text,
				why,
				approach:
					typeof record.approach === "string" ? record.approach : undefined,
			},
		]
	})
	if (!options.length) return undefined
	return {
		entry,
		index,
		createdAt:
			typeof source.createdAt === "number" ? source.createdAt : Date.now(),
		options,
	}
}

export async function readCareerDraft(
	env: Env,
	userId: string,
): Promise<CareerDraft | null> {
	try {
		return readDraft(await env.BRAIN_KV.get(careerDraftKey(userId)))
	} catch (error) {
		console.warn(
			`[company-brain] career draft read failed user=${userId}:`,
			error instanceof Error ? error.message : error,
		)
		return null
	}
}

/** Best-effort: a draft that cannot be written must not fail a delivered PDF. */
export async function writeCareerDraft(
	env: Env,
	userId: string,
	draft: CareerDraft,
): Promise<void> {
	try {
		await env.BRAIN_KV.put(careerDraftKey(userId), JSON.stringify(draft), {
			expirationTtl: DRAFT_TTL_SECONDS,
		})
	} catch (error) {
		console.warn(
			`[company-brain] career draft write failed user=${userId}:`,
			error instanceof Error ? error.message : error,
		)
	}
}

/** "Start again from my real CV." */
export async function clearCareerDraft(
	env: Env,
	userId: string,
): Promise<void> {
	try {
		await env.BRAIN_KV.delete(careerDraftKey(userId))
	} catch (error) {
		console.warn(
			`[company-brain] career draft delete failed user=${userId}:`,
			error instanceof Error ? error.message : error,
		)
	}
}
