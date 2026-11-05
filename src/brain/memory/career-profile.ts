import * as Effect from "effect/Effect"
import { makeAppLayer } from "@/config"
import { privateContainerTagFor } from "@/lib/spaces/provisioning"
import { findBrainDocument } from "../../memory/documents"
import { addMemorySingle } from "@/routes/memories/handler-effect"

/**
 * The base CV, kept where the brain can find it.
 *
 * A tailored CV is a cut of one base document: employers, dates, quantified
 * results, education, skills. That base belongs to the system, not to a chat
 * the model has to be handed — so an operator publishes it once into KV
 *
 *   npx wrangler kv key put --binding=BRAIN_KV \
 *     "career_profile:<userId>" --path=templates/cv-base.md --remote
 *
 * and the first document turn for that user copies it into their private
 * memory container, where search_company_brain and the document-delivery
 * playbook already look for it. No paste, no re-typing, no drift between what
 * the bot believes and what the CV says.
 */
export const CAREER_PROFILE_TYPE = "career_profile"

/**
 * A request that is really asking for a CV or cover letter. Shared by the turn
 * (whether to attach the base CV to the prompt) and by search_company_brain
 * (whether to return it as a result), so the two cannot drift apart.
 */
export const CAREER_DOCUMENT_PATTERN = /\b(cv|resume|resumé|cover letter)\b/i

/** KV key holding one user's base CV text. */
export function careerProfileKey(userId: string): string {
	return `career_profile:${userId}`
}

/** Deterministic document id, so a re-seed replaces instead of duplicating. */
export function careerProfileCustomId(userId: string): string {
	return `career_profile_${userId}`
}

/** Cheap content fingerprint: enough to notice an edited base CV. */
export function careerProfileDigest(text: string): string {
	let hash = 5381
	const value = text.trim()
	for (let index = 0; index < value.length; index++) {
		hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0
	}
	return `djb2_${hash.toString(16)}_${value.length}`
}

export type CareerProfileSeedPlan =
	| { action: "skip"; reason: "no_source" | "up_to_date" }
	| { action: "write"; content: string; digest: string }

/**
 * Seed only when there is a source and memory does not already carry that
 * exact text. Pure, so the decision is testable without a memory service.
 *
 * Two equality checks on purpose: the digest is the cheap one, and the stored
 * content is the one that still works if custom metadata keys do not survive a
 * round trip through the memory service. Either matching means "already there",
 * which is what keeps this from re-embedding the CV on every turn.
 */
export function planCareerProfileSeed(args: {
	source: string | null
	existingDigest: string | null
	existingContent?: string | null
}): CareerProfileSeedPlan {
	const content = args.source?.trim()
	if (!content) return { action: "skip", reason: "no_source" }
	const digest = careerProfileDigest(content)
	if (args.existingDigest === digest) return { action: "skip", reason: "up_to_date" }
	if (args.existingContent?.trim() === content) {
		return { action: "skip", reason: "up_to_date" }
	}
	return { action: "write", content, digest }
}

/**
 * The block a career-document turn carries in its runtime context.
 *
 * The base CV is the *input* to the task, so it travels with the request
 * instead of behind a tool call. Semantic search is the wrong retrieval here:
 * one long document does not rank against short queries, and a turn that has to
 * find it first spends its whole step budget looking.
 */
export function renderBaseCvContext(content: string): string {
	const text = content.trim()
	if (!text) return ""
	return [
		"<base_cv>",
		"This is the candidate's base CV, the source of truth for any CV or cover letter in this turn.",
		"Tailor from it: reorder, trim, and mirror the posting's vocabulary for what it actually says.",
		"Never add an employer, date, degree, metric or skill it does not contain.",
		"Do not search memory for it and do not ask the asker for it — it is right here.",
		"",
		text,
		"</base_cv>",
	].join("\n")
}

/** The operator-published base CV for this user, or null when none is set. */
export async function readCareerProfileSource(
	env: Env,
	userId: string,
): Promise<string | null> {
	try {
		const stored = await env.BRAIN_KV.get(careerProfileKey(userId))
		const text = stored?.trim()
		return text ? text : null
	} catch (error) {
		console.warn(
			`[company-brain] career_profile kv read failed user=${userId}:`,
			error instanceof Error ? error.message : error,
		)
		return null
	}
}

/**
 * Make sure the base CV is in this user's private memory.
 *
 * Idempotent: the digest stored in the document's metadata is what decides
 * whether to write, so a turn costs one document lookup and no write once the
 * CV is in place — and an edited `cv-base.md` re-seeds on the next turn.
 */
export async function ensureCareerProfileMemory(args: {
	env: Env
	executionCtx?: ExecutionContext
	org: { id: string; name?: string; metadata?: unknown }
	userId: string
	traceId?: string
}): Promise<{ seeded: boolean }> {
	const source = await readCareerProfileSource(args.env, args.userId)
	if (!source) return { seeded: false }

	const containerTag = privateContainerTagFor(args.userId)
	const existing = await findBrainDocument(args.env, {
		containerTag,
		metadata: [{ key: "type", value: CAREER_PROFILE_TYPE }],
	}).catch(() => null)
	const existingDigest =
		typeof existing?.metadata?.career_profile_digest === "string"
			? existing.metadata.career_profile_digest
			: null

	const plan = planCareerProfileSeed({
		source,
		existingDigest,
		existingContent: existing?.content ?? null,
	})
	if (plan.action === "skip") {
		if (args.traceId) {
			console.log(
				`[company-brain][${args.traceId}] career_profile skip reason=${plan.reason}`,
			)
		}
		return { seeded: false }
	}

	try {
		const program = addMemorySingle({
			org: {
				id: args.org.id,
				name: args.org.name,
				metadata: args.org.metadata,
			},
			userId: args.userId,
			source: "company-brain",
			executionCtx: args.executionCtx,
			// The base CV is one document that gets replaced, not appended to.
			isFullReplace: true,
			requestParams: {
				content: plan.content,
				customId: careerProfileCustomId(args.userId),
				containerTag,
				metadata: {
					type: CAREER_PROFILE_TYPE,
					sm_source: "company-brain",
					title: "Base CV",
					career_profile_digest: plan.digest,
				},
			},
		})
		await Effect.runPromise(
			program.pipe(
				Effect.provide(makeAppLayer({ executionCtx: args.executionCtx, env: args.env })),
			),
		)
		console.log(
			`[company-brain][${args.traceId ?? "turn"}] career_profile seeded chars=${plan.content.length} container=${containerTag}`,
		)
		return { seeded: true }
	} catch (error) {
		console.warn(
			`[company-brain][${args.traceId ?? "turn"}] career_profile seed failed:`,
			error instanceof Error ? error.message : error,
		)
		return { seeded: false }
	}
}
