import * as Effect from "effect/Effect"
import {
	DocumentUpsertError,
	InvalidDocumentParametersError,
	QuotaExceededError,
	SpaceCreationError,
} from "@/services/errors"
import { VectorDBService } from "../../services/vectordb"
import type { BatchItemResult } from "./helpers"

export type AddMemorySingleParams = {
	org: { id: string; name?: string; metadata?: unknown }
	userId?: string
	source?: string
	executionCtx?: ExecutionContext
	/** Replace the document at `customId` outright rather than merging into it. */
	isFullReplace?: boolean
	/** Keep brain tags already on the document instead of re-deriving them. */
	preserveBrainTags?: boolean
	/**
	 * There is deliberately no `dreaming` flag here.
	 *
	 * It used to be one — `"instant"` on interactive writes, `"dynamic"` for
	 * channel history — except the field was accepted by this type and never
	 * passed to supermemory, so every call site read as if consolidation were
	 * configured per write when nothing was happening at all. supermemory 4.25.4
	 * has no such request parameter: dreaming is a property of the workspace,
	 * configured in supermemory itself, and its progress surfaces back as
	 * `dreamingStatus` on memories.
	 *
	 * What the brain does about that: it does not pretend to control dreaming.
	 * `taskType` decides what supermemory makes of the document, and the nightly
	 * pass in `src/brain/memory/dream.ts` is our own safety net for the part we
	 * *can* see (documents nobody reads any more), never a replacement for it.
	 */
	requestParams: {
		content: string
		customId?: string
		containerTag?: string
		containerTags?: string[]
		metadata?: Record<string, string | number | boolean | string[] | null>
		/**
		 * What supermemory should extract. The brain writes facts, so the default
		 * is `"memory"`; a full document (channel history, a report) says
		 * `"superrag"` instead.
		 */
		taskType?: "memory" | "superrag"
	}
}

/** supermemory takes scalar metadata; arrays travel as comma-joined strings. */
function flattenMetadata(
	metadata: AddMemorySingleParams["requestParams"]["metadata"],
): Record<string, string | number | boolean> | undefined {
	if (!metadata) return undefined
	const flat: Record<string, string | number | boolean> = {}
	for (const [key, value] of Object.entries(metadata)) {
		if (value === null || value === undefined) continue
		flat[key] = Array.isArray(value) ? value.join(",") : value
	}
	return flat
}

/**
 * Write one document into supermemory. Extraction, chunking and embedding all
 * happen server-side, so this is a single API call wrapped as an Effect so the
 * original call sites and their error handling stay intact.
 */
export function addMemorySingle(
	params: AddMemorySingleParams,
): Effect.Effect<
	BatchItemResult,
	| InvalidDocumentParametersError
	| DocumentUpsertError
	// Raised by the hosted ingest path, never here; kept in the channel so
	// callers can keep handling them.
	| QuotaExceededError
	| SpaceCreationError,
	VectorDBService
> {
	return Effect.gen(function* () {
		const client = yield* VectorDBService
		const { requestParams } = params
		const containerTags =
			requestParams.containerTags ??
			(requestParams.containerTag ? [requestParams.containerTag] : undefined)

		if (!requestParams.content?.trim()) {
			return yield* Effect.fail(
				new InvalidDocumentParametersError({
					message: "content is empty",
				}),
			)
		}

		return yield* Effect.tryPromise({
			try: async (): Promise<BatchItemResult> => {
				const result = await client.documents.add({
					content: requestParams.content,
					...(requestParams.customId
						? { customId: requestParams.customId }
						: {}),
					...(containerTags ? { containerTags } : {}),
					// Facts are what the brain writes and what it searches; the
					// document-shaped callers say "superrag" for themselves.
					taskType: requestParams.taskType ?? "memory",
					...(flattenMetadata(requestParams.metadata)
						? { metadata: flattenMetadata(requestParams.metadata) }
						: {}),
				})
				return { id: result.id, status: result.status ?? "queued" }
			},
			catch: (error) =>
				new DocumentUpsertError({
					orgId: params.org.id,
					message: error instanceof Error ? error.message : String(error),
					cause: error,
				}),
		})
	})
}
