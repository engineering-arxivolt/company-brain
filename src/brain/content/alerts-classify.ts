/**
 * JEV classifies the alerts.
 *
 * The watchlist feeds produce a lot of things: thirty advisories a day, a
 * provider's whole incident history, every notice from a regulator. A
 * keyword filter narrows that, but keywords cannot tell an advisory our
 * customers might actually run from one they will never touch.
 *
 * JEV already routes playbooks for this system, and it is fast (a couple of
 * hundred milliseconds) and cheap. So the same classifier answers a second
 * question: of these candidate items, which are worth interrupting the
 * operator for? The answer is one item, or none — which is exactly the shape
 * a watch needs to keep the noise out.
 */
import { querySystemOne, isTypeSafeConfigured } from "../typesafe/client"
import type { AlertItem } from "./alerts"

const NONE_OF_THE_ABOVE = "none_of_the_above"

export type AlertClassification = {
	/** The items worth raising, most confident first. */
	selected: AlertItem[]
	/** The item JEV chose, and how sure it was. */
	choice: string | null
	confidence: number
	/** True when the classifier was unavailable and the fallback was used. */
	fallback: boolean
}

/**
 * Ask JEV which of these items are worth an alert.
 *
 * The deterministic filter has already done the cheap work; this is the
 * judgement call. When the classifier is unavailable, the fallback keeps
 * the deterministic behaviour rather than silently dropping everything: the
 * watch still works, it is just less selective.
 */
export async function classifyAlertsWithJev(args: {
	env: Env
	items: readonly AlertItem[]
	/** How sure the classifier must be before it interrupts anyone. */
	minConfidence?: number
	/** At most this many alerts at once. */
	maxAlerts?: number
	traceId?: string
}): Promise<AlertClassification> {
	const { env, items } = args
	const minConfidence = args.minConfidence ?? 0.6
	const maxAlerts = args.maxAlerts ?? 3
	if (!items.length) {
		return { selected: [], choice: null, confidence: 0, fallback: false }
	}
	if (!isTypeSafeConfigured(env)) {
		return {
			selected: items.slice(0, maxAlerts),
			choice: null,
			confidence: 0,
			fallback: true,
		}
	}
	const criteria: Record<string, string> = {}
	const byKey = new Map<string, AlertItem>()
	items.slice(0, 250).forEach((item, index) => {
		const key = `alert_${index}`
		criteria[key] = `${item.source}: ${item.title}${
			item.summary ? ` — ${item.summary.slice(0, 180)}` : ""
		}`
		byKey.set(key, item)
	})
	criteria[NONE_OF_THE_ABOVE] =
		"None of these items are worth interrupting the founder for."
	try {
		const response = await querySystemOne({
			apiKey: env.TYPESAFE_API_KEY!,
			state: `Who is Arxivolt? A Nairobi software foundry. Products: Forge (a deploy platform for developers and businesses in East Africa) and Foundry (compliance automation for Kenyan businesses: ODPC data protection, DPA 2022, KRA eTIMS). Their customers run web applications on cloud infrastructure, use AI APIs, and answer to the ODPC and KRA.\n\nCandidate news items:\n${items
				.slice(0, 250)
				.map((item, index) => `${index + 1}. [${item.source}] ${item.title}`)
				.join("\n")}`,
			questions: {
				matched_alert: {
					type: "choice",
					instructions:
						"Which item, if any, is worth interrupting the founder for right now? Choose it only if it changes a decision, cost, risk or deadline for a Kenyan business running software, or affects a stack they actually run (web servers, cloud hosting, AI APIs, databases), or is a regulatory notice from ODPC or KRA. Ignore routine advisories for libraries their customers would not run, minor provider notices, and general tech-industry news. Select none_of_the_above if nothing qualifies.",
					criteria,
				},
			},
			timeoutMs: 4_000,
		})
		const answer = response.answers?.matched_alert
		if (!answer || answer.type !== "choice") {
			return {
				selected: items.slice(0, maxAlerts),
				choice: null,
				confidence: 0,
				fallback: true,
			}
		}
		const confidence = answer.confidence ?? 0
		const probabilities = answer.probabilities ?? {}
		const selected: AlertItem[] = []
		const chosen = byKey.get(answer.choice)
		if (chosen && answer.choice !== NONE_OF_THE_ABOVE && confidence >= minConfidence)
			selected.push(chosen)
		// A second clear match is still worth raising; anything weaker is noise.
		for (const [key, probability] of Object.entries(probabilities)) {
			if (selected.length >= maxAlerts) break
			if (key === answer.choice || key === NONE_OF_THE_ABOVE) continue
			if ((probability ?? 0) < minConfidence) continue
			const item = byKey.get(key)
			if (item) selected.push(item)
		}
		console.log(
			`[company-brain][${args.traceId ?? "alerts"}] Jev alert routing choice=${answer.choice} confidence=${confidence} selected=${selected.length} candidates=${items.length}`,
		)
		return {
			selected,
			choice: answer.choice,
			confidence,
			fallback: false,
		}
	} catch (err) {
		console.warn(
			`[company-brain] Jev alert routing failed, falling back to the deterministic filter: ${err instanceof Error ? err.message : String(err)}`,
		)
		return {
			selected: items.slice(0, maxAlerts),
			choice: null,
			confidence: 0,
			fallback: true,
		}
	}
}
