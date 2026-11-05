/**
 * A workspace-level lease around heavy sandbox builds.
 *
 * Two builds starting at once — a campaign pack while a content round renders,
 * for instance — contend for the same container pool, and the platform settles
 * the contention by terminating one session mid-command. The turn sees a
 * SessionTerminatedError and an emptied workspace. The lease gives heavy builds
 * a turn each: the second waits (bounded) for the first to finish, then runs,
 * and the bounded wait means a stuck holder delays the turn rather than hanging
 * it. Best effort by design: KV has no compare-and-set, so a rare double
 * acquisition is possible and is handled by the callers' retry ladder.
 */
export type SandboxLease = {
	/** Idempotent: releasing twice is harmless. */
	release: () => Promise<void>
}

export async function acquireSandboxLease(
	env: Env,
	key: string,
	options: { ttlSec?: number; waitMs?: number; pollMs?: number } = {},
): Promise<SandboxLease> {
	const storageKey = `sandbox:lease:${key}`
	const ttlSec = options.ttlSec ?? 300
	const waitMs = options.waitMs ?? 45_000
	const pollMs = options.pollMs ?? 500
	const kv = env.BRAIN_KV
	const token = crypto.randomUUID()
	const deadline = Date.now() + waitMs
	let released = false
	const release = async () => {
		if (released) return
		released = true
		try {
			if ((await kv.get(storageKey)) === token) await kv.delete(storageKey)
		} catch {
			// A failed release only costs the next builder a wait; the TTL
			// clears it either way.
		}
	}
	for (;;) {
		try {
			const current = await kv.get(storageKey)
			if (!current) {
				await kv.put(storageKey, token, { expirationTtl: ttlSec })
				// Read back: two turns can both arrive at an empty slot.
				if ((await kv.get(storageKey)) === token) {
					return { release }
				}
			}
		} catch (error) {
			// KV trouble must not block a build that would otherwise work.
			console.warn(
				"[sandbox] lease unavailable, building without one:",
				error instanceof Error ? error.message : String(error),
			)
			return { release: async () => {} }
		}
		if (Date.now() >= deadline) {
			// The holder is overrunning; run anyway and let the retry ladder
			// absorb a collision rather than stall the turn further.
			return { release: async () => {} }
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
}