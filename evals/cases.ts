import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Golden turns: the asks that must keep meaning what they mean.
 *
 * These are routing evals, not answer-quality evals. They run offline, in
 * milliseconds, with no model and no network: they assert which deterministic
 * route a message takes, because that is the decision that ends a turn and the
 * place where four of the last five production bugs lived.
 *
 * An eval nobody can explain is noise, so `why` is required — it is the case's
 * reason to exist, and the thing that tells the next person whether the
 * expectation is still the one they want.
 *
 * Adding a case: append one JSON object per line to turns.jsonl. Keep the
 * `question` exactly as a person would type it in Slack, typos included.
 */

/** How the Flow gate saw the message. */
export type FlowExpectation =
	/** A picture was queued. */
	| "queued"
	/** Would have queued, and the gate stopped it. */
	| "blocked"
	/** Nothing picture-shaped about it. */
	| "not-asked"

export type TurnEvalExpectation = {
	/** The route that runs first, or null when the model handles the turn. */
	primary: string | null
	/** Every route that claims the message, in compute.ts precedence order. */
	matched: string[]
	flow: FlowExpectation
	/** Only asserted when present: whether the picture is a clip. */
	clip?: boolean
}

export type TurnEvalCase = {
	id: string
	question: string
	expect: TurnEvalExpectation
	why: string
}

const FLOW_EXPECTATIONS: readonly FlowExpectation[] = [
	"queued",
	"blocked",
	"not-asked",
]

function parseCase(line: string, lineNumber: number, file: string): TurnEvalCase {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch (error) {
		throw new Error(
			`${file}:${lineNumber} is not valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
	const record = value as Partial<TurnEvalCase>
	const where = `${file}:${lineNumber}`
	if (typeof record.id !== "string" || !record.id) {
		throw new Error(`${where} has no id`)
	}
	if (typeof record.question !== "string" || !record.question.trim()) {
		throw new Error(`${where} (${record.id}) has no question`)
	}
	if (typeof record.why !== "string" || !record.why.trim()) {
		throw new Error(`${where} (${record.id}) has no why — say what it guards`)
	}
	const expect = record.expect as Partial<TurnEvalExpectation> | undefined
	if (!expect) throw new Error(`${where} (${record.id}) has no expect block`)
	const primary = expect.primary ?? null
	if (primary !== null && typeof primary !== "string") {
		throw new Error(`${where} (${record.id}) has an unreadable primary`)
	}
	if (!Array.isArray(expect.matched) || expect.matched.some((r) => typeof r !== "string")) {
		throw new Error(`${where} (${record.id}) needs matched as a string array`)
	}
	if (!expect.flow || !FLOW_EXPECTATIONS.includes(expect.flow)) {
		throw new Error(
			`${where} (${record.id}) needs flow to be one of ${FLOW_EXPECTATIONS.join(", ")}`,
		)
	}
	return {
		id: record.id,
		question: record.question,
		expect: {
			primary,
			matched: expect.matched,
			flow: expect.flow,
			...(typeof expect.clip === "boolean" ? { clip: expect.clip } : {}),
		},
		why: record.why,
	}
}

const EVALS_DIR = dirname(fileURLToPath(import.meta.url))
const TURNS_PATH = resolve(EVALS_DIR, "turns.jsonl")

/**
 * Read and validate every golden turn. Throws on the first malformed line.
 *
 * Plain path strings, no `URL`, and the bytes decoded through `String(...)`
 * (Buffer's default utf8 decode) on purpose: this file is typechecked with both
 * the Node and the Workers type sets loaded, and their globals (`URL`, `Buffer`)
 * are not the same types — the tidier-looking overloads do not compile.
 */
export function loadTurnEvals(path: string = TURNS_PATH): TurnEvalCase[] {
	// A relative path is read from this directory, so a run can add cases from
	// somewhere else without repeating the folder.
	const file = resolve(EVALS_DIR, path)
	const text = String(readFileSync(file))
	const cases: TurnEvalCase[] = []
	const seen = new Set<string>()
	text.split("\n").forEach((rawLine, index) => {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) return
		const testCase = parseCase(line, index + 1, String(file))
		if (seen.has(testCase.id)) {
			throw new Error(`${file}:${index + 1} repeats the id ${testCase.id}`)
		}
		seen.add(testCase.id)
		cases.push(testCase)
	})
	if (!cases.length) throw new Error(`${file} has no cases`)
	return cases
}
