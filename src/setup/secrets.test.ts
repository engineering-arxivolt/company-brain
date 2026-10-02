import { describe, expect, it, vi } from "vitest"
import { hydrateSecrets, providerForModelKey } from "./secrets"

describe("providerForModelKey", () => {
	it("tells providers apart by key prefix", () => {
		expect(providerForModelKey("sk-ant-api03-abc")).toBe("anthropic")
		expect(providerForModelKey("sk-proj-abc")).toBe("openai")
		expect(providerForModelKey("sk-abc")).toBe("openai")
		expect(providerForModelKey("AIzaSyAbc")).toBe("google")
		expect(providerForModelKey("AQ.Ab8RN6J6CLXVj")).toBe("google")
		expect(providerForModelKey("xai-abc")).toBe("xai")
		expect(providerForModelKey("something-else")).toBeNull()
	})
})

function fakeEnv(kvGet: (key: string) => Promise<string | null>) {
	const get = vi.fn(kvGet)
	const env = {
		BRAIN_KV: { get, put: vi.fn(async () => undefined) },
	} as unknown as Env
	return { env, get }
}

describe("hydrateSecrets", () => {
	it("resolves one value per Env rather than one per caller", async () => {
		const { env, get } = fakeEnv(async (key) =>
			key === "deployment:encryption-secret" ? "kv-secret" : null,
		)

		await hydrateSecrets(env)
		const afterFirst = get.mock.calls.length
		await hydrateSecrets(env)

		// The request path and the DO fiber-recovery hook share one hydration,
		// so the second call must not touch KV again.
		expect(afterFirst).toBeGreaterThan(0)
		expect(get.mock.calls.length).toBe(afterFirst)
		expect(env.ENCRYPTION_SECRET).toBe("kv-secret")
	})

	it("never caches a failure, so the next caller retries", async () => {
		let calls = 0
		const { env } = fakeEnv(async (key) => {
			calls += 1
			if (calls === 1) throw new Error("KV unavailable")
			return key === "deployment:encryption-secret" ? "kv-secret" : null
		})

		await expect(hydrateSecrets(env)).rejects.toThrow(/KV unavailable/)
		// A cached rejection would leave env unhydrated forever.
		await expect(hydrateSecrets(env)).resolves.toBeUndefined()
		expect(env.ENCRYPTION_SECRET).toBe("kv-secret")
	})
})
