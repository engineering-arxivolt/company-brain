import { describe, expect, it } from "vitest"
import type { ProviderTool } from "../tools/mcp/provider"
import {
	looksLikeProviderError,
	parseAccessibleCustomers,
	parseCallTemplate,
	parseKeywords,
	pickCatalogEndpoints,
	pickKeywordTool,
	pickOwnKeywordTool,
	resolveCustomerId,
	topicPhrases,
	withPhrase,
} from "./treg"

const tool = (name: string): ProviderTool => ({
	name,
	inputSchema: { type: "object" } as ProviderTool["inputSchema"],
})

describe("topicPhrases", () => {
	it("strips the request wrapper, leaving the searchable phrase", () => {
		expect(
			topicPhrases(
				"run a content campaign pack on the biggest story right now about EV charging",
			),
		).toEqual(["EV charging"])
	})

	it("falls back to the raw topic when only filler words remain", () => {
		expect(topicPhrases("run a content campaign pack")).toEqual([
			"run a content campaign pack",
		])
	})
})

describe("parseKeywords", () => {
	it("unwraps an MCP text envelope without harvesting the 'text' discriminator", () => {
		const envelope = {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						tasks: [
							{
								result: [
									{
										items: [
											{
												keyword: "email marketing",
												search_volume: 1200,
												competition_index: 34,
											},
											{
												keyword: "crm software",
												avg_monthly_searches: 800,
												kd: 12,
											},
										],
									},
								],
							},
						],
					}),
				},
			],
		}

		const keywords = parseKeywords(envelope)

		expect(keywords.map((entry) => entry.keyword)).toEqual([
			"email marketing",
			"crm software",
		])
		expect(keywords[0]).toMatchObject({ volume: 1200, difficulty: 34 })
		expect(keywords[1]).toMatchObject({ volume: 800, difficulty: 12 })
		expect(keywords.some((entry) => entry.keyword === "text")).toBe(false)
	})

	it("reads structuredContent results", () => {
		const keywords = parseKeywords({
			structuredContent: {
				keywords: [
					{ keyword: "ev charging", volume: 500 },
					{ query: "ev charging stations", volume: 300 },
				],
			},
		})
		expect(keywords).toEqual([
			{ keyword: "ev charging", volume: 500 },
			{ keyword: "ev charging stations", volume: 300 },
		])
	})

	it("drops status noise, numbers and URLs from bare strings", () => {
		const keywords = parseKeywords([
			"ok",
			"true",
			"12345",
			"https://treg.to/catalog/dataforseo",
			"solar panels",
			"multi\nline prose that is not a keyword",
		])
		expect(keywords.map((entry) => entry.keyword)).toEqual(["solar panels"])
	})

	it("dedupes case-insensitively and caps the list at 12", () => {
		expect(
			parseKeywords([{ keyword: "Repeat" }, { keyword: "repeat" }]),
		).toHaveLength(1)
		const many = Array.from({ length: 20 }, (_, index) => ({
			keyword: `kw ${index}`,
			volume: index,
		}))
		expect(parseKeywords(many)).toHaveLength(12)
	})

	it("returns nothing for a payload with no keywords in it", () => {
		expect(parseKeywords(null)).toEqual([])
		expect(parseKeywords({ count: 0, results: [] })).toEqual([])
	})

	it("reads Google Ads keyword metrics (text + keywordMetrics)", () => {
		const keywords = parseKeywords({
			results: [
				{
					text: "ev charging",
					keywordMetrics: { avgMonthlySearches: 2400, competitionIndex: 41 },
				},
			],
		})
		expect(keywords).toEqual([
			{ keyword: "ev charging", volume: 2400, difficulty: 41 },
		])
	})

	it("averages Google Ads monthly volumes reported as strings", () => {
		const keywords = parseKeywords({
			results: [
				{
					text: "ev charging",
					keywordMetrics: {
						competition: "LOW",
						monthlySearchVolumes: [
							{ month: "OCTOBER", year: "2025", monthlySearches: "110000" },
							{ month: "NOVEMBER", year: "2025", monthlySearches: "90500" },
						],
					},
				},
			],
		})
		expect(keywords).toEqual([{ keyword: "ev charging", volume: 100250 }])
	})

	it("never turns error prose into keywords", () => {
		const failure = {
			call_id: "abc",
			status: 403,
			endpoint_id: "google-ads.google.keywords.volume",
			body: {
				error: {
					code: 403,
					message: "The caller does not have permission",
					status: "PERMISSION_DENIED",
					details: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }],
				},
			},
		}
		expect(parseKeywords(failure)).toEqual([])
	})
})

describe("looksLikeProviderError", () => {
	it("flags treg provider failures carried inside a 200 response", () => {
		expect(
			looksLikeProviderError({
				status: 403,
				body: { error: { code: 403, message: "The caller does not have permission" } },
			}),
		).toBe(true)
		expect(looksLikeProviderError({ error: "rate limited" })).toBe(true)
		expect(looksLikeProviderError({ whose_error: "provider" })).toBe(true)
	})

	it("passes real keyword payloads through", () => {
		expect(
			looksLikeProviderError({
				status: 200,
				body: { results: [{ text: "ev charging", keywordMetrics: {} }] },
			}),
		).toBe(false)
		expect(looksLikeProviderError(null)).toBe(false)
	})
})

describe("pickKeywordTool", () => {
	it("ignores treg's catalog plumbing", () => {
		const metaTools = [
			"catalog_search",
			"catalog_get",
			"catalog_request",
			"call",
			"call_media",
			"my_tools",
			"balance",
			"resources_list",
			"feedback",
			"review",
		].map(tool)

		expect(pickKeywordTool(metaTools)).toBeNull()
		expect(
			pickKeywordTool([...metaTools, tool("keyword_ideas")])?.name,
		).toBe("keyword_ideas")
	})
})

describe("pickOwnKeywordTool", () => {
	it("finds a keyword-capable tool among the team's own", () => {
		expect(
			pickOwnKeywordTool({
				team: "awesome-2",
				tools: [
					{ name: "facebook", base_url: "https://graph.facebook.com/v25.0" },
					{ name: "google-ads", base_url: "https://googleads.googleapis.com" },
				],
			}),
		).toBe("google-ads")
	})

	it("returns null when nothing on the team answers keyword questions", () => {
		expect(
			pickOwnKeywordTool({
				tools: [
					{ name: "facebook", base_url: "https://graph.facebook.com/v25.0" },
					{ name: "tiktok", base_url: "https://open.tiktokapis.com" },
				],
			}),
		).toBeNull()
		expect(pickOwnKeywordTool(null)).toBeNull()
	})
})

const CATALOG = {
	query: "keyword search volume",
	count: 3,
	total_matches: 3,
	results: [
		{
			endpoint_id: "moltsets.linkedin.profile.from-email",
			name: "Find professional profile from email",
			provider: "moltsets",
			job: "linkedin.profile.from_email",
			usd_per_call: 0.0005,
			no_key_needed: true,
		},
		{
			endpoint_id: "dataforseo.keywords.live",
			name: "Keyword search volume",
			provider: "dataforseo",
			job: "keywords.search_volume",
			usd_per_call: 0.01,
			no_key_needed: true,
		},
		{
			endpoint_id: "serpapi.keywords.suggestions",
			name: "Keyword suggestions",
			provider: "serpapi",
			job: "keywords.suggestions",
			usd_per_call: 0.002,
			no_key_needed: true,
		},
	],
}

describe("pickCatalogEndpoints", () => {
	it("prefers the team's own provider, never a people-search endpoint", () => {
		const endpoints = pickCatalogEndpoints(CATALOG, 1, ["dataforseo"])
		expect(endpoints.map((entry) => entry.endpointId)).toEqual([
			"dataforseo.keywords.live",
			"serpapi.keywords.suggestions",
		])
	})

	it("orders cheapest first when the team has no matching provider", () => {
		expect(
			pickCatalogEndpoints(CATALOG, 1, ["facebook"]).map(
				(entry) => entry.endpointId,
			),
		).toEqual(["serpapi.keywords.suggestions", "dataforseo.keywords.live"])
	})

	it("refuses paid endpoints the balance cannot cover", () => {
		// $0.000406 covers none of the priced keyword endpoints.
		expect(pickCatalogEndpoints(CATALOG, 0.000406)).toEqual([])
	})

	it("still uses a free endpoint with an empty balance", () => {
		expect(
			pickCatalogEndpoints(
				{
					results: [
						{
							endpoint_id: "free.keywords.volume",
							name: "Keyword volume",
							provider: "free",
							job: "keywords.volume",
							usd_per_call: 0,
							no_key_needed: true,
						},
					],
				},
				0,
			)[0]?.endpointId,
		).toBe("free.keywords.volume")
	})

	it("skips endpoints with no published price (cannot be budget-guarded)", () => {
		expect(
			pickCatalogEndpoints(
				{
					results: [
						{
							endpoint_id: "unknown.price",
							name: "Keyword volume",
							provider: "unknown",
							job: "keywords.volume",
							no_key_needed: false,
						},
					],
				},
				10,
			),
		).toEqual([])
	})
})

describe("Google Ads customer resolution", () => {
	it("reads accessible customer ids from resourceNames", () => {
		expect(
			parseAccessibleCustomers({
				resourceNames: ["customers/3194695868", "customers/1234"],
			}),
		).toEqual(["3194695868", "1234"])
		expect(parseAccessibleCustomers(null)).toEqual([])
		expect(
			parseAccessibleCustomers({ resourceNames: ["not-a-customer"] }),
		).toEqual([])
	})

	it("keeps the template id when the team can reach it", () => {
		expect(resolveCustomerId("3194695868", ["3194695868"])).toBe("3194695868")
	})

	it("replaces an unreachable template id with an accessible account", () => {
		// treg's template hardcodes 2277522568; the team only owns 3194695868.
		expect(resolveCustomerId("2277522568", ["3194695868"])).toBe("3194695868")
	})

	it("falls back to the template id when nothing is accessible", () => {
		expect(resolveCustomerId("2277522568", [])).toBe("2277522568")
		expect(resolveCustomerId(undefined, [])).toBeUndefined()
	})
})

describe("parseCallTemplate", () => {
	const details = {
		endpoint: {
			call_template:
				"treg call google-ads.google.keywords.volume --method POST --query customer_id=2277522568 --data '{\"keywords\":[\"coffee beans\"],\"language\":\"languageConstants/1000\"}'",
		},
	}

	it("reads the query parameters and example body from the template", () => {
		const parsed = parseCallTemplate(details)
		expect(parsed?.method).toBe("POST")
		expect(parsed?.query).toEqual({ customer_id: "2277522568" })
		expect(parsed?.body).toEqual({
			keywords: ["coffee beans"],
			language: "languageConstants/1000",
		})
	})

	it("returns null when the endpoint has no template", () => {
		expect(parseCallTemplate({ endpoint: {} })).toBeNull()
		expect(parseCallTemplate(null)).toBeNull()
	})
})

describe("withPhrase", () => {
	it("keeps provider defaults and swaps in the real phrase", () => {
		expect(
			withPhrase(
				{
					keywords: ["coffee beans"],
					geoTargetConstants: ["geoTargetConstants/2840"],
					keywordPlanNetwork: "GOOGLE_SEARCH",
				},
				"EV charging",
			),
		).toEqual({
			keywords: ["EV charging"],
			geoTargetConstants: ["geoTargetConstants/2840"],
			keywordPlanNetwork: "GOOGLE_SEARCH",
		})
	})

	it("handles string keywords and one-element array bodies", () => {
		expect(withPhrase({ keywords: "coffee beans" }, "EV charging")).toEqual({
			keywords: ["EV charging"],
		})
		expect(withPhrase([{ keyword: "coffee beans" }], "EV charging")).toEqual([
			{ keyword: "EV charging" },
		])
	})

	it("adds a keywords list when the body has none", () => {
		expect(withPhrase({ country: "us" }, "EV charging")).toEqual({
			country: "us",
			keywords: ["EV charging"],
		})
		expect(withPhrase(null, "EV charging")).toEqual({ keywords: ["EV charging"] })
	})
})

