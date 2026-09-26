import type { CompanyBrainAgent } from "../turn/agent"
import {
	isTypeSafeConfigured,
	querySystemOne,
} from "../typesafe/client"
import {
	listVisibleRuntimeSkills,
	loadVisibleSkillByName,
	type RuntimeSkill,
} from "./store"
import { SKILL_DESCRIPTION_MAX_CHARS } from "./validation"

export type ResolvedSkillSelection = {
	preloadedSkills: Array<{
		id: string
		name: string
		version: number
		body: string
	}>
	remainingSkillsText: string
	selectedSkillIds: string[]
}

const NONE_OF_THE_ABOVE = "none_of_the_above"

export async function resolveSkillsWithJev(args: {
	env: Env
	agent: CompanyBrainAgent
	userId?: string
	question: string
	visibleSkills: RuntimeSkill[]
	traceId?: string
}): Promise<ResolvedSkillSelection | null> {
	const { env, agent, userId, question, visibleSkills, traceId } = args

	if (!isTypeSafeConfigured(env) || !visibleSkills.length || !question.trim()) {
		return null
	}

	// Prepare criteria for Jev choice primitive (max 255 options)
	const criteria: Record<string, string> = {}
	const skillBySafeKey = new Map<string, RuntimeSkill>()

	for (let i = 0; i < Math.min(visibleSkills.length, 250); i++) {
		const skill = visibleSkills[i]!
		// Make safe alphanumeric identifier key
		const key = `skill_${i}_${skill.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40)}`
		const desc = skill.description
			? skill.description.replace(/\s+/g, " ").trim().slice(0, SKILL_DESCRIPTION_MAX_CHARS)
			: "Playbook instructions for this skill"
		criteria[key] = `${skill.name}: ${desc}`
		skillBySafeKey.set(key, skill)
	}

	criteria[NONE_OF_THE_ABOVE] =
		"None of the playbooks above apply to the user's task or question."

	try {
		const startedAt = Date.now()
		const jevRes = await querySystemOne({
			apiKey: env.TYPESAFE_API_KEY!,
			state: `User Request:\n"${question.slice(0, 4_000)}"`,
			questions: {
				matched_skill: {
					type: "choice",
					instructions:
						"Determine if any of the available organizational skills/playbooks directly apply to this task. Select none_of_the_above if none fit closely.",
					criteria,
				},
			},
			timeoutMs: 3_500,
		})

		const answer = jevRes.answers?.matched_skill
		if (!answer || answer.type !== "choice") return null

		const chosenKey = answer.choice
		const confidence = answer.confidence ?? 0
		const probabilities = answer.probabilities ?? {}

		console.log(
			`[company-brain][${traceId ?? "turn"}] Jev skill routing choice=${chosenKey} confidence=${confidence} ms=${Date.now() - startedAt}`,
		)

		if (chosenKey === NONE_OF_THE_ABOVE || confidence < 0.65) {
			// No clear single skill to preload
			return null
		}

		const chosenSkill = skillBySafeKey.get(chosenKey)
		if (!chosenSkill) return null

		// Load the markdown body
		const loaded = loadVisibleSkillByName(agent, {
			userId,
			name: chosenSkill.name,
		})
		if (!loaded) return null

		return {
			preloadedSkills: [
				{
					id: loaded.id,
					name: loaded.name,
					version: loaded.version,
					body: loaded.body,
				},
			],
			remainingSkillsText: "",
			selectedSkillIds: [loaded.id],
		}
	} catch (err) {
		console.warn(
			`[company-brain][${traceId ?? "turn"}] Jev skill routing failed, falling back to full index:`,
			err instanceof Error ? err.message : String(err),
		)
		return null
	}
}
