import type { CompanyBrainAgent } from "../turn/agent"
import { DREAM_CALLBACK, dreamDelaySeconds } from "./dream"

/**
 * When the next dream is due, for this org.
 *
 * The Durable Object already wakes itself with alarms, so the nightly pass is
 * one `schedule()` away — no worker-level cron and no org enumeration. The row
 * exists to make that idempotent: `onStart` runs on every wake, and only one of
 * those should arm the alarm.
 */
export function ensureDreamScheduleTable(agent: CompanyBrainAgent): void {
	agent.sql`
		CREATE TABLE IF NOT EXISTS brain_dream_schedule (
			org_id TEXT PRIMARY KEY,
			next_at INTEGER NOT NULL
		)
	`
}

function nextDueAt(agent: CompanyBrainAgent): number {
	const [row] = agent.sql<{ next_at: number }>`
		SELECT next_at FROM brain_dream_schedule WHERE org_id = ${agent.name}
	`
	return row?.next_at ?? 0
}

/**
 * Arm the next nightly run, unless one is already armed.
 *
 * Returns whether it scheduled, which is what makes it safe to call from
 * `onStart` on every single wake.
 */
export async function ensureDreamScheduled(
	agent: CompanyBrainAgent,
	options: { force?: boolean } = {},
): Promise<boolean> {
	const now = Date.now()
	if (!options.force && nextDueAt(agent) > now) return false
	const delaySeconds = dreamDelaySeconds(new Date(now))
	await agent.schedule(delaySeconds, DREAM_CALLBACK, {})
	agent.sql`
		INSERT INTO brain_dream_schedule (org_id, next_at)
		VALUES (${agent.name}, ${now + delaySeconds * 1000})
		ON CONFLICT(org_id) DO UPDATE SET next_at = excluded.next_at
	`
	return true
}
