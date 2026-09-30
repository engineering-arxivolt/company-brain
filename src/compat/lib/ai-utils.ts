import { NoObjectGeneratedError, NoOutputGeneratedError } from "ai"
import { jsonrepair } from "jsonrepair"
import type { z } from "zod"

/**
 * A model advertised `response_format` but did not produce output matching the
 * schema, even after JSON repair.
 *
 * Distinct from a transport or generation failure on purpose. Callers that
 * default on error (triage acking instead of answering) are correct to do so,
 * but the *reason* matters: a transient 429 and a model that can never emit the
 * schema need different handling, and only this one means the model should be
 * taken off the decision paths.
 */
export class StructuredOutputCapabilityError extends Error {
	readonly model: string | undefined
	readonly raw: string | undefined
	constructor(args: { model?: string; raw?: string; cause?: unknown }) {
		super(
			`model${args.model ? ` ${args.model}` : ""} did not produce output matching the schema${
				args.model ? " despite advertising response_format" : ""
			}`,
			{ cause: args.cause },
		)
		this.name = "StructuredOutputCapabilityError"
		this.model = args.model
		this.raw = args.raw
	}
}

/**
 * Wrap a structured-output failure so the model is named. The brain's decision
 * paths fall back to a safe default on error -- an unparsed approval
 * classification becomes "unknown", which forces requester approval -- so
 * without this the only symptom is a quietly degraded decision path, with
 * nothing in the logs pointing at the model responsible.
 */
function capabilityFailure(
	error: unknown,
	model: string | undefined,
	raw?: string,
): never {
	throw new StructuredOutputCapabilityError({ model, raw, cause: error })
}

/** Gemini moderation surfaces as a ZodError wrapped in AI_APICallError — walk `cause` to find it. */
export function isGeminiContentBlock(error: unknown): boolean {
	const seen = new Set<unknown>()
	let cur: unknown = error
	while (cur && !seen.has(cur)) {
		seen.add(cur)
		const e = cur as Record<string, unknown>
		const parts: string[] = [typeof cur === "string" ? cur : String(cur)]
		for (const key of ["message", "responseBody", "text"]) {
			const v = e[key]
			if (typeof v === "string") parts.push(v)
		}
		const value = e.value
		if (value !== undefined) {
			try {
				parts.push(typeof value === "string" ? value : JSON.stringify(value))
			} catch {}
		}
		const haystack = parts.join(" ")
		if (
			haystack.includes("PROHIBITED_CONTENT") ||
			haystack.includes("blockReason") ||
			(haystack.includes("candidates") && haystack.includes("expected array"))
		) {
			return true
		}
		cur = e.cause
	}
	return false
}

/**
 * `generateText` + `Output.object` can throw on `result.output` when `finishReason` is
 * missing from gateway/proxy responses even though `result.text` has valid JSON
 * (https://github.com/vercel/ai/issues/11348). Fall back to parsing `text`.
 */
export function getGenerateTextStructuredOutput<S extends z.ZodTypeAny>(
	result: { readonly text: string; readonly output: z.infer<S> },
	schema: S,
	model?: string,
): z.infer<S> {
	try {
		return result.output
	} catch (error) {
		if (
			!NoOutputGeneratedError.isInstance(error) &&
			!NoObjectGeneratedError.isInstance(error)
		) {
			throw error
		}
		const raw = result.text.trim()
		if (!raw) {
			capabilityFailure(error, model)
		}
		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			try {
				value = JSON.parse(jsonrepair(raw))
			} catch {
				capabilityFailure(error, model, raw)
			}
		}
		try {
			return schema.parse(value)
		} catch (parseError) {
			capabilityFailure(parseError, model, raw)
		}
	}
}

export async function getStreamTextStructuredOutput<S extends z.ZodTypeAny>(
	result: {
		readonly text: PromiseLike<string>
		readonly output: PromiseLike<z.infer<S>>
	},
	schema: S,
	model?: string,
): Promise<z.infer<S>> {
	try {
		return await result.output
	} catch (error) {
		if (
			!NoOutputGeneratedError.isInstance(error) &&
			!NoObjectGeneratedError.isInstance(error)
		) {
			throw error
		}
		const raw = (await result.text).trim()
		if (!raw) {
			capabilityFailure(error, model)
		}
		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			try {
				value = JSON.parse(jsonrepair(raw))
			} catch {
				capabilityFailure(error, model, raw)
			}
		}
		try {
			return schema.parse(value)
		} catch (parseError) {
			capabilityFailure(parseError, model, raw)
		}
	}
}

export const repairJsonOutput = async ({
	text,
}: {
	text: string
	error: unknown
}): Promise<string | null> => {
	try {
		return jsonrepair(text)
	} catch {
		return null
	}
}
