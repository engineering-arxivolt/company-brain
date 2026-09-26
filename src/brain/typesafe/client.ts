export type SystemOnePrimitiveQuestion =
	| {
			type: "choice"
			instructions: string
			criteria: Record<string, string>
	  }
	| {
			type: "score"
			instructions: string
			criteria: string[]
	  }
	| {
			type: "noul"
			instructions: string
	  }

export type SystemOneChoiceAnswer = {
	type: "choice"
	choice: string
	confidence: number
	probabilities: Record<string, number>
}

export type SystemOneScoreAnswer = {
	type: "score"
	score: number
	confidence: number
	legend?: Record<string, string>
	probabilities?: Record<string, number>
}

export type SystemOneNoulAnswer = {
	type: "noul"
	noul: number
}

export type SystemOneAnswer =
	| SystemOneChoiceAnswer
	| SystemOneScoreAnswer
	| SystemOneNoulAnswer

export type SystemOneResponse<
	Q extends Record<string, SystemOnePrimitiveQuestion>,
> = {
	model: string
	answers: {
		[K in keyof Q]: Q[K] extends { type: "choice" }
			? SystemOneChoiceAnswer
			: Q[K] extends { type: "score" }
				? SystemOneScoreAnswer
				: Q[K] extends { type: "noul" }
					? SystemOneNoulAnswer
					: SystemOneAnswer
	}
	usage?: {
		input_tokens: number
		output_tokens: number
	}
}

export const TYPESAFE_API_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const TYPESAFE_DEFAULT_MODEL = "jev-latest"

export function isTypeSafeConfigured(env: Env): boolean {
	return Boolean(env.TYPESAFE_API_KEY?.trim())
}

export async function querySystemOne<
	Q extends Record<string, SystemOnePrimitiveQuestion>,
>(args: {
	apiKey: string
	state: string
	questions: Q
	model?: string
	timeoutMs?: number
	signal?: AbortSignal
}): Promise<SystemOneResponse<Q>> {
	const {
		apiKey,
		state,
		questions,
		model = TYPESAFE_DEFAULT_MODEL,
		timeoutMs = 5_000,
		signal,
	} = args

	const timeoutSignal = AbortSignal.timeout(timeoutMs)
	const combinedSignal = signal
		? AbortSignal.any([signal, timeoutSignal])
		: timeoutSignal

	const res = await fetch(TYPESAFE_API_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey.trim()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			state,
			questions,
		}),
		signal: combinedSignal,
	})

	if (!res.ok) {
		const text = await res.text().catch(() => "")
		throw new Error(
			`TypeSafe API error HTTP ${res.status}: ${text.slice(0, 500)}`,
		)
	}

	const data = (await res.json()) as SystemOneResponse<Q>
	return data
}
