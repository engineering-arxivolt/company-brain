import { describe, expect, it } from "vitest"
import { createBrainBrowserAgentTool, hasBrowserService } from "./browse"

const URL = "https://browser.example.com"
const TOKEN = "service-token"

describe("hasBrowserService", () => {
	it("is false unless both URL and token are set", () => {
		expect(hasBrowserService({} as Env)).toBe(false)
		expect(hasBrowserService({ BROWSER_SERVICE_URL: URL } as Env)).toBe(false)
		expect(hasBrowserService({ BROWSER_SERVICE_TOKEN: TOKEN } as Env)).toBe(false)
		expect(
			hasBrowserService({ BROWSER_SERVICE_URL: URL, BROWSER_SERVICE_TOKEN: TOKEN } as Env),
		).toBe(true)
	})
})

describe("createBrainBrowserAgentTool", () => {
	it("returns null when unconfigured so the tool stays hidden", () => {
		expect(createBrainBrowserAgentTool({} as Env)).toBeNull()
		expect(
			createBrainBrowserAgentTool({ BROWSER_SERVICE_URL: URL } as Env),
		).toBeNull()
	})

	it("builds a browse_website tool when configured", () => {
		const tool = createBrainBrowserAgentTool(
			{ BROWSER_SERVICE_URL: `${URL}/`, BROWSER_SERVICE_TOKEN: TOKEN } as Env,
			"trace-1",
		)
		expect(tool).not.toBeNull()
	})

	it("sends Bearer auth and surfaces the clipped result with sources", async () => {
		const tool = createBrainBrowserAgentTool(
			{ BROWSER_SERVICE_URL: URL, BROWSER_SERVICE_TOKEN: TOKEN } as Env,
			"trace-1",
		)
		if (!tool?.execute) throw new Error("expected an executable tool")

		let seenUrl = ""
		let seenAuth = ""
		const realFetch = globalThis.fetch
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			seenUrl = String(input)
			seenAuth = (init?.headers as Record<string, string>).authorization
			return new Response(
				JSON.stringify({ ok: true, result: "price is $9", steps: 3, ms: 100 }),
				{ status: 200 },
			)
		}) as typeof fetch
		try {
			const out = (await tool.execute(
				{ task: "List plan prices", start_url: "https://acme.test/pricing" },
				{},
			)) as { output: string; sources: { source: string }[] }
			expect(seenUrl).toBe(`${URL}/run`)
			expect(seenAuth).toBe(`Bearer ${TOKEN}`)
			expect(out.output).toContain("price is $9")
			expect(out.sources).toEqual([
				{ source: "https://acme.test/pricing", title: "https://acme.test/pricing" },
			])
		} finally {
			globalThis.fetch = realFetch
		}
	})

	it("tells the turn the browser is busy on 429 instead of throwing", async () => {
		const tool = createBrainBrowserAgentTool(
			{ BROWSER_SERVICE_URL: URL, BROWSER_SERVICE_TOKEN: TOKEN } as Env,
		)
		if (!tool?.execute) throw new Error("expected an executable tool")

		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => new Response("busy", {
			status: 429,
		})) as typeof fetch
		try {
			const out = await tool.execute(
				{ task: "List plan prices", start_url: "https://acme.test/pricing" },
				{},
			)
			expect(String(out)).toContain("busy")
		} finally {
			globalThis.fetch = realFetch
		}
	})

	it("tells the turn a run timed out on sidecar 504", async () => {
		const tool = createBrainBrowserAgentTool(
			{ BROWSER_SERVICE_URL: URL, BROWSER_SERVICE_TOKEN: TOKEN } as Env,
		)
		if (!tool?.execute) throw new Error("expected an executable tool")

		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => new Response("timed out", {
			status: 504,
		})) as typeof fetch
		try {
			const out = await tool.execute(
				{ task: "List plan prices", start_url: "https://acme.test/pricing" },
				{},
			)
			expect(String(out)).toContain("too long")
		} finally {
			globalThis.fetch = realFetch
		}
	})

	it("clips a long transcript to the turn budget", async () => {
		const tool = createBrainBrowserAgentTool(
			{ BROWSER_SERVICE_URL: URL, BROWSER_SERVICE_TOKEN: TOKEN } as Env,
		)
		if (!tool?.execute) throw new Error("expected an executable tool")

		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => new Response(
			JSON.stringify({ ok: true, result: `x${"y".repeat(12_500)}`, steps: 9, ms: 1 }),
			{ status: 200 },
		)) as typeof fetch
		try {
			const out = (await tool.execute(
				{ task: "List plan prices", start_url: "https://acme.test/pricing" },
				{},
			)) as { output: string }
			expect(out.output).toContain("truncated")
		} finally {
			globalThis.fetch = realFetch
		}
	})
})
