import { db, eq } from "@repo/db"
import * as schema from "@repo/db/schema"
import { ROLE_ADMIN } from "@repo/lib/permissions"
import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import * as z from "zod"
import { updateBrainPersonality } from "@/lib/brain/settings/personality"
import { updateBrainProactivity } from "@/lib/brain/settings/proactivity"
import { roleGate } from "@/lib/auth/role-gate"
import {
	BRAIN_PERSONALITY_PRESETS,
	DEFAULT_BRAIN_PERSONALITY,
	parseBrainPersonalitySettings,
} from "@/lib/brain/slack/personality"
import {
	BRAIN_CHANNEL_PROACTIVITY,
	BRAIN_PROACTIVITY_DEFAULTS,
	DEFAULT_BRAIN_PROACTIVITY,
	parseBrainProactivity,
} from "@/lib/brain/slack/proactivity"
import type { AppContext } from "@/types"

const SlackChannelIdSchema = z.string().regex(/^[CDG][A-Z0-9]{4,30}$/)

const ProactivityPatchSchema = z.object({
	default: z.enum(BRAIN_PROACTIVITY_DEFAULTS).nullish(),
	// null value deletes that channel's override; channels: null clears them all.
	channels: z
		.record(SlackChannelIdSchema, z.enum(BRAIN_CHANNEL_PROACTIVITY).nullable())
		.nullish(),
})

const PersonalityPatchSchema = z.object({
	// null clears the preset back to the default.
	preset: z.enum(BRAIN_PERSONALITY_PRESETS).nullish(),
})

const BrainSettingsSchema = z.object({
	proactivity: ProactivityPatchSchema.nullish(),
	personality: PersonalityPatchSchema.nullish(),
})

function proactivityView(raw: unknown) {
	const settings = parseBrainProactivity(raw)
	return {
		default: settings.default ?? DEFAULT_BRAIN_PROACTIVITY,
		channels: settings.channels ?? {},
	}
}

function personalityView(raw: unknown) {
	return {
		preset: parseBrainPersonalitySettings(raw).preset ?? DEFAULT_BRAIN_PERSONALITY,
	}
}

function settingsResponse(raw: {
	brainProactivity?: unknown
	brainPersonality?: unknown
}) {
	return {
		proactivity: proactivityView(raw.brainProactivity),
		personality: personalityView(raw.brainPersonality),
		choices: {
			proactivityDefault: BRAIN_PROACTIVITY_DEFAULTS,
			channelProactivity: BRAIN_CHANNEL_PROACTIVITY,
			personalityPreset: BRAIN_PERSONALITY_PRESETS,
		},
	}
}

// Org-wide Company Brain behavior settings, stored on organization_settings.
export const brainSettingsRoutes = new Hono<AppContext>()
	.get("/", async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const row = await db(c.env).query.organizationSettings.findFirst({
			where: eq(schema.organizationSettings.orgId, org.id),
			columns: { brainProactivity: true, brainPersonality: true },
		})
		return c.json(settingsResponse(row ?? {}))
	})
	.patch(
		"/",
		describeRoute({
			// Company Brain is not part of the public API surface.
			hide: true,
			description: "Update org-wide Company Brain behavior settings",
			responses: {
				200: { description: "Resolved settings after the update" },
				401: { description: "Unauthorized" },
				422: { description: "Too many channel overrides" },
			},
		}),
		roleGate({ minimum: ROLE_ADMIN }),
		validator("json", BrainSettingsSchema),
		async (c) => {
			const org = c.get("org")
			if (!org) return c.json({ error: "unauthorized" }, 401)
			const patch = c.req.valid("json")
			if (patch.proactivity !== undefined) {
				const result = await updateBrainProactivity(
					c.env,
					org.id,
					patch.proactivity ?? null,
				)
				if ("error" in result) return c.json({ error: result.error }, 422)
			}
			if (patch.personality !== undefined) {
				await updateBrainPersonality(c.env, org.id, patch.personality ?? null)
			}
			// Re-read so a partial patch still returns the full resolved state.
			const row = await db(c.env).query.organizationSettings.findFirst({
				where: eq(schema.organizationSettings.orgId, org.id),
				columns: { brainProactivity: true, brainPersonality: true },
			})
			return c.json(settingsResponse(row ?? {}))
		},
	)
