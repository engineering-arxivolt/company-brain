import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configurePostHog, flushTelemetry } from "@/lib/posthog"
import { publishDeepDive } from "./arxivolt-engine"

type Captured = { event: string; distinct_id: string; properties: Record<string, unknown> }

const events: Captured[] = []

function json(body: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response
}

const MARKDOWN = `# KRA nil returns in Kenya\n\n${"This paragraph explains the filing obligation and the evidence to keep. ".repeat(40)}\n\n## Deadline\n\nSee [penalties](/kra-penalties-kenya).\n`

beforeEach(() => {
	events.length = 0
	configurePostHog({ POSTHOG_API_KEY: "phc_test_key", POSTHOG_HOST: "https://ph.test" })
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		if (url.startsWith("https://ph.test/batch")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as { batch?: Captured[] }
			for (const event of body.batch ?? []) events.push(event)
			return json({ status: 1 })
		}
		if (url.endsWith("/admin/articles")) {
			return json({ slug: "kra-nil-return-kenya", url: "https://www.arxivolt.com/kra-nil-return-kenya", status: "live", word_count: 1300, created: true, warnings: [] })
		}
		return json(`<html><body><h1>KRA nil returns in Kenya</h1><p>Explains</p></body></html>`, 200)
	})
})

afterEach(async () => {
	await flushTelemetry().catch(() => {})
	configurePostHog({})
	vi.unstubAllGlobals()
	events.length = 0
})

describe("publishDeepDive analytics funnel", () => {
	it("emits drafted, published and verified with the same slug", async () => {
		const result = await publishDeepDive(
			{ ARXIVOLT_ENGINE_URL: "https://engine.test", ARXIVOLT_ENGINE_ADMIN_SECRET: "secret" },
			{
				title: "KRA nil returns in Kenya",
				markdown: MARKDOWN,
				cluster: "kra-obligations",
				keyword: "kra nil return",
				orgId: "org_123",
			},
		)
		expect(result.ok).toBe(true)
		await flushTelemetry()

		const names = events.map((e) => e.event)
		expect(names).toContain("seo_article_drafted")
		expect(names).toContain("seo_article_published")
		expect(names).toContain("seo_article_verified")

		const published = events.find((e) => e.event === "seo_article_published")
		expect(published?.distinct_id).toBe("org_123")
		expect(published?.properties.slug).toBe("kra-nil-return-kenya")
		expect(published?.properties.keyword).toBe("kra nil return")
		expect(published?.properties.cluster).toBe("kra-obligations")

		const verified = events.find((e) => e.event === "seo_article_verified")
		expect(verified?.properties.verified).toBe(true)
		expect(verified?.properties.slug).toBe(published?.properties.slug)
	})

	it("still records the draft when the engine rejects the publish", async () => {
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.startsWith("https://ph.test/batch")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as { batch?: Captured[] }
				for (const event of body.batch ?? []) events.push(event)
				return json({ status: 1 })
			}
			return json({ error: "cannibalisation", conflict: "kra-nil-return-kenya" }, 409)
		})
		const result = await publishDeepDive(
			{ ARXIVOLT_ENGINE_URL: "https://engine.test", ARXIVOLT_ENGINE_ADMIN_SECRET: "secret" },
			{ title: "KRA nil returns in Kenya", markdown: MARKDOWN, cluster: "kra-obligations", orgId: "org_123" },
		)
		expect(result.ok).toBe(false)
		await flushTelemetry()
		const names = events.map((e) => e.event)
		expect(names).toContain("seo_article_drafted")
		expect(names).not.toContain("seo_article_published")
	})
})
