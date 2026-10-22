/**
 * The `founder_brain` tool.
 *
 * The weekly interview is the main way this gets filled, but the operator also
 * drops corrections and stories into Slack between interviews. This tool is how
 * those land in durable context instead of disappearing into a thread.
 */
import {
	addFounderBrainItem,
	ensureFounderBrainDefaults,
	FOUNDER_BRAIN_SECTIONS,
	FOUNDER_SECTION_LABELS,
	FOUNDER_SECTION_PROMPTS,
	founderBrainSummary,
	getFounderBrain,
	isFounderBrainSection,
	removeFounderBrainItem,
	setFounderBrainSection,
	type FounderBrainSection,
} from "../content/founder-brain"
import type { SlackMemoryScope } from "../memory/writeback"
import { logPreview } from "../observability/log-utils"
import type { SlackOrg } from "../slack/workspace"
import type { CompanyBrainAgent } from "./agent"
import type { TurnDeps } from "./deps"
import {
	collectFounderBrainMemory,
	formatFounderMemoryPacket,
} from "./founder-brain-memory"

export type FounderBrainToolArgs = {
	deps: TurnDeps
	agent: CompanyBrainAgent
	org: SlackOrg
	userId: string
	/** The asker's memory scope, so seeding reads the same brain they can see. */
	memoryScope?: SlackMemoryScope
	memoryContainerTags?: string[]
	/** Interactive turns can write; read-only turns can only inspect. */
	allowWrites: boolean
	traceId: string
}

export function createFounderBrainTool(args: FounderBrainToolArgs) {
	const { deps, agent, userId } = args
	return deps.tool({
		description:
			"Read, seed, or update the Founder Brain: durable positioning, ideal customer, problems, offers, proof, voice, stories, opinions, frameworks, client results, what worked, what fell flat, and founder corrections. Use it when the operator shares a story, result, opinion, correction, or positioning that should shape future content; read it before writing in the founder's voice. Use action 'seed' when the operator asks to build or refresh the brain from company memory: it searches the workspace and returns evidence for you to synthesise into sections. For seed, pass the operator's positioning and the topics they named (for example AI, cloud, compliance, SEO, products) as focus; do not reduce it to a generic company description. Seeding merges into a populated brain and must not replace it. Do not use it as a generic company memory: search_company_brain is for facts and history. Writes need an explicit request from the person.",
		inputSchema: deps.z.object({
			action: deps.z
				.enum(["read", "seed", "add", "set", "remove"])
				.describe(
					"read the brain, seed it from company memory, add one item, replace a section, or remove one item.",
				),
			section: deps.z
				.enum(FOUNDER_BRAIN_SECTIONS)
				.optional()
				.describe(
					"Which section to change. Required for add, set, and remove. Sections: " +
						FOUNDER_BRAIN_SECTIONS.map(
							(section) =>
								`${section} (${FOUNDER_SECTION_LABELS[section]}: ${FOUNDER_SECTION_PROMPTS[section]})`,
						).join("; "),
				),
			focus: deps.z
				.string()
				.optional()
				.describe(
					"For action=seed: optional positioning or topics the operator already stated, e.g. 'AI, cloud, and compliance for Kenyan fintechs'. They are added to every memory search.",
				),
			text: deps.z
				.string()
				.optional()
				.describe("One item to add. Required for add."),
			items: deps.z
				.array(deps.z.string())
				.max(12)
				.optional()
				.describe(
					"The full replacement list for set. Empty clears the section.",
				),
			replace: deps.z
				.boolean()
				.optional()
				.describe(
					"For action=set only: set true only when the operator explicitly asks to replace a populated section. Otherwise use add.",
				),
			reference: deps.z
				.string()
				.optional()
				.describe("Item id or text to remove. Required for remove."),
			source: deps.z
				.string()
				.optional()
				.describe(
					"Where this came from, e.g. 'weekly interview 2026-10-22' or a Slack thread.",
				),
		}),
		execute: async ({
			action,
			section,
			focus,
			text,
			items,
			replace,
			reference,
			source,
		}) => {
			if (action === "read") {
				ensureFounderBrainDefaults(agent, userId)
				const brain = getFounderBrain(agent, userId)
				const filled = FOUNDER_BRAIN_SECTIONS.filter(
					(section) => brain.sections[section].length > 0,
				)
				console.log(
					`[company-brain][${args.traceId}] founder_brain read sections=${filled.length} items=${filled.reduce((n, s) => n + brain.sections[s].length, 0)}`,
				)
				return {
					ok: true,
					brain: founderBrainSummary(brain),
					empty: filled.length === 0,
					hint:
						filled.length === 0
							? "The Founder Brain is empty. Add positioning and ICP first; stories, proof, and opinions can follow."
							: "Use add for one new item, set with replace=true only when the operator explicitly asked to replace a whole section, and remove to delete one.",
				}
			}
			if (action === "seed") {
				const packet = await collectFounderBrainMemory({
					agent,
					org: args.org,
					userId,
					scope: args.memoryScope,
					containerTags: args.memoryContainerTags,
					traceId: args.traceId,
					focus,
				})
				const formatted = formatFounderMemoryPacket(packet)
				const empty = packet.returned === 0
				const existing = getFounderBrain(agent, userId)
				const existingCounts = Object.fromEntries(
					FOUNDER_BRAIN_SECTIONS.map((section) => [
						section,
						existing.sections[section].length,
					]),
				) as Record<FounderBrainSection, number>
				const populatedSections = FOUNDER_BRAIN_SECTIONS.filter(
					(section) => existingCounts[section] > 0,
				)
				const existingTotal = populatedSections.reduce(
					(total, section) => total + existingCounts[section],
					0,
				)
				console.log(
					`[company-brain][${args.traceId}] founder_brain seed groups=${packet.groups.length} returned=${packet.returned} empty=${empty} existing=${existingTotal}`,
				)
				return {
					ok: true,
					action,
					empty,
					searched: packet.searched,
					returned: packet.returned,
					existing: existingCounts,
					existingTotal,
					populatedSections,
					packet: formatted,
					instructions: empty
						? existingTotal > 0
							? `The company memory returned nothing usable. The Founder Brain already has ${existingTotal} items across ${populatedSections.length} sections; leave it alone. Do not invent or replace sections. Ask the operator for the missing context directly if they want to add to it.`
							: "The company memory returned nothing usable. Do not invent sections. Ask the operator for a short positioning statement, ICP, and one proof point directly, then save those with action=set. Ask them to add the SEO/company context in their own words if it matters."
						: `Use only the packet above. For each Founder Brain section that has support, write 1–3 short, specific items in the founder's own language. Prefer concrete facts, names, numbers, and opinions over summaries. Do not save a section that the packet does not support. The brain already has ${existingTotal} items across ${populatedSections.length} sections. For a populated section, use action=add for genuinely new items; do not use action=set unless the operator explicitly asked you to replace that section, and pass replace=true only in that case. Then tell the operator which sections were added to and which need a direct answer. If the packet is thin or off-topic, say so and leave the existing brain alone. Never treat another person's words as the founder's opinion unless the memory says the founder said them.`,
				}
			}
			if (!args.allowWrites) {
				return {
					ok: false,
					error:
						"This turn is read-only, so I can't change the Founder Brain here. Ask me in a normal conversation.",
				}
			}
			if (!section || !isFounderBrainSection(section)) {
				return { ok: false, error: "Choose a section to change." }
			}
			if (action === "add") {
				if (!text?.trim())
					return { ok: false, error: "Give me the item to add." }
				const result = addFounderBrainItem(agent, {
					userId,
					section,
					text,
					source,
				})
				if (!result.ok) return result
				console.log(
					`[company-brain][${args.traceId}] founder_brain add section=${section} added=${result.added} preview="${logPreview(text, 160)}"`,
				)
				return {
					ok: true,
					action,
					section,
					label: FOUNDER_SECTION_LABELS[section],
					added: result.added,
					item: result.item,
					count: result.brain.sections[section].length,
					note: result.added
						? "Saved. Future content rounds will use it as context."
						: "That item is already in this section; I left the existing one alone.",
				}
			}
			if (action === "set") {
				if (!items)
					return {
						ok: false,
						error: "Give me the full replacement list for this section.",
					}
				const current = getFounderBrain(agent, userId).sections[section]
				if (current.length > 0 && !replace) {
					return {
						ok: false,
						error: `"${FOUNDER_SECTION_LABELS[section]}" already has ${current.length} item${current.length === 1 ? "" : "s"}. Use action=add for genuinely new items. If the operator explicitly asked to replace the whole section, call set again with replace=true.`,
					}
				}
				const result = setFounderBrainSection(agent, {
					userId,
					section,
					items,
					source,
				})
				if (!result.ok) return result
				console.log(
					`[company-brain][${args.traceId}] founder_brain set section=${section} count=${result.brain.sections[section].length}`,
				)
				return {
					ok: true,
					action,
					section,
					label: FOUNDER_SECTION_LABELS[section],
					count: result.brain.sections[section].length,
					note: "Section replaced. Future content rounds will use it as context.",
				}
			}
			if (!reference?.trim())
				return { ok: false, error: "Give me the item id or text to remove." }
			const result = removeFounderBrainItem(agent, {
				userId,
				section,
				reference,
			})
			if (!result.ok) return result
			console.log(
				`[company-brain][${args.traceId}] founder_brain remove section=${section} id=${result.item?.id ?? "-"}`,
			)
			return {
				ok: true,
				action,
				section,
				label: FOUNDER_SECTION_LABELS[section],
				removed: result.item,
				count: result.brain.sections[section].length,
			}
		},
	})
}
