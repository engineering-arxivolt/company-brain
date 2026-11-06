import { describe, expect, it } from "vitest"
import { buildGscCallArgs, pickSearchConsoleEndpoint } from "./gsc-treg"

describe("pickSearchConsoleEndpoint", () => {
	it("picks Google's own Search Console endpoint and ignores prose lookalikes", () => {
		const payload = {
			results: [
				{ endpoint_id: "dataforseo.serp.search", name: "SERP search", job: "google search console rankings proxy", provider: "dataforseo" },
				{ endpoint_id: "google-search-console.search-analytics", name: "Search Console query", job: "query impressions and clicks", provider: "google" },
			],
		}
		expect(pickSearchConsoleEndpoint(payload)).toBe("google-search-console.search-analytics")
	})

	it("accepts a webmasters endpoint id", () => {
		expect(pickSearchConsoleEndpoint([{ endpoint_id: "google.webmasters.query", provider: "google" }])).toBe("google.webmasters.query")
	})

	it("returns null when nothing matches", () => {
		expect(pickSearchConsoleEndpoint({ results: [{ endpoint_id: "google-ads.keywords", provider: "google" }] })).toBeNull()
		expect(pickSearchConsoleEndpoint({})).toBeNull()
		expect(pickSearchConsoleEndpoint(null)).toBeNull()
	})
})

describe("buildGscCallArgs", () => {
	const window = { siteUrl: "https://www.arxivolt.com/", startDate: "2026-01-01", endDate: "2026-01-28" }

	it("replaces the template's example property but keeps its other settings", () => {
		const details = {
			endpoint: {
				call_template:
					"GET --query siteUrl=https://example.com/ --query dimensions=query --data '{\"rowLimit\": 5, \"dimensions\": [\"date\"]}'",
			},
		}
		const args = buildGscCallArgs(details, window)
		expect(args.query?.siteUrl).toBe("https://www.arxivolt.com/")
		expect(args.query?.dimensions).toBe("query")
		expect(args.params).toMatchObject({
			startDate: "2026-01-01",
			endDate: "2026-01-28",
			dimensions: ["query", "page"],
			rowLimit: 1_000,
		})
	})

	it("carries the property in params when the template has no site field", () => {
		const args = buildGscCallArgs({ endpoint: { call_template: "POST --data '{\"rowLimit\": 10}'" } }, window)
		expect(args.method).toBe("POST")
		expect(args.query).toBeUndefined()
		expect(args.params.siteUrl).toBe("https://www.arxivolt.com/")
	})

	it("falls back to POST and our defaults with no template at all", () => {
		const args = buildGscCallArgs(null, { ...window, rowLimit: 250 })
		expect(args.method).toBe("POST")
		expect(args.params).toMatchObject({ rowLimit: 250, dimensions: ["query", "page"] })
	})
})
