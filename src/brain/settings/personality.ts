import { db, eq, withTransaction } from "@repo/db"
import * as schema from "@repo/db/schema"
import type {
	BrainPersonalityPreset,
	BrainPersonalitySettings,
} from "@repo/db/schema/common"
import { parseBrainPersonalitySettings } from "../slack/personality"

export type PersonalityPatch = {
	preset?: BrainPersonalityPreset | null
}

export type PersonalityUpdateResult = {
	merged: BrainPersonalitySettings | null
}

// Shared by the route and the tool; owns the transaction, not the authz.
export async function updateBrainPersonality(
	env: Env,
	orgId: string,
	patch: PersonalityPatch | null,
): Promise<PersonalityUpdateResult> {
	return withTransaction(db(env), async (tx) => {
		// FOR UPDATE locks nothing on a missing row; insert first so writes serialize
		await tx
			.insert(schema.organizationSettings)
			.values({ orgId })
			.onConflictDoNothing({ target: schema.organizationSettings.orgId })
		const [row] = await tx
			.select({
				brainPersonality: schema.organizationSettings.brainPersonality,
			})
			.from(schema.organizationSettings)
			.where(eq(schema.organizationSettings.orgId, orgId))

		let merged: BrainPersonalitySettings | null = null
		if (patch != null) {
			const current = parseBrainPersonalitySettings(row?.brainPersonality)
			merged = { ...current }
			if (patch.preset !== undefined) {
				if (patch.preset === null) delete merged.preset
				else merged.preset = patch.preset
			}
			if (!Object.keys(merged).length) merged = null
		}

		await tx
			.insert(schema.organizationSettings)
			.values({
				orgId,
				brainPersonality: merged,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: schema.organizationSettings.orgId,
				set: { brainPersonality: merged, updatedAt: new Date() },
			})
		return { merged }
	})
}
