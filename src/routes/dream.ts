import { ROLE_ADMIN } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import * as z from "zod"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

const BodySchema = z.object({
	apply: z
		.boolean()
		.optional()
		.describe(
			"Delete what the plan says. Still requires DREAM_APPLY=on in the deployment.",
		),
})

/**
 * The dream, on demand.
 *
 * The nightly pass runs itself; this exists so an operator can read the plan
 * before trusting it. A dry run is the default, and `apply` is only half the
 * permission — the deployment also has to have `DREAM_APPLY=on`, so this cannot
 * be used to delete memories in an environment where nobody meant to.
 *
 * The report is the same shape the scheduled run records as a decision, so the
 * turn inspector shows both the same way (trace `dream:<date>`).
 */
export const brainDreamRoutes = new Hono<AppContext>().post(
	"/",
	describeRoute({
		hide: true,
		description: "Run memory consolidation for this org (dry run by default)",
		responses: {
			200: { description: "What the pass scanned, planned and removed" },
			401: { description: "Unauthorized" },
		},
	}),
	roleGate({ minimum: ROLE_ADMIN }),
	validator("json", BodySchema),
	async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		const report = await agent.runDreamNow({
			apply: c.req.valid("json").apply ?? false,
		})
		return c.json({ ok: true, dream: report })
	},
)
