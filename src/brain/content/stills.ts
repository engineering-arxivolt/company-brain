/**
 * Still planning: the image half of a campaign, without the campaign.
 *
 * The campaign pack parser is strict on purpose — it refuses a plan without
 * posts and chart data — which is wrong for an ask that only wants pictures.
 * This module asks the model for scenes alone, parses them leniently, and
 * renders paste-ready prompts for flow-mcp's Bulk Storyboard: one line each,
 * house style, no text (lettering is drawn later, deterministically).
 */
export type StillScene = {
	seconds: number
	/** The narration line, when the plan carries one (optional for stills). */
	line: string
	/** What the picture shows. */
	visual: string
}

export type StillPlan = { scenes: StillScene[] }

export const STILL_PLAN_SYSTEM = [
	"You plan the pictures for a short social campaign.",
	"Reply with ONLY a JSON object, no markdown fences, matching this schema:",
	'{"stills": [{"visual": string, "line": string}]}',
	"Rules:",
	"- 4 to 6 stills unless the request names a number.",
	"- visual: one concrete scene, 15-30 words, what a camera would see. No text in the image.",
	"- line: one short sentence of narration for that moment.",
	"- Ground everything in the request; never invent statistics, names or logos.",
].join("\n")

export function buildStillPlanPrompt(subject: string, count?: number): {
	system: string
	user: string
} {
	return {
		system: STILL_PLAN_SYSTEM,
		user: `# Subject\n\n${subject}${count ? `\n\n# Stills wanted\n\n${count}` : ""}`,
	}
}

function clampText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null
	const text = value.replace(/\s+/g, " ").trim()
	if (!text) return null
	return text.slice(0, max)
}

/**
 * Parse leniently: models drift between `stills`, `scenes` and `script`, and
 * sometimes return a bare array. Anything unusable falls back to one still
 * built from the request, so this never returns an empty plan.
 */
export function parseStillPlan(raw: string | null, subject: string): StillPlan {
	const fallback: StillPlan = {
		scenes: [{ seconds: 8, line: "", visual: subject.trim() }],
	}
	if (!raw) return fallback
	const start = raw.indexOf("{")
	const end = raw.lastIndexOf("}")
	const arrayStart = raw.indexOf("[")
	let candidates: unknown[] = []
	try {
		if (start >= 0 && end > start) {
			const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
			for (const key of ["stills", "scenes", "script", "images", "frames"]) {
				const value = parsed[key]
				if (Array.isArray(value)) {
					candidates = value
					break
				}
			}
		} else if (arrayStart >= 0) {
			const parsed = JSON.parse(raw.slice(arrayStart, raw.lastIndexOf("]") + 1))
			if (Array.isArray(parsed)) candidates = parsed
		}
	} catch {
		return fallback
	}
	const scenes: StillScene[] = candidates.flatMap((entry) => {
		if (typeof entry === "string") {
			const visual = clampText(entry, 300)
			return visual ? [{ seconds: 8, line: "", visual }] : []
		}
		if (typeof entry !== "object" || entry === null) return []
		const record = entry as Record<string, unknown>
		const visual =
			clampText(record.visual, 300) ??
			clampText(record.description, 300) ??
			clampText(record.prompt, 300) ??
			clampText(record.image, 300) ??
			clampText(record.scene, 300)
		if (!visual) return []
		const seconds =
			typeof record.seconds === "number" && Number.isFinite(record.seconds)
				? Math.min(Math.max(Math.round(record.seconds), 3), 20)
				: 8
		return [{ seconds, line: clampText(record.line, 200) ?? "", visual }]
	})
	if (!scenes.length) return fallback
	return { scenes: scenes.slice(0, 8) }
}

/**
 * The paste-ready pack: one self-contained line per still, nothing else.
 * Every line carries the house look and repeats the no-text rule, because the
 * operator may paste a single line rather than the whole file.
 */
export function renderStillPrompts(
	plan: StillPlan,
	style = "Flat corporate illustration, deep blue (#1B3A5C) and white palette, cool grey accents, minimal geometric shapes",
	aspect = "9:16",
): string {
	return plan.scenes
		.map(
			(scene, index) =>
				`${index + 1}. ${scene.visual.replace(/[.\s]+$/, "")}. ${style}, ${aspect} vertical, no text, no lettering, no logos, no watermarks.`,
		)
		.join("\n")
}
/** Just the slice of Workers AI this needs, so tests can stub it. */
type StillAI = {
	run(
		model: string,
		input: {
			messages: Array<{ role: string; content: string }>
			max_tokens?: number
		},
	): Promise<unknown>
}

/** The 8b answers a short JSON plan reliably and costs far less than the 70b. */
const STILL_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"

/**
 * One model call for the still list. Returns the raw reply (the parser is
 * lenient on purpose) or null when the call itself fails.
 */
export async function requestStillPlan(
	ai: StillAI | undefined,
	prompt: { system: string; user: string },
	traceId: string,
): Promise<string | null> {
	if (!ai) return null
	try {
		const result = (await ai.run(STILL_MODEL, {
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			max_tokens: 1200,
		})) as unknown
		const shaped = result as {
			response?: unknown
			choices?: Array<{ message?: { content?: unknown } }>
		}
		const text =
			typeof shaped?.response === "string"
				? shaped.response
				: typeof shaped?.choices?.[0]?.message?.content === "string"
					? (shaped.choices[0]?.message?.content as string)
					: ""
		if (!text) {
			console.log(
				`[company-brain][${traceId}] still plan: unreadable reply from ${STILL_MODEL}`,
			)
			return null
		}
		return text
	} catch (error) {
		console.log(
			`[company-brain][${traceId}] still plan call failed:`,
			error instanceof Error ? error.message : String(error),
		)
		return null
	}
}
