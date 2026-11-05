import type { RuntimeSkill } from "../store"
import { CAREER_OPS_FIT_SKILL } from "./career-ops-fit"
import { DOCUMENT_DELIVERY_SKILL } from "./document-delivery"
import { SUPERMEMORY_DOCS_SKILL } from "./supermemory-docs"

export const SYSTEM_SKILLS: readonly RuntimeSkill[] = [
  SUPERMEMORY_DOCS_SKILL,
  CAREER_OPS_FIT_SKILL,
  DOCUMENT_DELIVERY_SKILL,
]

const SYSTEM_SKILL_IDS = new Set(SYSTEM_SKILLS.map((skill) => skill.id))

export function isSystemSkillId(id: string): boolean {
	return SYSTEM_SKILL_IDS.has(id)
}
