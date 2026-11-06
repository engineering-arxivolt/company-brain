import { describe, expect, it, vi } from "vitest"
import { fetchGscQueries, parseGscRows, summariseByPage, upsertGscRows } from "./gsc"

describe("parseGscRows", () => {
	it("maps keys to query and page", () => {
		const rows = parseGscRows({
			rows: [{ keys: ["kra nil return", "https://www.arxivolt.com/kra-nil-return-kenya"], clicks: 12, impressions: 900, ctr: 0.013, position: 9.4 }],
		})
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			query: "kra nil return",
			page: "https://www.arxivolt.com/kra-nil-return-kenya",
			clicks: 12,
			impressions: 900,
			position: 9.4,
		})
	})

	it("treats a property with no data as empty, not broken", () => {
		expect(parseGscRows({})).toEqual([])
		expect(parseGscRows(null)).toEqual([])
		expect(parseGscRows({ rows: [] })).toEqual([])
	})

	it("survives numbers serialised as strings", () => {
		const [row] = parseGscRows({ rows: [{ keys: ["q", "p"], clicks: "3", impressions: "40", ctr: "0.075", position: "6.2" }] })
		expect(row?.clicks).toBe(3)
		expect(row?.impressions).toBe(40)
	})
})

describe("fetchGscQueries", () => {
	it("fails closed with the scope it needs when unconfigured", async () => {
		const res = await fetchGscQueries({ siteUrl: "https://www.arxivolt.com/", startDate: "2026-01-01", endDate: "2026-01-28" })
		expect(res.ok).toBe(false)
		if (!res.ok) expect(res.error).toContain("webmasters.readonly")
	})

	it("posts the query and page dimensions and returns rows", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(JSON.stringify({ rows: [{ keys: ["cnva", "https://www.arxivolt.com/cnva"], clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		) as unknown as typeof fetch
		const res = await fetchGscQueries({
			siteUrl: "https://www.arxivolt.com/",
			accessToken: "tok",
			startDate: "2026-01-01",
			endDate: "2026-01-28",
			fetchImpl,
		})
		expect(res.ok).toBe(true)
		if (res.ok) {
			expect(res.rows).toHaveLength(1)
			expect(res.rows[0]?.date).toBe("2026-01-28")
		}
		const call = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
		expect(call?.[0]).toContain("searchAnalytics/query")
		expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ dimensions: ["query", "page"], startDate: "2026-01-01" })
	})

	it("reports the Google error body instead of swallowing it", async () => {
		const fetchImpl = (async () => new Response("insufficientPermissions", { status: 403 })) as unknown as typeof fetch
		const res = await fetchGscQueries({
			siteUrl: "https://www.arxivolt.com/",
			accessToken: "tok",
			startDate: "2026-01-01",
			endDate: "2026-01-28",
			fetchImpl,
		})
		expect(res.ok).toBe(false)
		if (!res.ok) {
			expect(res.error).toContain("403")
			expect(res.error).toContain("insufficientPermissions")
		}
	})

	it("turns a thrown request into a result", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down")
		}) as unknown as typeof fetch
		const res = await fetchGscQueries({
			siteUrl: "https://www.arxivolt.com/",
			accessToken: "tok",
			startDate: "2026-01-01",
			endDate: "2026-01-28",
			fetchImpl,
		})
		expect(res.ok).toBe(false)
		if (!res.ok) expect(res.error).toContain("network down")
	})
})

describe("summariseByPage", () => {
	it("aggregates queries per page with an impression-weighted position", () => {
		const pages = summariseByPage([
			{ date: "d", query: "a", page: "https://www.arxivolt.com/x", clicks: 10, impressions: 900, ctr: 0.01, position: 12 },
			{ date: "d", query: "b", page: "https://www.arxivolt.com/x", clicks: 1, impressions: 100, ctr: 0.01, position: 2 },
			{ date: "d", query: "c", page: "https://www.arxivolt.com/y", clicks: 0, impressions: 5, ctr: 0, position: 40 },
		])
		const x = pages.find((p) => p.slug === "x")
		expect(x?.clicks).toBe(11)
		expect(x?.impressions).toBe(1_000)
		// (12*900 + 2*100) / 1000 = 11 — the 2-impression-style outlier does not win.
		expect(x?.position).toBeCloseTo(11, 5)
		expect(pages.find((p) => p.slug === "y")?.position).toBe(40)
	})

	it("skips rows with no page and normalises the root URL", () => {
		const pages = summariseByPage([{ date: "d", query: "a", page: "", clicks: 1, impressions: 1, ctr: 1, position: 1 }])
		expect(pages).toEqual([])
		expect(summariseByPage([{ date: "d", query: "a", page: "https://www.arxivolt.com/", clicks: 1, impressions: 1, ctr: 1, position: 1 }])[0]?.slug).toBe("/")
	})
})

describe("upsertGscRows", () => {
	function fakeAgent() {
		const calls: Array<{ text: string; values: unknown[] }> = []
		const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
			calls.push({ text: strings.join("?"), values })
			return {}
		}
		return { agent: { sql }, calls }
	}

	it("creates the table once and writes every usable row", () => {
		const { agent, calls } = fakeAgent()
		const rows = [
			{ date: "2026-01-28", query: "a", page: "p", clicks: 1, impressions: 2, ctr: 0.5, position: 3 },
			{ date: "2026-01-28", query: "b", page: "p", clicks: 4, impressions: 5, ctr: 0.8, position: 6 },
		]
		expect(upsertGscRows(agent, rows)).toBe(2)
		expect(upsertGscRows(agent, rows)).toBe(2)
		const creates = calls.filter((c) => c.text.includes("CREATE TABLE IF NOT EXISTS seo_gsc_query"))
		expect(creates).toHaveLength(1)
		expect(calls.filter((c) => c.text.includes("INSERT OR REPLACE"))).toHaveLength(4)
	})

	it("drops rows with neither query nor page", () => {
		const { agent } = fakeAgent()
		expect(upsertGscRows(agent, [{ date: "d", query: "", page: "", clicks: 0, impressions: 0, ctr: 0, position: 0 }])).toBe(0)
	})
})
