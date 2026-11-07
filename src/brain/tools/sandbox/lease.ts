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

/** An exclusive image generation lease ensures only one flow‑mcp image/
 * clip generation runs at a time per workspace. This prevents concurrent
 * generation attempts from contending for the same flow‑mcp VPS session
 * and overwhelming the account's credit budget.
 */
export type ImageLease = {
	/** Idempotent: releasing twice is harmless. */
	release: () => Promise<void>
}

export async function acquireImageLease(
	env: Env,
	key: string,
	options: { ttlSec?: number; waitMs?: number; pollMs?: number } = {},
): Promise<ImageLease> {
	const storageKey = `image:lease:${key}`
	const ttlSec = options.ttlSec ?? 300
	const waitMs = options.waitMs ?? 60_000
	const pollMs = options.pollMs ?? 1_000
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
				if ((await kv.get(storageKey)) === token) {
					return { release }
				}
			}
		} catch (error) {
			console.warn(
				"[image] lease unavailable, proceeding without one:",
				error instanceof Error ? error.message : String(error),
			)
			return { release: async () => {} }
		}
		if (Date.now() >= deadline) {
			// The holder is overrunning; run anyway and let the caller decide.
			return { release: async () => {} }
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
}

/** True when another image generation is in progress (based on the KV lease). */
export async function isImageGenerationInProgress(env: Env, key: string): Promise<boolean> {
	return !!(await env.BRAIN_KV.get(`image:lease:${key}`)) as boolean
}

/** Increment the in‑progress image generation counter for the given key. */
export async function incrementImageGenerationCount(env: Env, key: string): Promise<void> {
	const countKey = `image:count:${key}`
	try {
		const current = (await env.BRAIN_KV.get(countKey)) as string | null
		const next = (current ? Number(current) : 0) + 1
		await env.BRAIN_KV.put(countKey, String(next), { expirationTtl: 60 })
		console.log(`[image] incremented count to ${next} for key ${key}`)
	} catch {
		// If KV fails, we just keep going — the gate below will still work.
	}
}

/** Decrement the in‑progress image generation counter for the given key. */
export async function decrementImageGenerationCount(env: Env, key: string): Promise<void> {
	const countKey = `image:count:${key}`
	try {
		const current = (await env.BRAIN_KV.get(countKey)) as string | null
		if (current) {
			const next = Math.max(0, Number(current) - 1)
			if (next === 0) {
				await env.BRAIN_KV.delete(countKey)
				console.log(`[image] decremented count to 0, releasing lease for key ${key}`)
			} else {
				await env.BRAIN_KV.put(countKey, String(next), { expirationTtl: 60 })
				console.log(`[image] decremented count to ${next} for key ${key}`)
			}
		}
	} catch {
		// Silently ignore errors on decrement.
	}
}

/** Wait until no image generation is in progress, then acquire the lease.
 * Returns { inProgress: true } if the timeout is exceeded.
 */
export async function waitForImageLease(
	env: Env,
	key: string,
	options: { waitMs?: number; pollMs?: number } = {},
): Promise<{ inProgress: boolean; release?: () => Promise<void> }> {
	const waitMs = options.waitMs ?? 60_000
	const pollMs = options.pollMs ?? 1_000
	const deadline = Date.now() + waitMs
	for (;;) {
		const hasLease = await isImageGenerationInProgress(env, key)
		if (!hasLease) {
			await incrementImageGenerationCount(env, key)
			return { inProgress: false, release: async () => {} }
		}
		if (Date.now() >= deadline) {
			return { inProgress: true }
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
}