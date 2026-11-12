import { ROLE_ADMIN } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

/**
 * What the team thought of the brain's answers, per route, model and playbook.
 *
 * The votes are reactions in Slack; the attribution comes from joining them to
 * the decision log on `trace_id`. Read-only, and admin-only for the same reason
 * the inspector is: it exposes which model and playbook keep losing.
 *
 * The playbook half of this is not just a report — the skill resolver consults
 * the same scores and stops preloading a playbook that is clearly failing.
 */
export const brainQualityRoutes = new Hono<AppContext>().get(
	"/",
	describeRoute({
		hide: true,
		description: "Reaction scores per route, model and playbook (last 30 days)",
		responses: {
			200: { description: "Scores with sample counts" },
			401: { description: "Unauthorized" },
		},
	}),
		roleGate({ minimum: ROLE_ADMIN }),
		async (c) => {
			const org = c.get("org")
			if (!org) return c.json({ error: "unauthorized" }, 401)
			const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
			return c.json(await agent.answerQuality())
		},
)
