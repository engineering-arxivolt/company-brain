import { ROLE_ADMIN } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import * as z from "zod"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

const QuerySchema = z.object({
	traceId: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe("Replay one scenario. Omit for this org's most recent decisions."),
	limit: z.coerce.number().int().min(1).max(200).optional(),
})

// Admin-only: this is the audit surface, and it can carry internal rationale.
export const brainDecisionsRoutes = new Hono<AppContext>()
	.get(
		"/",
		describeRoute({
			hide: true,
			description: "Durable decision log for this org's Company Brain",
			responses: {
				200: { description: "Decisions, oldest first" },
				401: { description: "Unauthorized" },
			},
		}),
		roleGate({ minimum: ROLE_ADMIN }),
		validator("query", QuerySchema),
		async (c) => {
			const org = c.get("org")
			if (!org) return c.json({ error: "unauthorized" }, 401)
			const query = c.req.valid("query")
			const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
			const decisions = await agent.getDecisions({
				orgId: org.id,
				traceId: query.traceId,
				limit: query.limit,
			})
			return c.json({ decisions })
		},
	)
