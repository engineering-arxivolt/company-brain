export const LAZY_TOOL_FAMILIES = ["sandbox", "scheduler"] as const

export type LazyToolFamily = (typeof LAZY_TOOL_FAMILIES)[number]

export type LazyToolUnlockResult = {
	family: LazyToolFamily
	status: "enabled" | "already_enabled" | "unavailable"
	tools: string[]
}

export type LazyToolState = {
	unlock: (families: LazyToolFamily[]) => LazyToolUnlockResult[]
	activeToolNames: (allToolNames: string[]) => string[]
	enabledFamilies: () => LazyToolFamily[]
	availableFamilies: () => LazyToolFamily[]
	isEnabled: (family: LazyToolFamily) => boolean
}

/**
 * The tool families a playbook depends on, read from the tools it names.
 *
 * A skill body that says "compile it with latexmk, then share the PDF with
 * sandbox_get_artifact" is unusable while the sandbox family is still hidden:
 * the model is instructed to call tools that are not in its schema, and a
 * weaker model answers with prose instead of doing the work. Naming a family's
 * tools is the clearest intent a playbook can express, so it is also the signal
 * that unlocks it.
 */
export function toolFamiliesForSkill(body: string): LazyToolFamily[] {
	const families: LazyToolFamily[] = []
	// Any sandbox_* tool name (`sandbox_run`, `sandbox_get_artifact`, ...).
	if (/\bsandbox_[a-z_]+\b/.test(body)) families.push("sandbox")
	return families
}

/**
 * Keeps optional typed tools server-side until the model explicitly asks for a
 * family. AI SDK activeTools then exposes the unlocked schemas on the next step.
 */
export function createLazyToolState(
	definitions: Partial<Record<LazyToolFamily, string[]>>,
	initiallyEnabled: Iterable<LazyToolFamily> = [],
): LazyToolState {
	const toolsByFamily = new Map<LazyToolFamily, string[]>()
	for (const family of LAZY_TOOL_FAMILIES) {
		toolsByFamily.set(family, [...new Set(definitions[family] ?? [])])
	}
	const optionalToolNames = new Set([...toolsByFamily.values()].flat())
	const enabled = new Set<LazyToolFamily>(
		[...initiallyEnabled].filter(
			(family) => (toolsByFamily.get(family)?.length ?? 0) > 0,
		),
	)

	return {
		unlock(families) {
			return [...new Set(families)].map((family) => {
				const names = toolsByFamily.get(family) ?? []
				if (!names.length) {
					return { family, status: "unavailable" as const, tools: [] }
				}
				if (enabled.has(family)) {
					return {
						family,
						status: "already_enabled" as const,
						tools: names,
					}
				}
				enabled.add(family)
				return { family, status: "enabled" as const, tools: names }
			})
		},
		activeToolNames(allToolNames) {
			const activeOptionalNames = new Set(
				[...enabled].flatMap((family) => toolsByFamily.get(family) ?? []),
			)
			return allToolNames.filter(
				(name) => !optionalToolNames.has(name) || activeOptionalNames.has(name),
			)
		},
		enabledFamilies: () => [...enabled],
		availableFamilies: () =>
			LAZY_TOOL_FAMILIES.filter(
				(family) => (toolsByFamily.get(family)?.length ?? 0) > 0,
			),
		isEnabled: (family) => enabled.has(family),
	}
}
