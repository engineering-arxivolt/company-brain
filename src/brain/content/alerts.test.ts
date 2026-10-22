import { describe, expect, it } from "vitest"
import {
	matchesKeywords,
	parseCisaKev,
	parseGcpIncidents,
	parseGitHubAdvisories,
	parseRss,
	type AlertSource,
} from "./alerts"

const rssSource: AlertSource = {
	name: "ODPC",
	url: "https://www.odpc.go.ke/feed",
	kind: "rss",
	tier: "regulator",
}

const keywordSource: AlertSource = {
	name: "TechCabal",
	url: "https://www.techcabal.com/feed/",
	kind: "rss",
	tier: "story",
}

describe("alert feeds", () => {
	it("reads an RSS feed", () => {
		const xml = `<rss><channel>
			<item>
				<title>ODPC issues guidance on breach notification</title>
				<link>https://www.odpc.go.ke/guidance</link>
				<pubDate>Tue, 21 Oct 2026 09:00:00 GMT</pubDate>
				<description>The 72-hour clock now starts at awareness.</description>
			</item>
			<item><title>Something else</title><link>https://example.com/x</link></item>
		</channel></rss>`
		const items = parseRss(xml, rssSource)
		expect(items).toHaveLength(2)
		expect(items[0]?.title).toContain("breach notification")
		expect(items[0]?.url).toBe("https://www.odpc.go.ke/guidance")
		expect(items[0]?.summary).toContain("72-hour clock")
		expect(items[0]?.publishedAt).toBeTruthy()
	})

	it("reads the CISA known-exploited catalogue", () => {
		const items = parseCisaKev(
			{
				vulnerabilities: [
					{
						cveID: "CVE-2026-1234",
						vulnerabilityName: "Example RCE",
						product: "AcmeServer",
						dateAdded: "2026-10-21",
						knownRansomwareCampaignUse: "Known",
					},
				],
			},
			{ name: "CISA known exploited", url: "x", kind: "cisa-kev", tier: "security" },
		)
		expect(items).toHaveLength(1)
		expect(items[0]?.title).toContain("CVE-2026-1234")
		expect(items[0]?.funnel).toBe("BOF")
		expect(items[0]?.summary).toContain("ransomware")
	})

	it("reads GitHub advisories", () => {
		const items = parseGitHubAdvisories(
			[
				{
					ghsa_id: "GHSA-xxxx",
					summary: "Critical flaw in the example package",
					severity: "critical",
					html_url: "https://github.com/advisories/GHSA-xxxx",
					published_at: "2026-10-21T10:00:00Z",
				},
			],
			{ name: "GitHub advisories", url: "x", kind: "github-advisories", tier: "security" },
		)
		expect(items[0]?.title).toContain("Critical flaw")
		expect(items[0]?.url).toBe("https://github.com/advisories/GHSA-xxxx")
		expect(items[0]?.summary).toContain("critical")
	})

	it("reads Google Cloud incidents", () => {
		const items = parseGcpIncidents(
			{
				incidents: [
					{
						id: "abc",
						external_desc: "Elevated error rates in us-central1",
						severity: "major",
						begin: "2026-10-22T10:00:00Z",
					},
				],
			},
			{ name: "Google Cloud incidents", url: "x", kind: "gcp-incidents", tier: "status" },
		)
		expect(items[0]?.title).toContain("Elevated error rates")
		expect(items[0]?.funnel).toBe("TOF")
	})

	it("matches only the things that touch our market", () => {
		expect(matchesKeywords("ODPC publishes new guidance")).toBe(true)
		expect(matchesKeywords("Cloudflare outage in Frankfurt")).toBe(true)
		expect(matchesKeywords("Kenyan startup raises a seed round")).toBe(
			true,
		)
		expect(matchesKeywords("A general football match result")).toBe(false)
	})
})
