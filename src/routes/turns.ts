import { ROLE_ADMIN } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import * as z from "zod"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

const ParamsSchema = z.object({
	traceId: z.string().min(1).max(200).describe("The brain trace id of one turn"),
})

/**
 * One turn, explained — the read behind the turn inspector.
 *
 * Admin-only for the same reason `/decisions` is: it carries the model's
 * reasoning, the playbook JEV chose and every tool effect, which is audit
 * material rather than something to hand to every member.
 *
 * A trace with nothing recorded returns an empty inspection with 200, not 404:
 * turns that predate the decision log are a legitimate answer, and the caller
 * cannot tell them apart from a typo anyway.
 */
export const brainTurnRoutes = new Hono<AppContext>().get(
	"/:traceId",
	describeRoute({
		hide: true,
		description: "Everything one turn decided: route, model, skill, tool effects",
		responses: {
			200: { description: "The inspection, with an empty summary when unknown" },
			401: { description: "Unauthorized" },
		},
	}),
	roleGate({ minimum: ROLE_ADMIN }),
	validator("param", ParamsSchema),
	async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const { traceId } = c.req.valid("param")
		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		return c.json(await agent.inspectTurn({ orgId: org.id, traceId }))
	},
)
