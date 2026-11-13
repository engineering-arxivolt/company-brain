import { ROLE_ADMIN } from "@repo/lib/permissions"
import { getAgentByName } from "agents"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { roleGate } from "@/lib/auth/role-gate"
import type { AppContext } from "@/types"

/**
 * Is anything stuck, and what are we spending?
 *
 * A read-only operational audit: paused turns and long jobs by status, live and
 * leaked sandbox sessions, decisions recorded by kind, the last dream, queued
 * render jobs, held build leases, and spend for the day and the week.
 *
 * It exists because the brain's real state is in Durable Object SQL, which no
 * command-line tool can read — so "check production" used to mean reading code.
 * Admin-only, like the other audit surfaces.
 */
export const brainAuditRoutes = new Hono<AppContext>().get(
	"/",
	describeRoute({
		hide: true,
		description: "Operational audit: stuck work, leases, sessions, spend",
		responses: {
			200: { description: "Counts, last dream and cost totals" },
			401: { description: "Unauthorized" },
		},
	}),
	roleGate({ minimum: ROLE_ADMIN }),
	async (c) => {
		const org = c.get("org")
		if (!org) return c.json({ error: "unauthorized" }, 401)
		const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id)
		return c.json(await agent.auditBrain())
	},
)
