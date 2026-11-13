import { sandboxLimits } from "../tools/sandbox/guards"

/**
 * Name the wall.
 *
 * A document build can fail for four different reasons that all used to read as
 * "it did not compile": our own timeout killed it, the sandbox's command ceiling
 * did, the file was too large to deliver, or the ask itself is bounded (a CV).
 * The person cannot act on the generic version, and neither could I — every one
 * of those needs a different change.
 *
 * Pure functions, because the numbers are the point: `sandboxLimits` is the
 * single source for the caps, so a message can never quote a limit the runtime
 * does not enforce.
 */
export const ARTIFACT_LIMIT_BYTES = sandboxLimits.maxArtifactBytes
export const COMMAND_LIMIT_SEC = sandboxLimits.maxTimeoutSec

const MB = 1024 * 1024

function mb(bytes: number): string {
	return `${(bytes / MB).toFixed(1)} MB`
}

/**
 * Why a build command failed, in terms the asker can act on.
 *
 * Exit 124 is `timeout`'s own code; 137 is SIGKILL (the OOM killer or a harder
 * kill). Both mean "it ran out of room", which is worth saying out loud.
 */
export function describeCommandFailure(args: {
	what: string
	exitCode: number
	timeoutSec: number
}): string {
	if (args.exitCode === 124) {
		return `${args.what} was stopped after ${args.timeoutSec}s (timeout). Nothing was delivered — a shorter scope, or a retry, is the way forward.`
	}
	if (args.exitCode === 137) {
		return `${args.what} was killed while running (exit 137, out of memory or a hard kill). Nothing was delivered.`
	}
	return `${args.what} failed with exit ${args.exitCode} (limit ${args.timeoutSec}s, sandbox ceiling ${COMMAND_LIMIT_SEC}s). The compile log is in the sandbox.`
}

/** The artifact cap, named with both numbers so the gap is obvious. */
export function describeArtifactFailure(args: {
	sizeBytes?: number
	limitBytes?: number
}): string {
	const limit = args.limitBytes ?? ARTIFACT_LIMIT_BYTES
	const size = args.sizeBytes && args.sizeBytes > 0 ? ` (${mb(args.sizeBytes)})` : ""
	return `the file is too large to deliver${size}: the artefact cap is ${mb(limit)}. Charts and images are usually what pushes a PDF over it.`
}

/**
 * Recognise the sandbox client's own limit error so it can be re-stated in those
 * terms instead of surfacing as an anonymous stream failure.
 */
export function isArtifactLimitError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return /artifact (contents )?exceeded|artifact limit/i.test(message)
}

/**
 * A bounded ask that is not a failure: the CV pipeline delivers at most two
 * pages, and says so, so the reply can offer the long-form path instead of
 * reporting a broken build.
 */
export function describePageCeiling(args: {
	what: string
	maxPages: number
	lastPages?: number
}): string {
	const seen =
		args.lastPages && args.lastPages > 0 ? ` (the closest render was ${args.lastPages} pages)` : ""
	return `${args.what} is capped at ${args.maxPages} pages on this path${seen}. Ask for a report if you need something longer — that pipeline has no page ceiling.`
}
