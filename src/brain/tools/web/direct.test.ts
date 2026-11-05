import { afterEach, describe, expect, it, vi } from "vitest"
import {
	htmlToText,
	normalizeUrl,
	searchDirect,
	unwrapDuckDuckGoLink,
} from "./direct"

describe("normalizeUrl", () => {
	it("decodes the entity-escaped ampersands Slack inserts", () => {
		expect(
			normalizeUrl(
				"https://www.fuzu.com/job/computers-software-development?filters%5Bjob_id%5D=1040322&amp;filters%5Bcountry_id%5D%5B%5D=1",
			),
		).toBe(
			"https://www.fuzu.com/job/computers-software-development?filters%5Bjob_id%5D=1040322&filters%5Bcountry_id%5D%5B%5D=1",
		)
	})

	it("unwraps Slack's <url|label> form", () => {
		expect(
			normalizeUrl(
				"<https://example.com/job?x=1&amp;y=2|https://example.com/job?x=1&amp;y=2>",
			),
		).toBe("https://example.com/job?x=1&y=2")
	})

	it("leaves an ordinary URL alone", () => {
		expect(normalizeUrl("https://job-boards.greenhouse.io/anthropic/jobs/4641822008")).toBe(
			"https://job-boards.greenhouse.io/anthropic/jobs/4641822008",
		)
	})
})

describe("unwrapDuckDuckGoLink", () => {
	it("recovers the destination behind the click wrapper", () => {
		expect(
			unwrapDuckDuckGoLink(
				"//duckduckgo.com/l/?uddg=https%3A%2F%2Fke.linkedin.com%2Fjobs%2Fsenior-software-engineer-jobs&amp;rut=abc",
			),
		).toBe("https://ke.linkedin.com/jobs/senior-software-engineer-jobs")
	})

	it("rejects links that only point back into DuckDuckGo", () => {
		expect(unwrapDuckDuckGoLink("https://duckduckgo.com/y.js?ad=1")).toBeNull()
		expect(unwrapDuckDuckGoLink("//duckduckgo.com/anomaly.js")).toBeNull()
	})
})

describe("htmlToText", () => {
	it("keeps headings and list items as readable structure", () => {
		const { title, text } = htmlToText(`
			<html><head><title>Senior Software Engineer, Inference</title></head>
			<body>
				<h2>About the role</h2>
				<p>Our Inference team serves Claude.</p>
				<ul><li>Distributed systems</li><li>Request routing</li></ul>
			</body></html>
		`)
		expect(title).toBe("Senior Software Engineer, Inference")
		expect(text).toContain("## About the role")
		expect(text).toContain("- Distributed systems")
		expect(text).toContain("- Request routing")
		expect(text).toContain("Our Inference team serves Claude.")
	})

	it("drops scripts, styles and comments instead of leaking them as text", () => {
		const { text } = htmlToText(`
			<div>Requirements</div>
			<script>window.__DATA__ = { secret: 1 }</script>
			<style>.job { color: red }</style>
			<!-- internal note -->
			<noscript>enable js</noscript>
		`)
		expect(text).toContain("Requirements")
		expect(text).not.toContain("__DATA__")
		expect(text).not.toContain("color: red")
		expect(text).not.toContain("internal note")
		expect(text).not.toContain("enable js")
	})

	it("decodes entities and collapses whitespace", () => {
		const { text } = htmlToText(
			"<p>R&amp;D&nbsp;team &#8212; Dublin &quot;hybrid&quot;</p>",
		)
		expect(text).toBe('R&D team — Dublin "hybrid"')
	})
})

const DDG_RESULTS_HTML = `
<html><body>
	<div class="result results_links results_links_deep web-result result--ad">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Sponsored: hire fast</a>
		</h2>
	</div>
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F401&amp;rut=1">Senior <b>Engineer</b>, Payments</a>
		</h2>
		<a class="result__snippet" href="#">Acme is hiring a senior engineer &amp; paying well.</a>
	</div>
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjobs%2Fbackend&amp;rut=2">Backend jobs in Nairobi</a>
		</h2>
	</div>
</body></html>
`

describe("searchDirect", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("returns organic results and skips sponsored ones", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(DDG_RESULTS_HTML, { status: 200 })),
		)
		const hits = await searchDirect({
			query: "senior engineer jobs nairobi",
			limit: 5,
			timeoutMs: 5_000,
		})
		expect(hits).toEqual([
			{
				title: "Senior Engineer, Payments",
				url: "https://boards.greenhouse.io/acme/jobs/401",
				description: "Acme is hiring a senior engineer & paying well.",
			},
			{
				title: "Backend jobs in Nairobi",
				url: "https://example.com/jobs/backend",
				description: "",
			},
		])
	})

	it("respects the result limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(DDG_RESULTS_HTML, { status: 200 })),
		)
		const hits = await searchDirect({ query: "x", limit: 1, timeoutMs: 5_000 })
		expect(hits).toHaveLength(1)
	})

	it("throws instead of reporting an empty web when the page is a block page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("<html><body>unusual traffic</body></html>", {
						status: 200,
					}),
			),
		)
		await expect(
			searchDirect({ query: "x", limit: 5, timeoutMs: 5_000 }),
		).rejects.toThrow(/no parsable results/)
	})

	it("throws on a non-OK response so the caller can name the failing layer", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("blocked", { status: 403 })),
		)
		await expect(
			searchDirect({ query: "x", limit: 5, timeoutMs: 5_000 }),
		).rejects.toThrow(/keyless search failed \(403\)/)
	})
})
